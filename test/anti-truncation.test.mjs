import test from "node:test";
import assert from "node:assert/strict";
import { presetTextTool } from "./fixtures/preset-text-tool.mjs";
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
  assert.equal(prepared.toolName, "router_emit");
  assert.equal(prepared.payload.tools.length, 1);
  assert.equal(prepared.payload.tool_choice.function.name, prepared.toolName);
  // Repeated, streamed and Continue requests declare identical tools, keeping Vertex's implicit-cache prefix.
  for (const again of [prepareAntiTruncation(payload, true), prepareAntiTruncation({ ...payload, stream: true }, true, true, { continuation: true })]) {
    assert.deepEqual([again.payload.tools, again.payload.tool_choice], [prepared.payload.tools, prepared.payload.tool_choice]);
  }
  assert.equal(prepareAntiTruncation(payload, false).payload, payload);
});

test("a preset transport keeps its declaration and disambiguates a streamed name prefix", async () => {
  const fixed = { transportToolName: "emit" };
  const target = { ...presetTextTool, function: { ...presetTextTool.function, name: "emit" } };
  const tools = [target, { type: "function", function: { name: "emit_image" } }];
  const prepared = prepareAntiTruncation({ ...payload, tools }, true, false, fixed);
  assert.equal(prepared.payload.tools, tools);
  assert.equal(prepared.payload.tool_choice, "required");
  assert.match(prepared.payload.messages.at(-1).content, /one call of emit;/);
  const named = { type: "function", function: { name: "emit" } };
  for (const request of [{ tools: [target] }, { tools, tool_choice: named }, { tools: [target], tool_choice: "required" }]) {
    const selected = prepareAntiTruncation({ ...payload, ...request }, true, false, fixed);
    assert.deepEqual(selected.payload.tool_choice, named);
    assert.equal(selected.payload.tools, request.tools);
  }
  const pieces = [call("", "emit"), { index: 0, function: { arguments: '{"content":"text"}' } },
    call("", "emit", 1), { index: 1, function: { name: "_image", arguments: "{}" } }];
  const wire = [...pieces.map(piece => event(chunk({ tool_calls: [piece] }))), event(chunk({}, "tool_calls")), event("[DONE]")].join("");
  const restored = parse(await wrapAntiTruncationStream(new Response(wire), "emit", undefined, prepared.payload.tools).text());
  assert.equal(contents(restored), "text");
  const real = restored.flatMap(record => record.choices[0].delta.tool_calls ?? []);
  assert.deepEqual(real.map(delta => delta.function.name), ["emit", "_image"]);
  assert.deepEqual(real.map(delta => delta.index), [0, 0]);
  const cutoff = event(chunk({ tool_calls: [call("", "emit")] })) + event(chunk({}, "length")) + event("[DONE]");
  const ended = parse(await wrapAntiTruncationStream(new Response(cutoff), "emit", undefined, prepared.payload.tools).text());
  assert.equal(ended.at(-1).choices[0].finish_reason, "length");
  assert.ok(ended.every(record => !record.choices[0].delta.tool_calls));
  for (const invalid of ["9bad", "two words", "a".repeat(65), null]) {
    assert.throws(() => prepareAntiTruncation(payload, true, false, { transportToolName: invalid }), { code: "invalid_transport_tool_name" });
  }
});

test("a missing, incompatible or disabled preset target leaves the client's request intact", () => {
  const incompatible = { ...presetTextTool, function: { ...presetTextTool.function,
    parameters: { ...presetTextTool.function.parameters, properties: { content: { type: "string" }, action: { type: "string" } } } } };
  for (const [patch, reason] of [
    [{}, "target-tool-missing"],
    [{ tools: [incompatible] }, "target-tool-schema"],
    [{ tools: [presetTextTool, presetTextTool] }, "target-tool-schema"],
    [{ tools: [presetTextTool], tool_choice: "none" }, "target-tool-choice"],
    [{ tools: [presetTextTool], tool_choice: { type: "function", function: { name: "lookup" } } }, "target-tool-choice"],
    [{ tools: [presetTextTool], response_format: { type: "json_object" } }, "structured-output"],
  ]) {
    const request = { ...payload, ...patch };
    const result = prepareAntiTruncation(request, true, true, { transportToolName: "game_content" });
    assert.equal(result.payload, request);
    assert.equal(result.toolName, null);
    assert.equal(result.reason, reason);
  }
});

