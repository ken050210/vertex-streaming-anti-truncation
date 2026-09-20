import test from "node:test";
import assert from "node:assert/strict";
import { antiTruncationLogFields, prepareAntiTruncation, restoreAntiTruncationCompletion, wrapAntiTruncationStream } from "../src/anti-truncation.mjs";

const name = "router_emit_test";
const payload = { model: "抗截断-gemini-3.7-flash", messages: [{ role: "user", content: "Hello" }], temperature: 0.7, reasoning: { effort: "low" }, custom: { untouched: true } };
const call = (args, toolName = name, index = 0) => ({ index, id: "call-test", type: "function", function: { name: toolName, arguments: args } });
const chunk = (delta, finish_reason = null) => ({ id: "completion-test", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] });
const event = value => "data: " + (typeof value === "string" ? value : JSON.stringify(value)) + "\n\n";
const contents = records => records.map(r => r.choices?.[0]?.delta?.content ?? "").join("");
const parse = text => text.split(/\r?\n/).filter(line => line.startsWith("data:") && !line.includes("[DONE]"))
  .map(line => JSON.parse(line.slice(5)));

test("audit metadata projects only bounded enums and booleans, never provider text", () => {
  assert.deepEqual(antiTruncationLogFields(null), {});
  assert.deepEqual(antiTruncationLogFields({ transport: "private-text", restored: "true", finishReason: "private-text", streamDone: 1, content: "private-text" }),
    { antiTruncation: { transport: "unknown", restored: null, finishReason: "other", streamDone: null } });
});

async function streamed(records, width = 1) {
  const bytes = new TextEncoder().encode(records.join(""));
  let offset = 0;
  const body = new ReadableStream({ pull(controller) {
    if (offset === bytes.length) return controller.close();
    controller.enqueue(bytes.slice(offset, offset += width));
    offset = Math.min(offset, bytes.length);
  } });
  return wrapAntiTruncationStream(new Response(body), name).text();
}

test("opt-in preparation preserves parameters and isolates the original request", () => {
  const original = structuredClone(payload);
  const prepared = prepareAntiTruncation(payload, true);
  assert.deepEqual(payload, original);
  assert.equal(prepared.payload.messages.length, payload.messages.length + 1);
  assert.equal(prepared.payload.messages.at(-1).role, "user");
  assert.equal(prepared.payload.custom, payload.custom);
  assert.equal(prepared.payload.reasoning, payload.reasoning);
  assert.equal(prepared.payload.temperature, payload.temperature);
  assert.match(prepared.toolName, /^router_emit_[a-f0-9]{24}$/);
  assert.equal(prepared.payload.tools.length, 1);
  assert.equal(prepared.payload.tool_choice.function.name, prepared.toolName);
  assert.notEqual(prepareAntiTruncation(payload, true).toolName, prepared.toolName);
  assert.equal(prepareAntiTruncation(payload, false).payload, payload);
});

test("client tools, Tavern transport, explicit selection, JSON and candidate conflicts bypass by identity", () => {
  for (const extra of [
    { tools: [{ type: "function", function: { name: "tavern_emit" } }] },
    { functions: [{ name: "legacy" }] }, { tool_choice: "auto" }, { tool_choice: "none" },
    { function_call: "auto" }, { response_format: { type: "json_object" } },
    { response_format: { type: "json_schema", json_schema: { name: "database" } } },
    { n: 2 }, { best_of: 2 },
    { messages: [{ role: "assistant", tool_calls: [call("{}")] }] },
    { messages: [{ role: "tool", content: "result" }] },
  ]) {
    const request = { ...payload, ...extra };
    const result = prepareAntiTruncation(request, true);
    assert.equal(result.payload, request);
    assert.equal(result.toolName, null);
  }
  assert.ok(prepareAntiTruncation({ ...payload, tools: [], n: 1, response_format: { type: "text" } }, true).toolName);
});

