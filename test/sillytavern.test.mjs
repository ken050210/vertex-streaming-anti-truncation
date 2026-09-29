import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { prepareSillyTavernRequest, restoreSillyTavernResponse } from "../src/sillytavern.mjs";
import { createGenerateHandler, connectionForRequest } from "../integrations/sillytavern/server.mjs";
import { createFetchInterceptor, bypassReason, GENERATE_PATH, PLUGIN_PATH } from "../integrations/sillytavern/shared.js";
import { sseData } from "../src/wire.mjs";

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
    { messages: [{ role: "tool", content: "result" }] }, { n: 2 }, { reverse_proxy: "https://example.invalid" }, { chat_completion_source: "custom" }]) {
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

test("native partialArgs reach ST before completion with no synthetic tools or duplicate text", async () => {
  const prepared = prepareSillyTavernRequest(request(), adapters);
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
  assert.equal(contents(await response.text()), "正文😀");
  assert.equal(calls, 1);
});
