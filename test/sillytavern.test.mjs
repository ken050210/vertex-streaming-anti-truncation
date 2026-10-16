import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { prepareSillyTavernRequest, restoreSillyTavernResponse } from "../src/sillytavern.mjs";
import { createGenerateHandler, connectionForRequest } from "../integrations/sillytavern/server.mjs";
import { createFetchInterceptor, bypassReason, compareVersions, BODY_LIMIT, GENERATE_PATH, MIN_SERVER_VERSION, PLUGIN_PATH, PLUGIN_VERSION } from "../integrations/sillytavern/shared.js";
import { sseData } from "../src/wire.mjs";
import { CONTINUATION_INSTRUCTION } from "../src/anti-truncation.mjs";

const body = { chat_completion_source: "vertexai", model: "gemini-3-flash-preview", stream: true,
  vertex_anti_truncation: "streaming", vertexai_auth_mode: "express", vertexai_region: "global", vertexai_service_tier: "flex",
  messages: [{ role: "system", content: "规则" }, { role: "user", content: "你好" }], use_sysprompt: true, max_tokens: 128,
  reasoning_effort: "min", include_reasoning: true, stop: ["END"], temperature: 0.5, top_p: 0.9 };
const adapters = {
  getPromptNames: () => ({ charName: "角色" }),
  convertGooglePrompt: messages => ({ contents: messages.filter(message => message.role !== "system").map(message => ({
    role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }],
  })), system_instruction: { parts: [{ text: "规则" }] } }),
  calculateGoogleBudgetTokens: () => "MINIMAL",
  safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }],
  SECRET_KEYS: { VERTEXAI: "test-key", VERTEXAI_SERVICE_ACCOUNT: "test-account" },
  readSecret: () => "fixture-api-key",
};
const request = extra => ({ body: { ...structuredClone(body), ...extra }, user: { directories: {} } });
const nativeCall = functionCall => sseData({ candidates: [{ content: { parts: [{ functionCall }] } }] });
const completeWire = (name, text = "正文😀") => nativeCall({ name, args: { content: text } }) + sseData({
  candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15, trafficType: "ON_DEMAND_FLEX" },
});
const events = text => text.split("\n").filter(line => line.startsWith("data:") && !line.includes("[DONE]")).map(line => JSON.parse(line.slice(5)));
const contents = text => events(text).flatMap(event => event.candidates ?? []).flatMap(candidate => candidate.content?.parts ?? [])
  .filter(part => !part.thought).map(part => part.text ?? "").join("");

test("SillyTavern Gemini 4 uses thinking levels without relying on older Tavern model recognition", () => {
  for (const [effort, level] of [["min", "LOW"], ["low", "LOW"], ["medium", "MEDIUM"], ["high", "HIGH"], ["max", "HIGH"], [undefined, "MEDIUM"]]) {
    const prepared = prepareSillyTavernRequest(request({ model: "gemini-4-argon", reasoning_effort: effort, top_k: 40, presence_penalty: 1 }),
      { ...adapters, calculateGoogleBudgetTokens() { throw new Error("old model detector must not run"); } });
    assert.deepEqual(prepared.body.generationConfig.thinkingConfig, { thinkingLevel: level, includeThoughts: true });
    assert.equal(prepared.body.generationConfig.maxOutputTokens, 128);
    for (const key of ["temperature", "topP", "topK", "presencePenalty"]) assert.equal(prepared.body.generationConfig[key], undefined);
  }
  assert.throws(() => prepareSillyTavernRequest(request({ model: "gemini-4-argon", max_tokens: 65537 }), adapters), { code: "gemini4_long_decode_required" });
});

test("SillyTavern intercept is scoped, preserves CSRF/cancellation, and never retries failures", async () => {
  const calls = [];
  const original = async (...args) => { calls.push(args); return new Response("failure", { status: 429 }); };
  const wrapped = createFetchInterceptor(original, { origin: "http://localhost", getMode: () => "streaming" });
  const controller = new AbortController();
  const init = { method: "POST", headers: { "x-csrf-token": "fixture-csrf" }, signal: controller.signal, body: JSON.stringify(body) };
  await wrapped(GENERATE_PATH, init);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], `${PLUGIN_PATH}/generate`);
  assert.strictEqual(calls[0][1].signal, controller.signal);
  assert.strictEqual(calls[0][1].headers, init.headers);
  for (const patch of [{ tools: [{}] }, { json_schema: { value: {} } }, { enable_web_search: true }, { request_images: true },
    { messages: [{ role: "tool", content: "result" }] },
    { messages: [{ role: "assistant", content: [{ type: "tool_calls", tool_calls: [{ function: { name: "lookup", arguments: "{}" } }] }] }] },
    { messages: [{ role: "user", content: [{ type: "tool_call_id", tool_call_id: "call-1", content: "result" }] }] },
    { messages: [{ role: "user", tool_call_id: "call-1", content: "result" }] },
    { n: 2 }, { reverse_proxy: "https://example.invalid" }, { chat_completion_source: "custom" }]) {
    const input = { ...init, body: JSON.stringify({ ...body, ...patch }) };
    await wrapped(GENERATE_PATH, input);
    assert.equal(calls.at(-1)[0], GENERATE_PATH);
    assert.strictEqual(calls.at(-1)[1], input);
  }
  for (const url of ["https://example.invalid" + GENERATE_PATH, "/api/secrets/write"]) {
    await wrapped(url, init);
    assert.equal(calls.at(-1)[0], url);
  }
  assert.equal(bypassReason(body, "off"), "disabled");
  const req = new Request("http://localhost" + GENERATE_PATH, init);
  await wrapped(req);
  assert.equal(calls.at(-1)[0].url, "http://localhost" + PLUGIN_PATH + "/generate");
  assert.equal(calls.at(-1)[0].headers.get("x-csrf-token"), "fixture-csrf");
  assert.equal((await calls.at(-1)[0].json()).vertex_anti_truncation, "streaming");
  assert.equal(req.bodyUsed, false);
});