test("forced tool selection, Tavern transport, legacy functions, JSON and candidate conflicts bypass by identity", () => {
  const tavern = [{ type: "function", function: { name: "tavern_emit" } }];
  for (const extra of [
    { tools: tavern, tool_choice: { type: "function", function: { name: "tavern_emit" } } },
    { tools: tavern, tool_choice: "required" },
    { functions: [{ name: "legacy" }] }, { function_call: "auto" },
    { response_format: { type: "json_object" } },
    { response_format: { type: "json_schema", json_schema: { name: "database" } } },
    { n: 2 }, { best_of: 2 },
    { messages: [{ role: "assistant", function_call: { name: "legacy", arguments: "{}" } }] },
    { messages: [{ role: "function", name: "legacy", content: "result" }] },
  ]) {
    const request = { ...payload, ...extra };
    const result = prepareAntiTruncation(request, true);
    assert.equal(result.payload, request);
    assert.equal(result.toolName, null);
  }
  assert.ok(prepareAntiTruncation({ ...payload, tools: [], n: 1, response_format: { type: "text" } }, true).toolName);
});

test("client tools stay callable beside the synthetic tool, and tool history is wrapped", () => {
  const tools = [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: {} } } }];
  const history = [{ role: "user", content: "Weather?" },
    { role: "assistant", content: "Checking.", tool_calls: [call("{}", "get_weather")] },
    { role: "tool", tool_call_id: "call-test", content: "sunny" }];
  for (const tool_choice of [undefined, "auto"]) {
    const request = { ...payload, messages: history, tools, tool_choice, parallel_tool_calls: true };
    const before = structuredClone(request);
    const prepared = prepareAntiTruncation(request, true);
    assert.deepEqual(request, before);
    assert.equal(prepared.reason, "tool-transport");
    assert.deepEqual(prepared.payload.tools.slice(0, 1), tools);
    assert.equal(prepared.payload.tools[1].function.name, prepared.toolName);
    assert.equal(prepared.payload.tool_choice, "required");
    assert.equal(prepared.payload.parallel_tool_calls, true);
    assert.deepEqual(prepared.payload.messages.slice(0, -1), history);
    assert.match(prepared.payload.messages.at(-1).content, /Call the other tools whenever the task needs them/);
  }
  assert.equal(Object.hasOwn(prepareAntiTruncation({ ...payload, tools }, true).payload, "parallel_tool_calls"), false);
  // Continue keeps its suffix-only wording with callable tools.
  const continued = prepareAntiTruncation({ ...payload, tools }, true, false, { continuation: true }).payload.messages.at(-1).content;
  assert.match(continued, /holds only the new continuation text/);
  assert.match(continued, /Call the other tools/);
  assert.match(continued, /exact end/);
  // "none" keeps the client tools declared but forces the text transport.
  for (const request of [{ ...payload, tools, tool_choice: "none", parallel_tool_calls: true }, { ...payload, messages: history }, { ...payload, tool_choice: "auto" }]) {
    const prepared = prepareAntiTruncation(request, true);
    assert.equal(prepared.payload.tool_choice.function.name, prepared.toolName);
    assert.equal(prepared.payload.parallel_tool_calls, false);
    assert.equal(prepared.payload.tools.length, (request.tools?.length ?? 0) + 1);
    assert.match(prepared.payload.messages.at(-1).content, /exactly once/);
  }
});

test("a client tool named like the synthetic tool keeps its calls, buffered and streamed", async () => {
  for (const clientName of ["router_emit", "router_emit_v2"]) {
    const tools = [{ type: "function", function: { name: clientName } }];
    const prepared = prepareAntiTruncation({ ...payload, tools }, true);
    assert.match(prepared.toolName, /^router_[a-f0-9]{24}$/);
    assert.deepEqual(prepared.payload.tools.map(tool => tool.function.name), [clientName, prepared.toolName]);
    const real = { ...call("{}", clientName, 1), id: "call-real" };
    const completion = restoreAntiTruncationCompletion({ choices: [{ finish_reason: "tool_calls",
      message: { role: "assistant", content: null, tool_calls: [call(JSON.stringify({ content: "text" }), prepared.toolName), real] } }] }, prepared.toolName);
    assert.equal(completion.choices[0].message.content, "text");
    assert.deepEqual(completion.choices[0].message.tool_calls, [real]);
    // The client name arrives in pieces, the first of which spells router_emit.
    const pieces = [{ index: 0, id: "call-real", type: "function", function: { name: "router_emit", arguments: "" } },
      ...(clientName === "router_emit" ? [] : [{ index: 0, function: { name: clientName.slice(11) } }]), { index: 0, function: { arguments: "{}" } }];
    const body = [...pieces.map(piece => event(chunk({ tool_calls: [piece] }))), event(chunk({}, "tool_calls")), event("[DONE]")].join("");
    const records = parse(await wrapAntiTruncationStream(new Response(body), prepared.toolName).text());
    assert.deepEqual(records.flatMap(record => record.choices[0].delta.tool_calls ?? []), pieces);
    assert.equal(records.at(-1).choices[0].finish_reason, "tool_calls");
  }
});

