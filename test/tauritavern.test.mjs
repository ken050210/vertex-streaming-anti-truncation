import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { prepareTauriTavernRequest, restoreTauriTavernResponse } from "../src/tauritavern.mjs";
import { createFetchInterceptor, GENERATE_PATH } from "../integrations/sillytavern/shared.js";
import { CONTINUATION_INSTRUCTION } from "../src/anti-truncation.mjs";
import { sseData } from "../src/wire.mjs";

// What ST sends under TauriTavern: its own Vertex request plus the user's
// Additional Parameters as text (empty by default).
const body = { chat_completion_source: "vertexai", model: "gemini-3.7-flash", stream: true, vertexai_auth_mode: "express",
  vertexai_region: "global", messages: [{ role: "system", content: "规则" }, { role: "user", content: "你好" }], use_sysprompt: true,
  max_tokens: 128, reasoning_effort: "low", include_reasoning: true, stop: ["END"], custom_include_body: "", custom_exclude_body: "" };
const direct = { prepare: prepareTauriTavernRequest, restore: restoreTauriTavernResponse };
// Google's events as TauriTavern's streaming route forwards them, ended by its own [DONE].
const google = (candidate, extra = {}) => sseData({ candidates: [candidate], modelVersion: "gemini-3.7-flash", responseId: "fixture", ...extra });
const call = functionCall => google({ content: { role: "model", parts: [{ functionCall }] } });
const usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2, totalTokenCount: 17, trafficType: "ON_DEMAND" };
const finish = (finishReason = "STOP") => google({ finishReason }, { usageMetadata });
const partial = (name, pieces) => call({ name, willContinue: true }) +
  pieces.map((stringValue, index) => call({ partialArgs: [{ jsonPath: "$.content", stringValue, willContinue: index < pieces.length - 1 }], willContinue: true })).join("") +
  call({});
const hostError = sseData({ candidates: [{ index: 0, content: { parts: [{ text: "[API Error]\nHTTP 401" }] } }] });
const done = sseData("[DONE]");
const events = text => text.split("\n").filter(line => line.startsWith("data:") && !line.includes("[DONE]")).map(line => JSON.parse(line.slice(5)));
const contents = text => events(text).flatMap(event => event.candidates ?? []).flatMap(candidate => candidate.content?.parts ?? [])
  .filter(part => !part.thought).map(part => part.text ?? "").join("");

// A stand-in for TauriTavern's patched fetch: records the request and answers
// with the wire built from the synthetic tool name it finds in the overrides.
function host(wire, calls = []) {
  return Object.assign(async (input, init) => {
    const sent = JSON.parse(init.body);
    calls.push({ input, init, sent });
    if (typeof wire !== "function") return wire instanceof Response ? wire : new Response(wire);
    return wire(JSON.parse(sent.custom_include_body).tools[0].functionDeclarations[0].name, sent);
  }, { calls });
}
const intercept = (original, mode, extra = {}) => createFetchInterceptor(original, { origin: "http://tauri.localhost", getMode: () => mode, direct, ...extra });
const send = (wrapped, patch = {}, init = {}) => wrapped(GENERATE_PATH, { method: "POST", headers: { "x-csrf-token": "fixture" }, body: JSON.stringify({ ...body, ...patch }), ...init });