test("SillyTavern preserves prompt conversion and parameters without modifying the original", () => {
  const input = request();
  const original = structuredClone(input);
  const prepared = prepareSillyTavernRequest(input, adapters);
  assert.deepEqual(input, original);
  assert.equal(prepared.upstreamStream, true);
  assert.equal(prepared.body.toolConfig.functionCallingConfig.streamFunctionCallArguments, true);
  assert.deepEqual(prepared.body.systemInstruction, { parts: [{ text: "规则" }] });
  assert.deepEqual(prepared.body.generationConfig, { maxOutputTokens: 128, temperature: 0.5, topP: 0.9, stopSequences: ["END"],
    thinkingConfig: { includeThoughts: true, thinkingLevel: "MINIMAL" } });
  assert.deepEqual(prepared.body.safetySettings, adapters.safetySettings);
  assert.equal(prepareSillyTavernRequest(request({ vertex_anti_truncation: "buffered" }), adapters).upstreamStream, false);
  assert.equal(prepareSillyTavernRequest(request({ stream: false }), adapters).upstreamStream, false);
  assert.throws(() => prepareSillyTavernRequest(request({ json_schema: { value: {} } }), adapters), /unsupported_request/);
  let processed = false;
  prepareSillyTavernRequest(request({ custom_prompt_post_processing: "strict" }), { ...adapters, postProcessPrompt(messages, type) {
    assert.equal(type, "strict"); processed = true; return messages;
  } });
  assert.ok(processed);
});

test("Continue requests append a suffix instruction after processing, for prefill and nudge prompts", () => {
  const prefix = { role: "assistant", name: "角色", content: "<正文>他推开门，看到" };
  for (const nudge of [false, true]) for (const mode of ["buffered", "streaming"]) {
    const messages = [...body.messages, prefix, ...(nudge ? [{ role: "system", content: "继续最后一条消息，不要重复已有内容。" }] : [])];
    const input = request({ type: "continue", messages, vertex_anti_truncation: mode, custom_prompt_post_processing: "merge" });
    const before = structuredClone(input);
    let processed = false;
    const prepared = prepareSillyTavernRequest(input, { ...adapters,
      postProcessPrompt(received) {
        assert.deepEqual(received, messages);
        processed = true;
        return received;
      },
      convertGooglePrompt(received) {
        assert.ok(processed);
        assert.deepEqual(received.slice(0, -1), messages);
        assert.equal(received.length, messages.length + 1);
        assert.equal(received.at(-1).role, "user");
        assert.match(received.at(-1).content, /Put only the new continuation text/);
        assert.ok(received.at(-1).content.endsWith(CONTINUATION_INSTRUCTION));
        assert.ok(!received.at(-1).content.includes(prefix.content));
        return adapters.convertGooglePrompt(received);
      },
    });
    assert.deepEqual(input, before);
    assert.equal(prepared.continuation, true);
    assert.equal(prepared.upstreamStream, mode === "streaming");
    assert.deepEqual(prepared.body.tools, prepareSillyTavernRequest(request({ vertex_anti_truncation: mode }), adapters).body.tools);
    assert.equal(prepared.body.contents.at(-1).role, "user");
  }
  // An assistant prefill in an ordinary preset is not a Continue operation.
  for (const type of [undefined, "normal", "swipe", "regenerate", "quiet", "impersonate"]) {
    const prepared = prepareSillyTavernRequest(request({ type, messages: [...body.messages, prefix] }), adapters);
    assert.equal(prepared.continuation, false);
    assert.match(prepared.body.contents.at(-1).parts[0].text, /Put the entire user-visible answer/);
    assert.ok(!JSON.stringify(prepared.body).includes(CONTINUATION_INSTRUCTION));
  }
});