test("experimental streaming selects native only for translatable text requests and preserves fallback fields", () => {
  const request = { model: payload.model, messages: payload.messages, stream: true,
    extra_body: { google: { thinking_config: { thinking_budget: 128 } } } };
  const before = structuredClone(request);
  const prepared = prepareAntiTruncation(request, true, true);
  assert.equal(prepared.reason, "tool-transport-native-streaming");
  assert.equal(prepared.nativeStreaming, true);
  assert.equal(prepared.payload.extra_body, request.extra_body);
  assert.deepEqual(request, before);
  assert.equal(prepareAntiTruncation(request, true).payload.extra_body, request.extra_body);
  assert.equal(prepareAntiTruncation({ ...request, stream: false }, true, true).payload.extra_body, request.extra_body);
  assert.equal(prepareAntiTruncation(request, true).nativeStreaming, false);
  assert.equal(prepareAntiTruncation({ ...request, stream: false }, true, true).nativeStreaming, false);
  for (const extra of [{ tools: [{ type: "function", function: { name: "client_tool" } }] },
    { response_format: { type: "json_object" } }]) {
    const bypass = { ...request, ...extra };
    assert.equal(prepareAntiTruncation(bypass, true, true).payload, bypass);
  }
  for (const extra of [{ custom: { preserved: true } }, { extra_body: [] }, { extra_body: { google: "invalid" } },
    { messages: [{ role: "user", name: "Name", content: "test" }] }]) {
    const fallback = { ...request, ...extra };
    const result = prepareAntiTruncation(fallback, true, true);
    assert.equal(result.nativeStreaming, false);
    assert.equal(result.reason, "tool-transport-buffered-fields");
    for (const key of Object.keys(extra).filter(k => k !== "messages")) assert.equal(result.payload[key], fallback[key]);
  }
});

test("nonstream unwrap retains real tools, usage, reasoning and honest finish reasons", () => {
  const completion = { model: "google/gemini-3.7-flash", usage: { prompt_tokens: 3, completion_tokens: 8 }, choices: [{
    message: { role: "assistant", content: "duplicate", reasoning_content: "meta", tool_calls: [call(JSON.stringify({ content: "正文😀\n第二行" }))] }, finish_reason: "tool_calls",
  }] };
  const restored = restoreAntiTruncationCompletion(completion, name);
  assert.equal(restored.choices[0].message.content, "正文😀\n第二行");
  assert.equal(restored.choices[0].message.tool_calls, undefined);
  assert.equal(restored.choices[0].message.reasoning_content, "meta");
  assert.equal(restored.choices[0].finish_reason, "stop");
  assert.equal(restored.usage, completion.usage);
  assert.equal(restored.router_anti_truncation.restored, true);
  const real = call("{}", "actual_tool", 1);
  completion.choices[0].message.tool_calls.push(real);
  const mixed = restoreAntiTruncationCompletion(completion, name);
  assert.deepEqual(mixed.choices[0].message.tool_calls, [real]);
  assert.equal(mixed.choices[0].finish_reason, "tool_calls");
  for (const reason of ["length", "content_filter"]) {
    completion.choices[0].finish_reason = reason;
    completion.choices[0].message.tool_calls = [call('{"content":"partial')];
    const partial = restoreAntiTruncationCompletion(completion, name);
    assert.equal(partial.choices[0].message.content, "partial");
    assert.equal(partial.choices[0].finish_reason, reason);
  }
  completion.choices[0].finish_reason = "tool_calls";
  assert.throws(() => restoreAntiTruncationCompletion(completion, name), /incomplete_arguments/);
});

test("SSE decodes split names, JSON escapes, unicode and byte boundaries without leaking synthetic calls", async () => {
  const expected = '正文😀\n"引号"\\路径\t/';
  const args = '{"ignored":{"list":[true,false,null,-1.25e+2]},"content":"正文\\ud83d\\ude00\\n\\"引号\\"\\\\路径\\t\\/"}';
  const records = [": heartbeat\n\n", event(chunk({ role: "assistant", reasoning_content: "thinking metadata" })),
    event(chunk({ tool_calls: [call("", "router_")] })), event(chunk({ tool_calls: [call("", "emit_test")] }))];
  for (const char of args) records.push(event(chunk({ tool_calls: [{ index: 0, function: { arguments: char } }] })));
  records.push(event(chunk({}, "tool_calls")), event({ choices: [], usage: { completion_tokens: 21 } }), event("[DONE]"));
  const text = await streamed(records);
  const parsed = parse(text);
  assert.equal(contents(parsed), expected);
  assert.ok(text.includes(": heartbeat"));
  assert.equal(parsed[0].choices[0].delta.reasoning_content, "thinking metadata");
  assert.equal(parsed.some(r => r.choices?.[0]?.delta?.tool_calls), false);
  assert.ok(parsed.some(r => r.choices?.[0]?.finish_reason === "stop"));
  assert.ok(parsed.some(r => r.usage?.completion_tokens === 21));
  assert.equal(parsed.at(-1).router_anti_truncation.restored, true);
  assert.ok(text.endsWith("data: [DONE]\n\n"));
});