test("TauriTavern requests keep ST's own route and carry the transport in body overrides", async () => {
  const original = host(name => new Response(call({ name, args: { content: "好" } }) + finish() + done));
  const controller = new AbortController();
  for (const [mode, stream, live] of [["streaming", true, true], ["streaming", false, false], ["buffered", true, false], ["buffered", false, false]]) {
    const response = await send(intercept(original, mode), { stream, custom_include_body: '{"labels":{"team":"a"}}' }, { signal: controller.signal });
    assert.equal(response.status, 200);
    const { input, init, sent } = original.calls.at(-1);
    assert.equal(input, GENERATE_PATH);
    assert.strictEqual(init.signal, controller.signal);
    assert.deepEqual(init.headers, { "x-csrf-token": "fixture" });
    // TauriTavern still converts the prompt and applies sampling, thinking and credentials itself.
    for (const key of ["chat_completion_source", "model", "vertexai_auth_mode", "vertexai_region", "use_sysprompt", "max_tokens", "reasoning_effort", "include_reasoning", "stop"]) {
      assert.deepEqual(sent[key], body[key]);
    }
    assert.equal(sent.vertex_anti_truncation, undefined);
    assert.equal(sent.stream, true);
    assert.deepEqual(sent.messages.slice(0, 2), body.messages);
    assert.equal(sent.messages.length, 3);
    const included = JSON.parse(sent.custom_include_body);
    const [declaration] = included.tools[0].functionDeclarations;
    assert.equal(declaration.name, "router_emit");
    assert.match(sent.messages[2].content, new RegExp(declaration.name));
    assert.equal(sent.messages[2].role, "user");
    assert.deepEqual(included.toolConfig, { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [declaration.name],
      ...(live ? { streamFunctionCallArguments: true } : {}) } });
    assert.deepEqual(included.labels, { team: "a" });
  }
});

test("Additional Parameters that are not a JSON object keep TauriTavern's plain route", async () => {
  const original = host(new Response("{}"));
  const statuses = [];
  const init = { method: "POST", body: JSON.stringify({ ...body, custom_include_body: "labels:\n  team: a" }) };
  await intercept(original, "streaming", { onStatus: status => statuses.push(status) })(GENERATE_PATH, init);
  assert.strictEqual(original.calls[0].init, init);
  assert.deepEqual(statuses, [{ bypass: "additional-parameters" }]);
  for (const value of ["[1]", "3"]) assert.deepEqual(prepareTauriTavernRequest({ ...body, custom_include_body: value }, "buffered"), { bypass: "additional-parameters" });
  for (const value of [undefined, null, "  ", {}]) assert.ok(prepareTauriTavernRequest({ ...body, custom_include_body: value }, "buffered").toolName);
});

test("streaming mode restores partial arguments piece by piece before the reply ends", async () => {
  let release;
  const original = host(name => new Response(new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(google({ content: { role: "model", parts: [{ text: "想", thought: true }] } }) + partial(name, ["第一段", "\n<b>😀</b>"]).split("\n\n").slice(0, 2).join("\n\n") + "\n\n"));
      await new Promise(resolve => { release = resolve; });
      controller.enqueue(encoder.encode(partial(name, ["第一段", "\n<b>😀</b>"]).split("\n\n").slice(2).join("\n\n") + finish() + done));
      controller.close();
    },
  })));
  const response = await send(intercept(original, "streaming"));
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!contents(text)) text += decoder.decode((await reader.read()).value, { stream: true });
  assert.equal(contents(text), "第一段");
  release();
  for (let read = await reader.read(); !read.done; read = await reader.read()) text += decoder.decode(read.value, { stream: true });
  assert.equal(contents(text), "第一段\n<b>😀</b>");
  const result = events(text);
  assert.deepEqual(result.flatMap(event => event.candidates ?? []).flatMap(candidate => candidate.content.parts).filter(part => part.thought), [{ thought: true, text: "想" }]);
  assert.equal(result.find(event => event.candidates?.[0]?.finishReason).candidates[0].finishReason, "STOP");
  assert.equal(result.find(event => event.vertexAntiTruncation).vertexAntiTruncation.restored, true);
  assert.deepEqual(result.find(event => event.usageMetadata).usageMetadata, usageMetadata);
  assert.ok(text.endsWith("data: [DONE]\n\n"));
});