test("Continue checks plugin readiness only on eligible requests and reports server-confirmed adaptation", async () => {
  const calls = [], statuses = [];
  let ready = false, checks = 0, mode = "streaming";
  const intercept = createFetchInterceptor(async (...args) => {
    calls.push(args);
    return new Response("OK", { headers: { "x-vertex-continuation": "suffix" } });
  }, { origin: "http://localhost", getMode: () => mode,
    ensureBackend: async () => { checks++; return ready; }, onStatus: s => statuses.push(s) });
  const data = { ...body, type: "continue", messages: [...body.messages, { role: "assistant", content: "已有正文" }] };
  const init = { method: "POST", body: JSON.stringify(data) };
  await assert.rejects(intercept(GENERATE_PATH, init), /plugin_not_ready/);
  assert.equal(calls.length, 0);
  assert.deepEqual(statuses.at(-1), { error: "plugin_not_ready" });
  ready = true;
  await intercept(GENERATE_PATH, init);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], PLUGIN_PATH + "/generate");
  assert.deepEqual(JSON.parse(calls[0][1].body), data);
  assert.deepEqual(statuses.at(-1), { mode: "streaming", continuation: true });
  assert.equal(checks, 2);
  ready = false;
  for (const patch of [{ tools: [{}] }, { json_schema: {} }, { enable_web_search: true }]) {
    const bypass = { ...init, body: JSON.stringify({ ...data, ...patch }) };
    await intercept(GENERATE_PATH, bypass);
    assert.equal(calls.at(-1)[0], GENERATE_PATH);
    assert.strictEqual(calls.at(-1)[1], bypass);
  }
  mode = "off";
  await intercept(GENERATE_PATH, init);
  assert.strictEqual(calls.at(-1)[1], init);
  assert.equal(checks, 2);
});

test("Continue retains Unicode input status and does not claim adaptation without the server header", async () => {
  const statuses = [];
  let confirmed = false;
  const intercept = createFetchInterceptor(async (_url, init) => {
    const sent = JSON.parse(init.body);
    assert.equal(sent.type, "continue");
    assert.equal(sent.messages[1].content, "⟦U:4F60 597D⟧");
    assert.equal(sent.messages.at(-1).content, "已有正文");
    return new Response("OK", { headers: confirmed ? { "x-vertex-continuation": "suffix" } : {} });
  }, { origin: "http://localhost", getMode: () => "buffered", getUnicodeInput: () => true,
    getUserFloor: () => "你好", onStatus: value => statuses.push(value) });
  for (confirmed of [false, true]) {
    await intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify({ ...body, type: "continue",
      messages: [...body.messages, { role: "assistant", content: "已有正文" }] }) });
    assert.equal(statuses.at(-1).unicode.reason, "encoded");
    assert.equal(statuses.at(-1).continuation, confirmed ? true : undefined);
  }
});

test("developer instructions remain system instructions through ST prompt processing", () => {
  const input = request({ messages: [{ role: "developer", content: "Follow this instruction." }, { role: "user", content: "Hello" }],
    custom_prompt_post_processing: "merge" });
  const original = structuredClone(input);
  let processed = false;
  const prepared = prepareSillyTavernRequest(input, { ...adapters,
    postProcessPrompt(messages) {
      assert.equal(messages[0].role, "system");
      processed = true;
      return messages;
    },
    convertGooglePrompt(messages, model, useSystemPrompt) {
      assert.ok(useSystemPrompt);
      // Like ST, the Google converter only extracts a leading system role.
      const instructions = [];
      while (messages[0]?.role === "system") instructions.push({ text: messages.shift().content });
      return { system_instruction: { parts: instructions }, contents: messages.map(message => ({
        role: message.role === "assistant" ? "model" : message.role, parts: [{ text: message.content }],
      })) };
    },
  });
  assert.ok(processed);
  assert.deepEqual(prepared.body.systemInstruction, { parts: [{ text: "Follow this instruction." }] });
  assert.ok(prepared.body.contents.every(message => ["user", "model"].includes(message.role)));
  assert.deepEqual(input, original);
});

test("embedded ST tool history is rejected before prompt conversion or transport injection", () => {
  for (const messages of [
    [{ role: "assistant", content: [{ type: "tool_calls", tool_calls: [{ function: { name: "lookup", arguments: "{}" } }] }] }],
    [{ role: "user", content: [{ type: "tool_call_id", tool_call_id: "call-1", content: "result" }] }],
    [{ role: "user", tool_call_id: "call-1", content: "result" }],
  ]) {
    assert.throws(() => prepareSillyTavernRequest(request({ messages }), { ...adapters,
      convertGooglePrompt() { assert.fail("tool history must bypass conversion"); },
    }), { code: "unsupported_request_tool_history", status: 400 });
  }
});

test("SillyTavern credentials stay per-user and selected secret; destinations cannot be overridden", () => {
  const reads = [];
  const input = request({ secret_id: "selected" });
  const config = connectionForRequest(input, { ...adapters, readSecret(...args) { reads.push(args); return "fixture-key"; } });
  assert.deepEqual(reads, [[input.user.directories, "test-key", "selected"]]);
  assert.equal(config.baseUrl, "https://aiplatform.googleapis.com/v1");
  assert.equal(config.tierHeaders["x-vertex-ai-llm-shared-request-type"], "flex");
  assert.throws(() => connectionForRequest(request({ vertexai_region: "global/evil" }), adapters));
  assert.throws(() => connectionForRequest(request({ reverse_proxy: "http://example.invalid" }), adapters));
  assert.throws(() => prepareSillyTavernRequest(request({ model: "../../private" }), adapters));
});