test("ordinary SSE fallback is immediate, and only one text channel is used", async () => {
  for (const toolFirst of [true, false]) {
    const synthetic = event(chunk({ tool_calls: [call('{"content":"synthetic"}')] }));
    const plain = event(chunk({ content: "ordinary" }));
    const out = parse(await streamed([...(toolFirst ? [synthetic, plain] : [plain, synthetic]), event(chunk({}, "tool_calls")), event("[DONE]")]));
    assert.equal(contents(out), toolFirst ? "synthetic" : "ordinary");
  }
  const out = parse(await streamed([event(chunk({ content: "fallback" })), event(chunk({}, "stop")), event("[DONE]")]));
  assert.equal(contents(out), "fallback");
  assert.equal(out.at(-1).router_anti_truncation.restored, false);
});

test("SSE preserves unowned tool deltas and tool finish semantics", async () => {
  const synthetic = event(chunk({ tool_calls: [call('{"content":"text"}')] }));
  const real = call("{}", "real_tool", 1);
  const out = parse(await streamed([synthetic, event(chunk({ tool_calls: [real] })), event(chunk({}, "tool_calls")), event("[DONE]")]));
  assert.deepEqual(out.find(r => r.choices?.[0]?.delta?.tool_calls).choices[0].delta.tool_calls, [real]);
  assert.equal(out.find(r => r.choices?.[0]?.finish_reason).choices[0].finish_reason, "tool_calls");
});

test("SSE cannot turn malformed, interrupted or incomplete output into a successful stop", async () => {
  for (const args of ['{"content":"open', '{"content":123}', '{"content":"a","content":"b"}', '{"content":"bad\\x"}']) {
    await assert.rejects(streamed([event(chunk({ tool_calls: [call(args)] })), event(chunk({}, "tool_calls")), event("[DONE]")]), /anti_truncation_/);
  }
  await assert.rejects(streamed([event(chunk({ tool_calls: [call('{"content":"ok"}')] }))]), /stream_interrupted/);
  await assert.rejects(streamed(["data: invalid\n\n"]), /invalid_sse_json/);
  for (const reason of ["length", "content_filter"]) {
    const out = parse(await streamed([event(chunk({ tool_calls: [call('{"content":"partial')] })), event(chunk({}, reason)), event("[DONE]")]));
    assert.equal(contents(out), "partial");
    assert.ok(out.some(r => r.choices?.[0]?.finish_reason === reason));
  }
  const error = { error: { code: "upstream_error", message: "provider failed" } };
  const out = parse(await streamed([event(error)]));
  assert.deepEqual(out, [error]);
});

test("large completed arguments stream, while unknown metadata and deeply nested arguments stay bounded", async () => {
  const value = "文".repeat(80_000);
  const output = parse(await streamed([event(chunk({ tool_calls: [call(JSON.stringify({ content: value }))] })), event(chunk({}, "tool_calls")), event("[DONE]")], 4096));
  assert.equal(contents(output), value);
  await assert.rejects(streamed([event(chunk({ tool_calls: [call("x".repeat(70_000), "router_")] }))], 4096), /tool_metadata_limit/);
  const nested = '{"ignored":' + '['.repeat(70) + '0' + ']'.repeat(70) + ',"content":"ok"}';
  await assert.rejects(streamed([event(chunk({ tool_calls: [call(nested)] }))], 4096), /invalid_arguments/);
});

test("SSE cancellation cancels the upstream reader and delivers text before completion", async () => {
  let source, cancelled = false;
  const body = new ReadableStream({ start(controller) { source = controller; }, cancel() { cancelled = true; } });
  const reader = wrapAntiTruncationStream(new Response(body), name).body.getReader();
  source.enqueue(new TextEncoder().encode(event(chunk({ tool_calls: [call('{"content":"first')] }))));
  const first = await reader.read();
  assert.equal(contents(parse(new TextDecoder().decode(first.value))), "first");
  await reader.cancel("client stopped");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
});