test("buffered mode delivers a checked, complete reply in the shape ST asked for", async () => {
  const wire = name => new Response(google({ content: { role: "model", parts: [{ text: "想", thought: true }] } }) +
    call({ name, args: { content: "正文\n<xml>😀</xml>" } }) + finish() + done);
  for (const mode of ["buffered", "streaming"]) {
    const result = await (await send(intercept(host(wire), mode), { stream: false })).json();
    assert.equal(result.choices[0].message.content, "正文\n<xml>😀</xml>");
    assert.equal(result.choices[0].finish_reason, "stop");
    assert.equal(result.choices[0].message.tool_calls, undefined);
    assert.deepEqual(result.responseContent, { role: "model", parts: [{ thought: true, text: "想" }, { text: "正文\n<xml>😀</xml>" }] });
    assert.deepEqual(result.usageMetadata, usageMetadata);
    assert.equal(result.vertexAntiTruncation.restored, true);
  }
  const streamed = await (await send(intercept(host(wire), "buffered"))).text();
  assert.equal(contents(streamed), "正文\n<xml>😀</xml>");
  assert.ok(events(streamed).some(event => event.candidates?.[0]?.finishReason === "STOP"));
});

test("cut-short, interrupted and malformed replies are never reported as complete", async () => {
  const statuses = [];
  const cut = name => call({ name, willContinue: true }) + call({ partialArgs: [{ jsonPath: "$.content", stringValue: "不完整", willContinue: true }], willContinue: true });
  // Length limits keep their native ending in both shapes.
  const limited = await (await send(intercept(host(name => new Response(cut(name) + finish("MAX_TOKENS") + done)), "streaming"))).text();
  assert.equal(contents(limited), "不完整");
  assert.ok(events(limited).some(event => event.candidates?.[0]?.finishReason === "MAX_TOKENS"));
  assert.ok(!events(limited).some(event => event.candidates?.[0]?.finishReason === "STOP"));
  for (const [wire, code] of [[name => cut(name) + done, "anti_truncation_native_stream_interrupted"],
    [name => call({ name, args: { wrong: "value" } }) + finish() + done, "anti_truncation_native_invalid_args"],
    [name => cut(name) + finish("STOP") + done, "anti_truncation_native_incomplete_args"],
    [() => done, "anti_truncation_native_stream_interrupted"],
    [name => cut(name) + sseData({ error: { code: 500, message: "provider failure", status: "INTERNAL" } }) + done, "upstream_stream_error"]]) {
    const streamed = events(await (await send(intercept(host(name => new Response(wire(name))), "streaming"))).text());
    assert.equal(streamed.at(-1).error.code, code);
    assert.ok(!streamed.some(event => event.candidates?.[0]?.finishReason));
    assert.doesNotMatch(JSON.stringify(streamed), /provider failure/);
    const buffered = await send(intercept(host(name => new Response(wire(name))), "buffered", { onStatus: status => statuses.push(status) }), { stream: false });
    assert.equal(buffered.status, 502);
    assert.equal((await buffered.json()).error.code, code);
    assert.deepEqual(statuses.at(-1), { error: code, status: 502 });
  }
});

test("TauriTavern's own error text and quiet-request errors pass through", async () => {
  for (const mode of ["streaming", "buffered"]) {
    const streamed = await (await send(intercept(host(hostError + done), mode))).text();
    assert.equal(contents(streamed), "[API Error]\nHTTP 401");
    const completion = await (await send(intercept(host(hostError + done), mode), { stream: false })).json();
    assert.equal(completion.choices[0].message.content, "[API Error]\nHTTP 401");
    assert.equal(completion.vertexAntiTruncation.restored, false);
  }
  // The same text after Google's own events is model output without an ending, not a host error.
  const model = google({ content: { role: "model", parts: [{ text: "未结束" }] } });
  assert.equal(events(await (await send(intercept(host(model + done), "streaming"))).text()).at(-1).error.code, "anti_truncation_native_stream_interrupted");
  const quiet = new Response('{"error":{"message":"failed"}}', { status: 502 });
  assert.strictEqual(await send(intercept(host(() => quiet), "buffered")), quiet);
});