for (const type of ["normal", "continue"]) test(`native partialArgs reach ST before completion with no synthetic tools or duplicate text (${type})`, async () => {
  const prepared = prepareSillyTavernRequest(request({ type, messages: [...body.messages, { role: "assistant", content: "已有正文" }] }), adapters);
  let upstreamController;
  const upstream = new Response(new ReadableStream({ start(controller) { upstreamController = controller; } }));
  const restored = await restoreSillyTavernResponse(upstream, prepared);
  const reader = restored.body.getReader();
  const encoder = new TextEncoder();
  upstreamController.enqueue(encoder.encode(nativeCall({ name: prepared.toolName, willContinue: true }) +
    nativeCall({ partialArgs: [{ jsonPath: "$.content", stringValue: "首段😀", willContinue: true }], willContinue: true })));
  let text = "";
  const decoder = new TextDecoder();
  while (!contents(text).includes("首段😀")) {
    const chunk = await reader.read();
    text += decoder.decode(chunk.value, { stream: true });
  }
  assert.ok(!text.includes("[DONE]"));
  upstreamController.enqueue(encoder.encode(nativeCall({ partialArgs: [{ jsonPath: "$.content", stringValue: "尾段", willContinue: false }], willContinue: false }) +
    sseData({ candidates: [{ finishReason: "STOP" }], usageMetadata: { totalTokenCount: 15, trafficType: "ON_DEMAND_FLEX" } })));
  upstreamController.close();
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value, { stream: true }); }
  assert.equal(contents(text), "首段😀尾段");
  assert.ok(!text.includes(prepared.toolName));
  assert.ok(!text.includes("tool_calls"));
  assert.ok(text.endsWith("data: [DONE]\n\n"));
  assert.ok(events(text).some(event => event.usageMetadata?.trafficType === "ON_DEMAND_FLEX"));
});

test("buffered replies use ST's non-streaming shape and SSE adapter", async () => {
  for (const stream of [false, true]) {
    const prepared = prepareSillyTavernRequest(request({ stream, vertex_anti_truncation: "buffered" }), adapters);
    const raw = { candidates: [{ content: { parts: [{ text: "思考", thought: true }, { functionCall: { name: prepared.toolName, args: { content: "正文\n<xml>😀</xml>" } } }] }, finishReason: "STOP" }] };
    const restored = await restoreSillyTavernResponse(Response.json(raw), prepared);
    if (stream) assert.equal(contents(await restored.text()), "正文\n<xml>😀</xml>");
    else {
      const result = await restored.json();
      assert.equal(result.choices[0].message.content, "正文\n<xml>😀</xml>");
      assert.equal(result.choices[0].finish_reason, "stop");
      assert.deepEqual(result.responseContent.parts, [{ thought: true, text: "思考" }, { text: "正文\n<xml>😀</xml>" }]);
      assert.equal(result.vertexAntiTruncation.restored, true);
    }
  }
});

test("malformed, prematurely closed and empty native streams cannot report success", async () => {
  const prepared = prepareSillyTavernRequest(request(), adapters);
  for (const wire of ["", nativeCall({ name: prepared.toolName, willContinue: true }),
    nativeCall({ name: prepared.toolName, args: { wrong: "value" } }) + sseData({ candidates: [{ finishReason: "STOP" }] }),
    sseData({ error: { message: "provider failure" } })]) {
    const restored = await restoreSillyTavernResponse(new Response(wire), prepared);
    await assert.rejects(restored.text());
  }
  const truncated = await restoreSillyTavernResponse(new Response(nativeCall({ name: prepared.toolName, willContinue: true }) +
    nativeCall({ partialArgs: [{ jsonPath: "$.content", stringValue: "不完整", willContinue: true }], willContinue: true }) +
    sseData({ candidates: [{ finishReason: "MAX_TOKENS" }] })), prepared);
  const text = await truncated.text();
  assert.equal(contents(text), "不完整");
  assert.ok(events(text).some(event => event.candidates?.[0]?.finishReason === "MAX_TOKENS"));
  assert.ok(!events(text).some(event => event.candidates?.[0]?.finishReason === "STOP"));
});