test("a client tool whose name begins the synthetic name streams through once its arguments start", async () => {
  const tools = [{ type: "function", function: { name: "router" } }];
  const prepared = prepareAntiTruncation({ ...payload, tools }, true);
  assert.equal(prepared.toolName, "router_emit");
  // The synthetic name still arrives in pieces, the first of which spells the client name.
  const text = [{ index: 0, id: "call-text", type: "function", function: { name: "router", arguments: "" } },
    { index: 0, function: { name: "_emit" } }, { index: 0, function: { arguments: JSON.stringify({ content: "text" }) } }];
  // Vertex sends a real call whole; OpenAI-style upstreams send the name before the arguments.
  for (const real of [[{ ...call("{}", "router", 1), id: "call-real" }],
    [{ index: 1, id: "call-real", type: "function", function: { name: "router", arguments: "" } }, { index: 1, function: { arguments: "{}" } }]]) {
    const body = [...[...text, ...real].map(piece => event(chunk({ tool_calls: [piece] }))), event(chunk({}, "tool_calls")), event("[DONE]")].join("");
    const records = parse(await wrapAntiTruncationStream(new Response(body), prepared.toolName, () => {}, prepared.payload.tools).text());
    assert.equal(contents(records), "text");
    assert.deepEqual(records.flatMap(record => record.choices[0].delta.tool_calls ?? []), real.map(piece => ({ ...piece, index: 0 })));
    assert.equal(records.at(-1).choices[0].finish_reason, "tool_calls");
  }
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
  const bypass = { ...request, response_format: { type: "json_object" } };
  assert.equal(prepareAntiTruncation(bypass, true, true).payload, bypass);
  // Native conversion still falls back for fields it cannot preserve.
  for (const extra of [{ custom: { preserved: true } }, { extra_body: [] }, { extra_body: { google: "invalid" } },
    { messages: [{ role: "user", name: "Name", content: "test" }] }, { parallel_tool_calls: false }]) {
    const fallback = { ...request, ...extra };
    const result = prepareAntiTruncation(fallback, true, true);
    assert.equal(result.nativeStreaming, false);
    assert.equal(result.reason, "tool-transport-buffered-fields");
    for (const key of Object.keys(extra).filter(k => !["messages", "tools", "tool_choice"].includes(k))) assert.equal(result.payload[key], fallback[key]);
  }
  for (const extra of [{ tools: [{ type: "function", function: { name: "client_tool" } }] },
    { tools: [{ type: "function", function: { name: "client_tool" } }], tool_choice: "none" },
    { messages: [{ role: "assistant", tool_calls: [{ id: "call-test", type: "function", function: { name: "client_tool", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-test", content: "done" }] }]) {
    assert.equal(prepareAntiTruncation({ ...request, ...extra }, true, true).nativeStreaming, true);
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
  assert.equal(parsed.findLast(r => r.router_anti_truncation).router_anti_truncation.restored, true);
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
  assert.equal(out.findLast(r => r.router_anti_truncation).router_anti_truncation.restored, false);
});

test("SSE preserves unowned tool deltas, renumbered without the synthetic call, and tool finish semantics", async () => {
  const synthetic = event(chunk({ tool_calls: [call('{"content":"text"}')] }));
  const real = call("{}", "real_tool", 1);
  const second = call('{"city":"Par', "real_tool", 2);
  const rest = { index: 2, function: { arguments: 'is"}' } };
  const out = parse(await streamed([synthetic, event(chunk({ tool_calls: [real] })), event(chunk({ tool_calls: [second] })),
    event(chunk({ tool_calls: [rest] })), event(chunk({}, "tool_calls")), event("[DONE]")]));
  assert.equal(contents(out), "text");
  assert.deepEqual(out.filter(r => r.choices?.[0]?.delta?.tool_calls).map(r => r.choices[0].delta.tool_calls),
    [[{ ...real, index: 0 }], [{ ...second, index: 1 }], [{ ...rest, index: 1 }]]);
  assert.equal(out.find(r => r.choices?.[0]?.finish_reason).choices[0].finish_reason, "tool_calls");
  // A real call ahead of the synthetic one keeps index 0.
  const first = parse(await streamed([event(chunk({ tool_calls: [call("{}", "real_tool", 0)] })),
    event(chunk({ tool_calls: [call('{"content":"after"}', name, 1)] })), event(chunk({}, "tool_calls")), event("[DONE]")]));
  assert.deepEqual(first.filter(r => r.choices?.[0]?.delta?.tool_calls).map(r => r.choices[0].delta.tool_calls), [[call("{}", "real_tool", 0)]]);
  assert.equal(contents(first), "after");
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