test("a cancelled request stops without an error event or a failure response", async () => {
  const controller = new AbortController();
  const closing = name => new Response(new ReadableStream({ start(stream) {
    stream.enqueue(new TextEncoder().encode(call({ name, willContinue: true })));
    controller.signal.addEventListener("abort", () => stream.close());
  } }));
  const streamed = await send(intercept(host(closing), "streaming"), {}, { signal: controller.signal });
  const pending = streamed.text();
  controller.abort();
  await assert.rejects(pending, { code: "anti_truncation_native_stream_interrupted" });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(send(intercept(host(name => new Response(call({ name, willContinue: true }))), "buffered"), { stream: false }, { signal: aborted.signal }), { name: "AbortError" });
});

test("Continue asks for the suffix only and is confirmed without a server plugin", async () => {
  const statuses = [];
  const original = host(name => new Response(call({ name, args: { content: "续文" } }) + finish() + done));
  const wrapped = intercept(original, "streaming", { ensureBackend: async () => true, onStatus: status => statuses.push(status) });
  const patch = { type: "continue", messages: [...body.messages, { role: "assistant", content: "已有正文" }] };
  const response = await send(wrapped, patch);
  assert.equal(contents(await response.text()), "续文");
  const sent = original.calls[0].sent;
  assert.deepEqual(sent.messages.slice(0, 3), patch.messages);
  assert.ok(sent.messages[3].content.endsWith(CONTINUATION_INSTRUCTION));
  assert.deepEqual(statuses.at(-1), { mode: "streaming", continuation: true });
  await send(wrapped);
  assert.ok(!original.calls[1].sent.messages.at(-1).content.includes(CONTINUATION_INSTRUCTION));
  // Continue keeps the ordinary tool declaration; only the final message changes.
  assert.deepEqual(JSON.parse(sent.custom_include_body).tools, JSON.parse(original.calls[1].sent.custom_include_body).tools);
});

test("Gemini 4 Argon output limits are checked before TauriTavern sends anything", async () => {
  const original = host(name => new Response(call({ name, args: { content: "好" } }) + finish() + done));
  const statuses = [];
  const wrapped = intercept(original, "buffered", { onStatus: status => statuses.push(status) });
  await assert.rejects(send(wrapped, { model: "gemini-4-argon", max_tokens: 65537 }), { code: "gemini4_long_decode_required" });
  assert.deepEqual(statuses, [{ error: "gemini4_long_decode_required" }]);
  assert.equal(original.calls.length, 0);
  // The upstream request always streams here, so the streaming limit applies to both modes.
  const result = await (await send(wrapped, { model: "gemini-4-argon", max_tokens: 65536, stream: false })).json();
  assert.equal(result.choices[0].message.content, "好");
});

test("requests the transport cannot carry and other providers keep TauriTavern's route unchanged", async () => {
  const original = host(new Response("{}"));
  const wrapped = intercept(original, "streaming");
  for (const patch of [{ tools: [{}] }, { enable_web_search: true }, { model: "claude-sonnet-5" }, { reverse_proxy: "https://example.invalid" },
    { chat_completion_source: "makersuite" }, { json_schema: { value: {} } }]) {
    const init = { method: "POST", body: JSON.stringify({ ...body, ...patch }) };
    await wrapped(GENERATE_PATH, init);
    assert.strictEqual(original.calls.at(-1).init, init);
  }
  const off = { method: "POST", body: JSON.stringify(body) };
  let passed;
  await intercept(async (input, init) => { passed = init; return new Response("{}"); }, "off")(GENERATE_PATH, off);
  assert.strictEqual(passed, off);
});

test("everything the extension loads in a WebView avoids Node-only modules", async () => {
  const seen = new Set();
  const visit = async url => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const source = await readFile(url, "utf8");
    for (const [, specifier] of source.matchAll(/(?:from\s*|import\s*\(\s*|^import\s*)["']([^"']+)["']/gm)) {
      assert.match(specifier, /^\.{1,2}\//, `${url.pathname} imports ${specifier}`);
      await visit(new URL(specifier, url));
    }
  };
  await visit(new URL("../integrations/sillytavern/index.js", import.meta.url));
  assert.ok(seen.has(new URL("../src/tauritavern.mjs", import.meta.url).href));
  assert.ok(seen.has(new URL("../src/anti-truncation.mjs", import.meta.url).href));
});