test("both streaming modes preserve native reasoning usage and exact finish codes", async () => {
  const usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7,
    totalTokenCount: 22, cachedContentTokenCount: 3, trafficType: "ON_DEMAND_FLEX",
    candidatesTokensDetails: [{ modality: "TEXT", tokenCount: 5 }] };
  for (const mode of ["streaming", "buffered"]) {
    const prepared = prepareSillyTavernRequest(request({ vertex_anti_truncation: mode }), adapters);
    const raw = { candidates: [{ content: { parts: [{ text: "已有正文" }] }, finishReason: "RECITATION" }], usageMetadata };
    const upstream = mode === "streaming" ? new Response(sseData(raw)) : Response.json(raw);
    const restored = await restoreSillyTavernResponse(upstream, prepared);
    const result = events(await restored.text());
    assert.equal(contents(result.map(sseData).join("")), "已有正文");
    assert.ok(result.some(event => event.candidates?.[0]?.finishReason === "RECITATION"));
    const usage = result.find(event => event.usageMetadata);
    assert.deepEqual(usage.usageMetadata, usageMetadata);
    assert.equal(usage.usage.completion_tokens, 12);
  }
});

test("a native parsing failure before output returns a JSON HTTP error", async t => {
  const handler = createGenerateHandler(adapters, { fetchImpl: async () => new Response("data: malformed\n\n") });
  const server = http.createServer(async (req, res) => {
    req.body = structuredClone(body); req.user = { directories: {} };
    res.status = value => { res.statusCode = value; return res; };
    res.json = value => {
      // Express preserves a Content-Type that was already set by the handler.
      if (!res.hasHeader("content-type")) res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(value));
    };
    await handler(req, res);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}`);
  assert.equal(response.status, 502);
  assert.match(response.headers.get("content-type"), /^application\/json/);
  assert.equal((await response.json()).error.code, "anti_truncation_native_invalid_sse");
});

test("server handler uses one mock upstream request and returns readable native SSE", async t => {
  let calls = 0;
  const handler = createGenerateHandler(adapters, { fetchImpl: async (url, init) => {
    calls++;
    assert.equal(new URL(url).host, "aiplatform.googleapis.com");
    assert.equal(init.headers["x-vertex-ai-llm-shared-request-type"], "flex");
    const sent = JSON.parse(init.body);
    return new Response(completeWire(sent.tools[0].functionDeclarations[0].name));
  } });
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    req.body = JSON.parse(Buffer.concat(chunks).toString()); req.user = { directories: {} };
    res.status = value => { res.statusCode = value; return res; };
    res.json = value => res.end(JSON.stringify(value));
    await handler(req, res);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}`, { method: "POST", body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  // ST's compression() would otherwise buffer the whole stream.
  assert.match(response.headers.get("cache-control"), /no-transform/);
  assert.equal(contents(await response.text()), "正文😀");
  assert.equal(calls, 1);
});

test("Unicode transforms before off/tools/schema bypass and retains Request metadata", async () => {
  const calls = [], statuses = [];
  let enabled = true, floor = "你好", mode = "off";
  const original = async (...args) => { calls.push(args); return new Response("OK"); };
  const wrapped = createFetchInterceptor(original, { origin: "http://localhost", getMode: () => mode,
    getUnicodeInput: () => enabled, getUserFloor: () => floor, onStatus: s => statuses.push(s) });
  for (mode of ["off", "buffered", "streaming"]) for (const extra of [{}, { tools: [{ function: { name: floor } }] },
    { json_schema: { properties: { [floor]: { type: "string" } } } }, { enable_web_search: true }]) {
    const data = { ...structuredClone(body), ...extra };
    const controller = new AbortController();
    const req = new Request("http://localhost" + GENERATE_PATH, { method: "POST", headers: { "x-csrf-token": "fixture" },
      credentials: "include", signal: controller.signal, body: JSON.stringify(data) });
    const before = calls.length;
    await wrapped(req);
    assert.equal(calls.length, before + 1);
    assert.equal(req.bodyUsed, false);
    const posted = calls.at(-1)[0], decoded = await posted.clone().json();
    assert.equal(posted.url, "http://localhost" + (mode === "off" || Object.keys(extra).length ? GENERATE_PATH : PLUGIN_PATH + "/generate"));
    assert.equal(decoded.messages[1].content, "⟦U:4F60 597D⟧");
    assert.deepEqual(data.messages, body.messages);
    assert.equal(decoded.router_unicode_input, undefined);
    for (const [key, value] of Object.entries(extra)) assert.deepEqual(decoded[key], value);
    assert.equal(posted.headers.get("x-csrf-token"), "fixture");
    assert.equal(posted.credentials, "include");
    controller.abort(); assert.equal(posted.signal.aborted, true);
  }
  mode = "off"; enabled = false;
  const init = { method: "POST", body: JSON.stringify(body) };
  await wrapped(GENERATE_PATH, init);
  assert.equal(calls.at(-1)[1], init);
  enabled = true; floor = "missing";
  await wrapped(GENERATE_PATH, init);
  assert.equal(statuses.at(-1).unicode.reason, "floor-not-found");
  assert.deepEqual(JSON.parse(calls.at(-1)[1].body), body);
  const count = calls.length; floor = "";
  await assert.rejects(wrapped(GENERATE_PATH, init), { code: "unicode_floor_required" });
  assert.equal(calls.length, count);
  assert.equal(statuses.at(-1).error, "unicode_floor_required");
  floor = "A".repeat(3000000);
  await assert.rejects(wrapped(GENERATE_PATH, { ...init, body: JSON.stringify({ ...body, messages: [{ role: "user", content: floor }] }) }), { code: "unicode_input_too_large" });
  assert.equal(calls.length, count);
  await wrapped(GENERATE_PATH, { ...init, body: JSON.stringify({ ...body, chat_completion_source: "custom" }) });
  assert.equal(calls.length, count + 1);
});

test("Unicode floor comes from the latest real user, including empty-floor failure", async () => {
  const { latestUserFloor } = await import("../integrations/sillytavern/shared.js");
  assert.equal(latestUserFloor([{ is_user: true, mes: "old" }, { is_user: true, mes: "latest" },
    { is_system: true, is_user: true, mes: "system" }, { is_user: false, mes: "assistant" }]), "latest");
  assert.equal(latestUserFloor([{ is_user: true, mes: "old" }, { is_user: true, mes: "" }]), "");
  assert.equal(latestUserFloor(undefined), "");
});

test("image option forwards only eligible plugin requests and forces buffered image transport",async()=>{
 const calls=[],statuses=[];
 const intercept=createFetchInterceptor(async(...args)=>{calls.push(args);return new Response('OK');},{origin:'http://localhost',getMode:()=> 'streaming',getImageInput:()=> 'current-turn',onStatus:s=>statuses.push(s)});
 await intercept(GENERATE_PATH,{method:'POST',body:JSON.stringify(body)});
 assert.equal(JSON.parse(calls[0][1].body).vertex_image_input,'current-turn');
 // The refusal names the actual cause so the panel does not guess.
 await assert.rejects(intercept(GENERATE_PATH,{method:'POST',body:JSON.stringify({...body,model:'gemini-3-pro-image'})}),/image_input_requires/);
 assert.deepEqual(statuses.at(-1),{error:'image_input_requires_supported_request',bypass:'model'});
 const {prepareImageInput}=await import('../src/image-input.mjs');
 const converted=await prepareImageInput(body,'current-turn');
 const prepared=prepareSillyTavernRequest(request({...converted.payload,vertex_image_input:'current-turn'}),adapters);
 assert.equal(prepared.upstreamStream,false);
 await assert.rejects(intercept(GENERATE_PATH,{method:'POST',body:JSON.stringify({...body,tools:[{type:'function'}]})}),/image_input_requires/);
 assert.equal(calls.length,1);
});

test("image-only plugin mode is independent from anti-truncation and restores native text",async()=>{
 const {prepareImageInput}=await import('../src/image-input.mjs');
 const converted=await prepareImageInput({...body,vertex_image_input:'current-turn',vertex_anti_truncation:'off'},'current-turn');
 const prepared=prepareSillyTavernRequest(request(converted.payload),adapters);
 assert.equal(Boolean(prepared.toolName),false);assert.equal(prepared.upstreamStream,false);
 const response=await restoreSillyTavernResponse(Response.json({candidates:[{content:{parts:[{text:'OK'}]},finishReason:'STOP'}]}),prepared);
 assert.equal(contents(await response.text()),'OK');
 const calls=[];
 const intercept=createFetchInterceptor(async(...args)=>{calls.push(args);return new Response('OK');},{origin:'http://localhost',getMode:()=> 'off',getImageInput:()=> 'current-turn'});
 await intercept(GENERATE_PATH,{method:'POST',body:JSON.stringify(body)});
 assert.equal(calls[0][0],PLUGIN_PATH+'/generate');assert.equal(JSON.parse(calls[0][1].body).vertex_anti_truncation,'off');
});

test("image input is refused until the server plugin is confirmed; anti-truncation alone is not gated", async () => {
  const calls = [], statuses = [];
  let ready = false, checks = 0, image = "current-turn";
  const intercept = createFetchInterceptor(async (...args) => { calls.push(args); return new Response("OK"); }, { origin: "http://localhost",
    getMode: () => "streaming", getImageInput: () => image, ensureBackend: async () => { checks++; return ready; }, onStatus: s => statuses.push(s) });
  await assert.rejects(intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify(body) }), /plugin_not_ready/);
  assert.equal(calls.length, 0);
  assert.deepEqual(statuses.at(-1), { error: "plugin_not_ready" });
  ready = true;
  await intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify(body) });
  assert.equal(JSON.parse(calls[0][1].body).vertex_image_input, "current-turn");
  image = "off";
  await intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify(body) });
  assert.equal(checks, 2);
  assert.equal(calls[1][0], PLUGIN_PATH + "/generate");
});

test("anti-truncation requests above the plugin limit keep ST's route; image requests do not fall back", async () => {
  const calls = [], statuses = [];
  let image = "off";
  const intercept = createFetchInterceptor(async (...args) => { calls.push(args); return new Response("OK"); }, { origin: "http://localhost",
    getMode: () => "buffered", getImageInput: () => image, onStatus: s => statuses.push(s) });
  const large = { ...body, messages: [{ role: "user", content: "a".repeat(BODY_LIMIT) }] };
  const init = { method: "POST", body: JSON.stringify(large) };
  await intercept(GENERATE_PATH, init);
  assert.equal(calls.at(-1)[0], GENERATE_PATH);
  assert.strictEqual(calls.at(-1)[1], init);
  assert.deepEqual(statuses.at(-1), { bypass: "too-large" });
  // Multi-byte text is measured in UTF-8 bytes, as the server measures it.
  await intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify({ ...body, messages: [{ role: "user", content: "字".repeat(BODY_LIMIT / 3 + 1) }] }) });
  assert.equal(calls.at(-1)[0], GENERATE_PATH);
  await intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify(body) });
  assert.equal(calls.at(-1)[0], PLUGIN_PATH + "/generate");
  image = "all";
  await intercept(GENERATE_PATH, init);
  assert.equal(calls.at(-1)[0], PLUGIN_PATH + "/generate");
  assert.throws(() => prepareSillyTavernRequest(request({ ...large, vertex_image_input: "all" }), adapters), { code: "request_too_large", status: 413 });
});

test("plugin failures report their fixed code without consuming the response", async () => {
  const statuses = [];
  let reply;
  const intercept = createFetchInterceptor(async () => reply(), { origin: "http://localhost", getMode: () => "buffered", onStatus: s => statuses.push(s) });
  const failure = { error: { code: "image_input_unsupported_characters", message: "图片输入转换失败" } };
  reply = () => Response.json(failure, { status: 400 });
  const response = await intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify(body) });
  assert.deepEqual(statuses.at(-1), { error: "image_input_unsupported_characters", status: 400 });
  assert.deepEqual(await response.json(), failure);
  reply = () => new Response("<html>Cannot POST</html>", { status: 404 });
  await intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify(body) });
  assert.deepEqual(statuses.at(-1), { error: 404 });
  reply = () => Response.json(failure, { status: 429 });
  await intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify({ ...body, tools: [{}] }) });
  assert.deepEqual(statuses.at(-1), { bypass: "existing-tools" });
});

test("image conversion failures are labelled as image input, not anti-truncation", async t => {
  const upstream = [];
  const handler = createGenerateHandler(adapters, { fetchImpl: async (...args) => { upstream.push(args); return new Response("busy", { status: 429 }); } });
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    req.body = JSON.parse(Buffer.concat(chunks).toString()); req.user = { directories: {} };
    res.status = value => { res.statusCode = value; return res; };
    res.json = value => res.end(JSON.stringify(value));
    await handler(req, res);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const post = async extra => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, { method: "POST", body: JSON.stringify({ ...body, ...extra }) });
    return { status: response.status, error: (await response.json()).error };
  };
  const emoji = await post({ vertex_anti_truncation: "off", vertex_image_input: "all", messages: [{ role: "user", content: "你好😀" }] });
  assert.equal(emoji.status, 400);
  assert.equal(emoji.error.code, "image_input_unsupported_characters");
  assert.match(emoji.error.message, /^图片输入转换失败/);
  assert.equal(upstream.length, 0);
  const rejected = await post({ vertex_anti_truncation: "off", vertex_image_input: "current-turn" });
  assert.equal(rejected.status, 429);
  assert.equal(rejected.error.message, "Vertex 图片输入请求失败。 (vertex_upstream_http_error, HTTP 429)");
  const wrapped = await post({ vertex_image_input: "current-turn" });
  assert.match(wrapped.error.message, /^Vertex 抗截断请求失败。/);
  assert.equal(upstream.length, 2);
});

test("image requests report the plugin's conversion outcome, including text sent unchanged", async t => {
  const statuses = [];
  let headers = { "x-image-input": "no-text", "x-image-input-pages": "0" };
  const intercept = createFetchInterceptor(async () => new Response("OK", { headers }), { origin: "http://localhost",
    getMode: () => "streaming", getImageInput: () => "current-turn", onStatus: s => statuses.push(s) });
  await intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify(body) });
  assert.deepEqual(statuses.at(-1), { mode: "streaming", image: { mode: "current-turn", reason: "no-text", pages: 0, stream: true } });
  headers = { "x-image-input": "encoded", "x-image-input-pages": "2" };
  await intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify(body) });
  assert.deepEqual(statuses.at(-1).image, { mode: "current-turn", reason: "encoded", pages: 2, stream: true });
  // The panel's buffering note depends on whether ST itself asked to stream.
  await intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify({ ...body, stream: false }) });
  assert.equal(statuses.at(-1).image.stream, false);

  const sent = [];
  const handler = createGenerateHandler(adapters, { fetchImpl: async (url, init) => {
    sent.push(JSON.parse(init.body));
    return Response.json({ candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] });
  } });
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    req.body = JSON.parse(Buffer.concat(chunks).toString()); req.user = { directories: {} };
    res.status = value => { res.statusCode = value; return res; };
    res.json = value => res.end(JSON.stringify(value));
    await handler(req, res);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const post = async extra => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, { method: "POST",
      body: JSON.stringify({ ...body, vertex_anti_truncation: "off", vertex_image_input: "current-turn", ...extra }) });
    assert.equal(response.status, 200);
    assert.equal(contents(await response.text()), "OK");
    return [response.headers.get("x-image-input"), response.headers.get("x-image-input-pages")];
  };
  // Continue or an assistant-role prefill leaves nothing after the last assistant.
  assert.deepEqual(await post({ messages: [...body.messages, { role: "assistant", content: "开头" }] }), ["no-text", "0"]);
  assert.ok(!JSON.stringify(sent.at(-1)).includes("data:image"));
  assert.deepEqual(await post({}), ["encoded", "1"]);
  assert.match(JSON.stringify(sent.at(-1)), /data:image\/(png|webp);base64,/);
});

test("Continue delivers only the upstream suffix in one request across stream, buffered and image modes", async t => {
  const sent = [];
  const suffix = "\n一道光。</正文>";
  let finishReason = "STOP", upstreamStatus = 200;
  const handler = createGenerateHandler(adapters, { fetchImpl: async (url, init) => {
    const data = JSON.parse(init.body);
    sent.push(data);
    if (upstreamStatus !== 200) return new Response("busy", { status: upstreamStatus });
    const instruction = data.contents.at(-1);
    assert.equal(instruction.role, "user");
    assert.ok(instruction.parts[0].text.endsWith(CONTINUATION_INSTRUCTION));
    const name = data.tools?.[0]?.functionDeclarations[0]?.name;
    const raw = { candidates: [{ content: { role: "model", parts: [
      { text: "思考", thought: true },
      name ? { functionCall: { name, args: { content: suffix } } } : { text: suffix },
    ] }, finishReason }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } };
    return String(url).includes(":streamGenerateContent") ? new Response(sseData(raw)) : Response.json(raw);
  } });
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    req.body = JSON.parse(Buffer.concat(chunks).toString()); req.user = { directories: {} };
    const before = structuredClone(req.body);
    res.status = value => { res.statusCode = value; return res; };
    res.json = value => res.end(JSON.stringify(value));
    await handler(req, res);
    assert.deepEqual(req.body, before);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const post = extra => fetch(`http://127.0.0.1:${server.address().port}`, { method: "POST", body: JSON.stringify({
    ...body, type: "continue", messages: [...body.messages, { role: "assistant", content: "<正文>他推开门，看到" }], ...extra,
  }) });
  for (const [mode, image] of [["streaming", "off"], ["buffered", "off"], ["off", "current-turn"], ["off", "all"], ["streaming", "all"]]) {
    for (const stream of [false, true]) {
      const count = sent.length;
      const response = await post({ vertex_anti_truncation: mode, vertex_image_input: image, stream });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-vertex-continuation"), "suffix");
      if (stream) {
        const wire = await response.text();
        assert.equal(contents(wire), suffix);
        assert.equal(wire.split("data: [DONE]").length - 1, 1);
        assert.ok(events(wire).some(event => event.candidates?.[0]?.finishReason === "STOP"));
        assert.ok(events(wire).some(event => event.usageMetadata?.totalTokenCount === 15));
      } else {
        const result = await response.json();
        assert.equal(result.choices[0].message.content, suffix);
        assert.equal(result.choices[0].finish_reason, "stop");
        assert.deepEqual(result.responseContent.parts, [{ thought: true, text: "思考" }, { text: suffix }]);
        assert.equal(result.usageMetadata.totalTokenCount, 15);
      }
      assert.equal(sent.length, count + 1);
      if (image === "current-turn") assert.equal(response.headers.get("x-image-input"), "no-text");
      if (image === "all") assert.equal(response.headers.get("x-image-input"), "encoded");
    }
  }
  finishReason = "MAX_TOKENS";
  const limited = await post({});
  const wire = await limited.text();
  assert.equal(contents(wire), suffix);
  assert.ok(events(wire).some(event => event.candidates?.[0]?.finishReason === "MAX_TOKENS"));
  assert.ok(!events(wire).some(event => event.candidates?.[0]?.finishReason === "STOP"));
  const count = sent.length;
  upstreamStatus = 429;
  const failed = await post({});
  assert.equal(failed.status, 429);
  assert.equal((await failed.json()).error.code, "vertex_upstream_http_error");
  assert.equal(sent.length, count + 1);
});

test("the extension accepts any server plugin from the compatibility floor up, newer ones included", () => {
  assert.ok(compareVersions(MIN_SERVER_VERSION, PLUGIN_VERSION) <= 0);
  for (const [a, b, sign] of [["0.4.0", "0.3.1", 1], ["0.3.10", "0.3.9", 1], ["0.3.1", "0.3.1", 0], ["0.3.0", "0.3.1", -1], ["1.0", "0.9.9", 1], ["0.4", "0.4.0", 0]]) {
    assert.equal(Math.sign(compareVersions(a, b)), sign, `${a} vs ${b}`);
  }
});
