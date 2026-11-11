import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { prepareSillyTavernRequest, restoreSillyTavernResponse } from "../src/sillytavern.mjs";
import { createGenerateHandler, connectionForRequest } from "../integrations/sillytavern/server.mjs";
import { createFetchInterceptor, bypassReason, compareVersions, BODY_LIMIT, GENERATE_PATH, MIN_SERVER_VERSION, PLUGIN_FEATURES, PLUGIN_PATH, PLUGIN_VERSION, TOOLS_FEATURE, TRANSPORT_NAME_FEATURE } from "../integrations/sillytavern/shared.js";
import { sseData } from "../src/wire.mjs";
import { CONTINUATION_INSTRUCTION } from "../src/anti-truncation.mjs";
import { presetTextTool } from "./fixtures/preset-text-tool.mjs";

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
// The shape ST's ToolManager.toFunctionOpenAI() sends.
const lookupTool = { type: "function", function: { name: "lookup", description: "Look something up.",
  parameters: { $schema: "http://json-schema.org/draft-04/schema#", type: "object", properties: { query: { type: "string" } }, required: ["query"] } } };
const toolHistory = [{ role: "user", content: "查一下" },
  { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: '{"query":"天气"}' }, signature: "sig-old" }] },
  { role: "tool", tool_call_id: "call-1", content: "晴" }];
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
});

test("SillyTavern caps Gemini 4 output by the actual upstream request, or keeps it for long decode", () => {
  for (const mode of ["buffered", "streaming"]) for (const stream of [false, true]) for (const image of ["off", "current-turn", "all"]) {
    // A quiet request, such as the connection test, is never streamed.
    const input = request({ model: "gemini-4-argon", max_tokens: 100000, vertex_anti_truncation: mode,
      type: stream ? "normal" : "quiet", messages: [{ role: "user", content: "Hi" }], stream, vertex_image_input: image });
    const original = structuredClone(input);
    const upstreamStream = mode === "streaming" && stream;
    const applied = upstreamStream ? 65536 : 32768;
    const prepared = prepareSillyTavernRequest(input, adapters);
    assert.equal(prepared.body.generationConfig.maxOutputTokens, applied);
    assert.deepEqual(prepared.outputLimit, { requested: 100000, applied, longDecode: false });
    assert.deepEqual(input, original);
    const long = prepareSillyTavernRequest(request({ ...input.body, vertex_long_decode: true }), adapters);
    assert.equal(long.body.generationConfig.maxOutputTokens, 100000);
    assert.deepEqual(long.outputLimit, { requested: 100000, applied: 100000, longDecode: true });
  }
  assert.equal(prepareSillyTavernRequest(request({ model: "gemini-4-argon" }), adapters).outputLimit, null);
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
  for (const patch of [{ tools: [{}] }, { tools: [lookupTool], tool_choice: "required" }, { functions: [{ name: "legacy" }] },
    { tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { q: { type: "string", default: "x" } } } } }] },
    { json_schema: { value: {} } }, { enable_web_search: true }, { request_images: true },
    { messages: [{ role: "function", name: "legacy", content: "result" }] },
    { n: 2 }, { reverse_proxy: "https://example.invalid" }, { chat_completion_source: "custom" }]) {
    const input = { ...init, body: JSON.stringify({ ...body, ...patch }) };
    await wrapped(GENERATE_PATH, input);
    assert.equal(calls.at(-1)[0], GENERATE_PATH);
    assert.strictEqual(calls.at(-1)[1], input);
  }
  // Client tools and tool history (ST's own shapes included) now use the plugin.
  for (const patch of [{ tools: [lookupTool], tool_choice: "auto" }, { tools: [lookupTool], tool_choice: "none" }, { messages: toolHistory },
    { messages: [{ role: "assistant", content: [{ type: "tool_calls", tool_calls: [{ function: { name: "lookup", arguments: "{}" } }] }] }] },
    { messages: [{ role: "user", content: [{ type: "tool_call_id", tool_call_id: "call-1", content: "result" }] }] }]) {
    await wrapped(GENERATE_PATH, { ...init, body: JSON.stringify({ ...body, ...patch }) });
    assert.equal(calls.at(-1)[0], `${PLUGIN_PATH}/generate`);
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

test("ST tool history reaches ST's converter, and client tools are declared before the transport tool", () => {
  for (const [mode, stream] of [["streaming", true], ["buffered", true], ["streaming", false]]) {
    let converted;
    const input = request({ messages: [...body.messages, ...toolHistory], tools: [lookupTool], tool_choice: "auto", vertex_anti_truncation: mode, stream });
    const before = structuredClone(input);
    const prepared = prepareSillyTavernRequest(input, { ...adapters, convertGooglePrompt(messages) { converted = messages; return adapters.convertGooglePrompt(messages); } });
    assert.deepEqual(input, before);
    assert.deepEqual(converted.slice(0, -1), [...body.messages, ...toolHistory]);
    assert.match(converted.at(-1).content, /Call the other tools whenever the task needs them/);
    const declarations = prepared.body.tools[0].functionDeclarations;
    assert.deepEqual(declarations[0], { name: "lookup", description: "Look something up.",
      parametersJsonSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } });
    assert.deepEqual(declarations.map(declaration => declaration.name), ["lookup", prepared.toolName]);
    // Real calls arrive whole at ST while the transport text streams progressively.
    assert.deepEqual(prepared.body.toolConfig, { functionCallingConfig: { mode: "ANY",
      ...(mode === "streaming" && stream ? { streamFunctionCallArguments: true } : {}) } });
    assert.equal(prepared.upstreamStream, mode === "streaming" && stream);
    assert.equal(prepared.clientTools, true);
  }
  const none = prepareSillyTavernRequest(request({ tools: [lookupTool], tool_choice: "none" }), adapters);
  assert.deepEqual(none.body.toolConfig.functionCallingConfig, { mode: "ANY", allowedFunctionNames: [none.toolName], streamFunctionCallArguments: true });
  // History without declared tools keeps the transport call's argument stream.
  const history = prepareSillyTavernRequest(request({ messages: [...body.messages, ...toolHistory] }), adapters);
  assert.equal(history.body.toolConfig.functionCallingConfig.streamFunctionCallArguments, true);
  for (const [extra, code] of [[{ tools: [lookupTool], tool_choice: "required" }, "unsupported_request_tool_choice"],
    [{ messages: [{ role: "assistant", content: "", function_call: { name: "legacy", arguments: "{}" } }] }, "unsupported_request_tool_history"],
    [{ tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { q: { type: "string", pattern: "x" } } } } }] }, "unsupported_request_tool_schema"]]) {
    assert.throws(() => prepareSillyTavernRequest(request(extra), { ...adapters,
      convertGooglePrompt() { assert.fail("a bypassed request must not be converted"); },
    }), { code, status: 400 });
  }
});

test("real tool calls reach ST as whole Gemini parts beside the restored text", async () => {
  const realPart = { functionCall: { name: "lookup", args: { query: "天气" } }, thoughtSignature: "sig-new" };
  for (const [mode, stream] of [["streaming", true], ["buffered", true], ["buffered", false]]) {
    const prepared = prepareSillyTavernRequest(request({ tools: [presetTextTool, lookupTool], tool_choice: "required", vertex_anti_truncation: mode,
      vertex_transport_tool_name: "game_content", stream }), adapters);
    assert.deepEqual(prepared.body.tools[0].functionDeclarations.map(tool => tool.name), ["game_content", "lookup"]);
    assert.equal(prepared.body.tools[0].functionDeclarations[0].description, presetTextTool.function.description);
    const parts = [{ text: "思考", thought: true }, { functionCall: { name: prepared.toolName, args: { content: "我去查。" } } }, realPart];
    const upstream = prepared.upstreamStream
      ? new Response(sseData({ candidates: [{ content: { role: "model", parts } }] }) + sseData({ candidates: [{ finishReason: "STOP" }] }))
      : Response.json({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }] });
    const restored = await restoreSillyTavernResponse(upstream, prepared);
    if (!stream) {
      const result = await restored.json();
      assert.equal(result.choices[0].message.content, "我去查。");
      assert.equal(result.choices[0].finish_reason, "tool_calls");
      assert.deepEqual(result.responseContent.parts, [{ thought: true, text: "思考" }, { text: "我去查。" }, realPart]);
      continue;
    }
    const text = await restored.text();
    assert.equal(contents(text), "我去查。");
    assert.ok(!text.includes(prepared.toolName));
    // ST's stream reader ignores the text of an event that carries a function call.
    const calls = events(text).filter(event => event.candidates?.[0]?.content?.parts?.some(part => part.functionCall));
    assert.deepEqual(calls.map(event => event.candidates[0].content.parts), [[realPart]]);
    assert.ok(events(text).some(event => event.candidates?.[0]?.finishReason === "STOP"));
  }
  // Gemini 4 Argon gets its native call ID back next to the signature.
  const argon = prepareSillyTavernRequest(request({ model: "gemini-4-argon", tools: [lookupTool], stream: false }), adapters);
  const argonPart = { functionCall: { id: "fc-1", name: "lookup", args: { query: "天气" } }, thoughtSignature: "sig-4" };
  const result = await (await restoreSillyTavernResponse(Response.json({ candidates: [{ content: { role: "model", parts: [
    { functionCall: { name: argon.toolName, args: { content: "好" } } }, argonPart] }, finishReason: "STOP" }] }), argon)).json();
  assert.deepEqual(result.responseContent.parts, [{ text: "好" }, argonPart]);
});

test("a streamed call to a client tool named like the start of the transport tool reaches ST", async () => {
  const realPart = { functionCall: { name: "router", args: { query: "天气" } }, thoughtSignature: "sig-new" };
  const prepared = prepareSillyTavernRequest(request({ tools: [{ ...lookupTool, function: { ...lookupTool.function, name: "router" } }],
    vertex_anti_truncation: "streaming", stream: true }), adapters);
  const parts = [{ functionCall: { name: prepared.toolName, args: { content: "我去查。" } } }, realPart];
  const text = await (await restoreSillyTavernResponse(new Response(sseData({ candidates: [{ content: { role: "model", parts } }] }) +
    sseData({ candidates: [{ finishReason: "STOP" }] })), prepared)).text();
  assert.equal(contents(text), "我去查。");
  assert.deepEqual(events(text).flatMap(event => event.candidates?.[0]?.content?.parts?.filter(part => part.functionCall) ?? []), [realPart]);
});

test("SillyTavern credentials stay per-user and selected secret; destinations cannot be overridden", () => {
  const reads = [];
  const input = request({ secret_id: "selected" });
  const config = connectionForRequest(input, { ...adapters, readSecret(...args) { reads.push(args); return "fixture-key"; } });
  assert.deepEqual(reads, [[input.user.directories, "test-key", "selected"]]);
  assert.equal(config.baseUrl, "https://aiplatform.googleapis.com/v1");
  assert.equal(config.tierHeaders["x-vertex-ai-llm-shared-request-type"], "flex");
  for (const model of ["gemini-4-argon", "gemini-4-argon@001"]) {
    assert.throws(() => connectionForRequest(request({ model }), adapters), { status: 400, code: "express_project_required" });
    const scoped = connectionForRequest(request({ model, vertexai_express_project_id: "example-project" }), adapters);
    assert.equal(scoped.baseUrl, "https://aiplatform.googleapis.com/v1/projects/example-project/locations/global");
  }
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

test("server handler routes Express Argon through global once and rejects missing projects before inference", async t => {
  let calls = 0, expectedUrl;
  const handler = createGenerateHandler(adapters, { fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, expectedUrl);
    assert.equal(init.headers["x-vertex-ai-llm-shared-request-type"], "flex");
    assert.equal(init.headers["x-goog-api-key"], "fixture-api-key");
    const sent = JSON.parse(init.body);
    const name = sent.tools[0].functionDeclarations[0].name;
    return url.includes(":streamGenerateContent") ? new Response(completeWire(name))
      : Response.json({ candidates: [{ content: { parts: [{ functionCall: { name, args: { content: "正文😀" } } }] }, finishReason: "STOP" }] });
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
  const post = extra => fetch(`http://127.0.0.1:${server.address().port}`, { method: "POST", body: JSON.stringify({ ...body, ...extra }) });
  const missing = await post({ model: "gemini-4-argon" });
  assert.equal(missing.status, 400);
  const error = (await missing.json()).error;
  assert.equal(error.code, "express_project_required");
  assert.match(error.message, /项目 ID/);
  assert.equal(calls, 0);
  expectedUrl = "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3-flash-preview:streamGenerateContent?alt=sse";
  const response = await post({});
  assert.equal(response.status, 200);
  // ST's compression() would otherwise buffer the whole stream.
  assert.match(response.headers.get("cache-control"), /no-transform/);
  assert.equal(contents(await response.text()), "正文😀");
  assert.equal(calls, 1);
  for (const mode of ["buffered", "streaming"]) for (const stream of [false, true]) {
    const upstreamStream = mode === "streaming" && stream;
    expectedUrl = "https://aiplatform.googleapis.com/v1/projects/example-project/locations/global/publishers/google/models/gemini-4-argon:"
      + (upstreamStream ? "streamGenerateContent?alt=sse" : "generateContent");
    const result = await post({ model: "gemini-4-argon", vertexai_express_project_id: "example-project", vertex_anti_truncation: mode, stream });
    assert.equal(result.status, 200);
    const text = await result.text();
    assert.equal(stream ? contents(text) : JSON.parse(text).choices[0].message.content, "正文😀");
  }
  assert.equal(calls, 5, "one upstream call per successful request, with no duplicate project path");
});

test("server plugin continues an Argon reply on v1beta1 only when the panel enables long decode", async t => {
  const calls = [];
  const usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 };
  const piece = (stringValue, willContinue) => nativeCall({ partialArgs: [{ jsonPath: "$.content", stringValue, willContinue }], willContinue: true });
  const handler = createGenerateHandler(adapters, { fetchImpl: async (url, init) => {
    const sent = JSON.parse(init.body);
    calls.push({ url, sent });
    const name = sent.tools[0].functionDeclarations[0].name;
    if (!url.includes("/v1beta1/")) return new Response(completeWire(name));
    // Assumes the continued request resumes the same argument stream.
    return new Response(sent.continuationToken ? piece("后半", false) + nativeCall({}) + sseData({ candidates: [{ finishReason: "STOP" }], usageMetadata })
      : nativeCall({ name, willContinue: true }) + piece("前半", true) + sseData({ candidates: [{ finishReason: "CONTINUATION", continuationToken: "token-1" }], usageMetadata }));
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
  const post = extra => fetch(`http://127.0.0.1:${server.address().port}`, { method: "POST", body: JSON.stringify({ ...body, ...extra }) });
  const argon = { model: "gemini-4-argon", vertexai_express_project_id: "example-project", max_tokens: 100000 };
  const capped = await post(argon);
  assert.equal(capped.headers.get("x-gemini-output-tokens-applied"), "65536");
  assert.equal(capped.headers.get("x-gemini-long-decode"), "false");
  assert.equal(contents(await capped.text()), "正文😀");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sent.generationConfig.maxOutputTokens, 65536);
  const long = await post({ ...argon, vertex_long_decode: true });
  assert.equal(long.headers.get("x-gemini-output-tokens-applied"), "100000");
  assert.equal(long.headers.get("x-gemini-long-decode"), "true");
  assert.equal(contents(await long.text()), "前半后半");
  assert.equal(calls.length, 3);
  for (const { url, sent } of calls.slice(1)) {
    assert.equal(url, "https://aiplatform.googleapis.com/v1beta1/projects/example-project/locations/global/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse");
    assert.equal(sent.generationConfig.maxOutputTokens, 100000);
  }
  assert.deepEqual(calls[2].sent, { ...calls[1].sent, continuationToken: "token-1" });
});

test("the long-decode setting rides only on plugin requests, and the reported limit reaches the panel", async () => {
  const calls = [], statuses = [];
  let legacyEnabled = true;
  const headers = { "x-gemini-output-tokens-requested": "100000", "x-gemini-output-tokens-applied": "100000", "x-gemini-long-decode": "true" };
  const intercept = createFetchInterceptor(async (...args) => { calls.push(args); return new Response("OK", { headers }); },
    { origin: "http://localhost", getMode: () => "streaming", getLongDecode: () => legacyEnabled, onStatus: s => statuses.push(s) });
  await intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify(body) });
  assert.equal(calls.at(-1)[0], PLUGIN_PATH + "/generate");
  assert.equal(JSON.parse(calls.at(-1)[1].body).vertex_long_decode, true);
  assert.deepEqual(statuses.at(-1), { mode: "streaming", outputLimit: { requested: 100000, applied: 100000, longDecode: true } });
  legacyEnabled = false;
  await intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify({ ...body, vertex_long_decode: true }) });
  assert.equal(JSON.parse(calls.at(-1)[1].body).vertex_long_decode, undefined);
  // A request the plugin does not take keeps ST's route and body unchanged.
  const schema = { method: "POST", body: JSON.stringify({ ...body, json_schema: { type: "object" } }) };
  await intercept(GENERATE_PATH, schema);
  assert.deepEqual(calls.at(-1), [GENERATE_PATH, schema]);
  assert.deepEqual(statuses.at(-1), { bypass: "structured-output" });
});

test("a named preset tool reaches a capable server, and ineligible requests use ST's own route", async () => {
  const features = new Set([TOOLS_FEATURE, "custom-transport-tool-name"]);
  const requests = [], statuses = [];
  const wrapped = createFetchInterceptor(async (url, init) => {
    requests.push([url, JSON.parse(init.body)]);
    return Response.json({});
  }, { origin: "http://localhost", getMode: () => "streaming", getTransportToolName: () => "game_content",
    ensureBackend: feature => features.has(feature), onStatus: s => statuses.push(s) });
  const send = data => wrapped(GENERATE_PATH, { method: "POST", body: JSON.stringify(data) });
  const selected = { ...body, tools: [presetTextTool], tool_choice: { type: "function", function: { name: "game_content" } } };
  await assert.rejects(send(selected), /transport_tool_name_not_supported/);
  assert.equal(requests.length, 0);
  features.add(TRANSPORT_NAME_FEATURE);
  await send(selected);
  assert.equal(requests[0][0], PLUGIN_PATH + "/generate");
  assert.equal(requests[0][1].vertex_transport_tool_name, "game_content");
  assert.deepEqual(requests[0][1].tools, selected.tools);
  assert.deepEqual(prepareSillyTavernRequest({ body: requests[0][1] }, adapters).body.toolConfig.functionCallingConfig,
    { mode: "ANY", allowedFunctionNames: ["game_content"], streamFunctionCallArguments: true });
  for (const [data, reason] of [[body, "target-tool-missing"], [{ ...selected, tool_choice: "none" }, "target-tool-choice"],
    [{ ...selected, tools: [lookupTool, { type: "function", function: { name: "game_content" } }] }, "target-tool-schema"]]) {
    await send(data);
    assert.deepEqual(requests.at(-1), [GENERATE_PATH, data]);
    assert.equal(statuses.at(-1).bypass, reason);
  }
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

test("Unicode input falls back to the 我的行动 variable only when there is no user floor", async () => {
  const { latestUserInput } = await import("../integrations/sillytavern/shared.js");
  const vars = { 我的行动: "推开门" };
  assert.equal(latestUserInput([{ is_user: true, mes: "楼层" }], vars), "楼层");
  assert.equal(latestUserInput([{ is_user: false, mes: "开局" }], vars), "推开门");
  assert.equal(latestUserInput([{ is_user: true, mes: "" }], vars), "推开门");
  assert.equal(latestUserInput([], { 我的行动: 3 }), "");
  assert.equal(latestUserInput([], undefined), "");
});

test("single-floor card: Unicode encodes every copy of the 我的行动 text and keeps tag lines intact", async () => {
  const { latestUserInput } = await import("../integrations/sillytavern/shared.js");
  const calls = [], statuses = [];
  const chat = [{ is_user: false, mes: "<gametxt>上一轮</gametxt>" }], variables = { 我的行动: "我推开门" };
  const wrapped = createFetchInterceptor(async (...args) => { calls.push(args); return new Response("OK"); }, {
    origin: "http://localhost", getMode: () => "off", getUnicodeInput: () => true,
    getUserFloor: () => latestUserInput(chat, variables), onStatus: s => statuses.push(s) });
  const messages = [{ role: "system", content: "<new_user>\n我推开门\n</new_user>" },
    { role: "user", content: "[我的行动]我推开门\n" }, { role: "system", content: "<tag 我推开门>" }];
  await wrapped(GENERATE_PATH, { method: "POST", body: JSON.stringify({ ...body, messages }) });
  const sent = JSON.parse(calls.at(-1)[1].body).messages.map(message => message.content);
  const encoded = "⟦U:6211 63A8 5F00 95E8⟧";
  assert.deepEqual(sent, [`<new_user>\n${encoded}\n</new_user>`, `[我的行动]${encoded}\n`, "<tag 我推开门>"]);
  assert.equal(statuses.at(-1).unicode.reason, "encoded");
  assert.equal(statuses.at(-1).unicode.occurrences, 2);
});

test("image option forwards eligible plugin requests with the selected streaming mode", async () => {
  const calls = [], statuses = [];
  const intercept = createFetchInterceptor(async (...args) => { calls.push(args); return new Response("OK"); }, {
    origin: "http://localhost", getMode: () => "streaming", getImageInput: () => "current-turn", onStatus: s => statuses.push(s),
  });
  const post = payload => intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify(payload) });
  await post(body);
  const forwarded = JSON.parse(calls[0][1].body);
  assert.equal(forwarded.vertex_image_input, "current-turn");
  assert.equal(forwarded.stream, true);
  assert.equal(forwarded.vertex_anti_truncation, "streaming");
  await assert.rejects(post({ ...body, model: "gemini-3-pro-image" }), /image_input_requires/);
  assert.deepEqual(statuses.at(-1), { error: "image_input_requires_supported_request", bypass: "model" });
  await assert.rejects(post({ ...body, tools: [{ type: "function" }] }), /image_input_requires/);
  assert.equal(calls.length, 1);
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
  assert.deepEqual(statuses.at(-1), { error: "image_input_unsupported_characters", status: 400, message: "图片输入转换失败" });
  assert.deepEqual(await response.json(), failure);
  reply = () => new Response("<html>Cannot POST</html>", { status: 404 });
  await intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify(body) });
  assert.deepEqual(statuses.at(-1), { error: 404, status: 404 });
  reply = () => Response.json(failure, { status: 429 });
  await intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify({ ...body, tools: [{}] }) });
  assert.deepEqual(statuses.at(-1), { bypass: "tool-schema" });
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
  const invalid = await post({ vertex_anti_truncation: "off", vertex_image_input: "all", messages: [{ role: "user", content: "你好😀\0" }] });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.error.code, "image_input_unsupported_characters");
  assert.equal(invalid.error.character, "U+0000");
  assert.equal(invalid.error.param, "/messages/0/content");
  assert.match(invalid.error.message, /^图片输入转换失败/);
  assert.equal(upstream.length, 0);
  const rejected = await post({ vertex_anti_truncation: "off", vertex_image_input: "current-turn" });
  assert.equal(rejected.status, 429);
  assert.match(rejected.error.message, /^busy .*HTTP 429/);
  const wrapped = await post({ vertex_image_input: "current-turn" });
  assert.match(wrapped.error.message, /^busy .*HTTP 429/);
  assert.equal(upstream.length, 2);
});

test("Google rejections reach both Tavern's error.message and the extension panel", {timeout: 5000}, async t => {
  let upstream;
  const handler = createGenerateHandler(adapters, {fetchImpl: async (...args) => upstream(...args)});
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const bytes of req) chunks.push(bytes);
    req.body = JSON.parse(Buffer.concat(chunks).toString());
    req.user = {directories:{}};
    res.status = status => { res.statusCode = status; return res; };
    res.json = data => res.end(JSON.stringify(data));
    await handler(req, res);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = "http://127.0.0.1:" + server.address().port;
  const panel = [];
  const intercept = createFetchInterceptor((url, init) => fetch(new URL(url, origin), init),
    {origin, getMode:() => "streaming", onStatus: status => panel.push(status)});
  const send = stream => intercept(GENERATE_PATH, {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({...body,stream})});
  const feedback = { promptFeedback: {blockReason:"PROHIBITED_CONTENT", blockReasonMessage:"Prompt rejected by provider.",
    safetyRatings:[{category:"HARM_CATEGORY_HARASSMENT",blocked:true}]} };
  for (const [stream, reply, expected] of [
    [false, () => Response.json({error:{status:"INVALID_ARGUMENT",message:"The prompt could not be submitted."}}, {status:400}), /INVALID_ARGUMENT.*The prompt could not be submitted/],
    [false, () => Response.json(feedback), /Google 拒绝了输入.*PROHIBITED_CONTENT.*HARASSMENT.*Prompt rejected/],
    [true, () => Response.json(feedback), /PROHIBITED_CONTENT.*Prompt rejected/],
    [true, () => new Response(sseData(feedback)), /PROHIBITED_CONTENT.*Prompt rejected/],
  ]) {
    upstream = reply;
    const response = await send(stream);
    assert.equal(response.status,400);
    const result = await response.json();
    assert.match(result.error.message, expected);
    assert.equal(panel.at(-1).message,result.error.message);
  }
  let failStream;
  const bytes = new TextEncoder();
  upstream = (_url, init) => {
    const name = JSON.parse(init.body).tools[0].functionDeclarations[0].name;
    return new Response(new ReadableStream({start(controller) {
      controller.enqueue(bytes.encode(nativeCall({name,willContinue:true}) +
        nativeCall({partialArgs:[{jsonPath:"$.content",stringValue:"partial text",willContinue:true}],willContinue:true})));
      failStream = () => {
        controller.enqueue(bytes.encode(sseData({error:{code:429,status:"RESOURCE_EXHAUSTED",message:"Quota reached for fixture-api-key."}})));
        controller.close();
      };
    }}));
  };
  const response = await send(true);
  assert.equal(response.status,200);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let wire = "";
  while (!wire.includes("partial text")) {
    const read = await reader.read();
    assert.equal(read.done,false);
    wire += decoder.decode(read.value,{stream:true});
  }
  failStream();
  for (let read = await reader.read(); !read.done; read = await reader.read()) wire += decoder.decode(read.value,{stream:true});
  const records = events(wire);
  assert.match(records.at(-1).error.message,/429.*RESOURCE_EXHAUSTED.*Quota reached for \[key\].*流式错误/);
  assert.doesNotMatch(records.at(-1).error.message,/HTTP 502/);
  assert.equal(panel.at(-1).message, records.at(-1).error.message);
  assert.ok(records.some(record => record.candidates?.[0].content?.parts?.some(part => part.text?.includes("partial text"))));
});

test("image requests report the plugin's conversion outcome, including text sent unchanged", async t => {
  const statuses = [];
  let headers = { "x-image-input": "no-text", "x-image-input-pages": "0", "x-anti-truncation-transport": "native-streaming" };
  const intercept = createFetchInterceptor(async () => new Response("OK", { headers }), { origin: "http://localhost",
    getMode: () => "streaming", getImageInput: () => "current-turn", onStatus: s => statuses.push(s) });
  await intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify(body) });
  assert.deepEqual(statuses.at(-1), { mode: "streaming", image: { mode: "current-turn", reason: "no-text", pages: 0, transport: "native-streaming" } });
  headers = { "x-image-input": "encoded", "x-image-input-pages": "2", "x-anti-truncation-transport": "native-streaming" };
  await intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify(body) });
  assert.deepEqual(statuses.at(-1).image, { mode: "current-turn", reason: "encoded", pages: 2, transport: "native-streaming" });
  // An older backend may still buffer a request that ST wanted to stream.
  headers["x-anti-truncation-transport"] = "buffered";
  await intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify(body) });
  assert.equal(statuses.at(-1).image.transport, "buffered");

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

  const origin = "http://127.0.0.1:" + server.address().port;
  const withTarget = createFetchInterceptor((url, init) => fetch(new URL(url, origin), init), {
    origin, getMode: () => "streaming", getImageInput: () => "current-turn",
    getTransportToolName: () => "game_content", onStatus: state => statuses.push(state),
  });
  const response = await withTarget(GENERATE_PATH, { method: "POST", body: JSON.stringify(body) });
  assert.equal(contents(await response.text()), "OK");
  assert.equal(sent.at(-1).tools, undefined);
  assert.equal(statuses.at(-1).bypass, "target-tool-missing");
  assert.equal(statuses.at(-1).image.reason, "encoded");
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
  for (const [mode, image] of [["streaming", "off"], ["buffered", "off"], ["off", "current-turn"], ["off", "all"], ["streaming", "all"], ["streaming", "current-turn"]]) {
    for (const stream of [false, true]) {
      const count = sent.length;
      const response = await post({ vertex_anti_truncation: mode, vertex_image_input: image, stream });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-vertex-continuation"), "suffix");
      assert.equal(response.headers.get("x-anti-truncation-transport"), stream && mode === "streaming" ? "native-streaming" : "buffered");
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

test("client tools keep ST's route until the server plugin reports it understands them", async () => {
  const calls = [], statuses = [], asked = [];
  let features = [];
  const intercept = createFetchInterceptor(async (...args) => { calls.push(args); return new Response("OK"); }, { origin: "http://localhost",
    getMode: () => "streaming", onStatus: s => statuses.push(s),
    ensureBackend: async feature => { asked.push(feature); return !feature || features.includes(feature); } });
  const tools = { method: "POST", body: JSON.stringify({ ...body, tools: [lookupTool], tool_choice: "auto" }) };
  await intercept(GENERATE_PATH, tools);
  assert.deepEqual(calls.at(-1), [GENERATE_PATH, tools]);
  assert.deepEqual(statuses.at(-1), { bypass: "server-tools" });
  await intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify(body) });
  assert.equal(calls.at(-1)[0], PLUGIN_PATH + "/generate");
  features = PLUGIN_FEATURES;
  await intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify({ ...body, messages: [...body.messages, ...toolHistory] }) });
  assert.equal(calls.at(-1)[0], PLUGIN_PATH + "/generate");
  assert.deepEqual(asked, [TOOLS_FEATURE, TOOLS_FEATURE]);
  assert.ok(PLUGIN_FEATURES.includes(TOOLS_FEATURE));
});

test("the extension accepts any server plugin from the compatibility floor up, newer ones included", () => {
  assert.ok(compareVersions(MIN_SERVER_VERSION, PLUGIN_VERSION) <= 0);
  for (const [a, b, sign] of [["0.4.0", "0.3.1", 1], ["0.3.10", "0.3.9", 1], ["0.3.1", "0.3.1", 0], ["0.3.0", "0.3.1", -1], ["1.0", "0.9.9", 1], ["0.4", "0.4.0", 0]]) {
    assert.equal(Math.sign(compareVersions(a, b)), sign, `${a} vs ${b}`);
  }
});

test("the closing instruction leaves the tool-result turn that ST's converter merged it into", () => {
  // ST merges consecutive user-role messages, so the tool result and the instruction share a turn.
  const merging = { ...adapters, convertGooglePrompt: messages => ({ system_instruction: { parts: [] }, contents: [
    { role: "user", parts: [{ text: "查一下" }] }, { role: "model", parts: [{ functionCall: { name: "lookup", args: { query: "天气" } }, thoughtSignature: "sig-old" }] },
    { role: "user", parts: [{ functionResponse: { name: "lookup", response: { name: "lookup", content: "晴" } } }, { text: messages.at(-1).content }] }] }) };
  const prepared = prepareSillyTavernRequest(request({ messages: [...body.messages, ...toolHistory], tools: [lookupTool] }), merging);
  assert.deepEqual(prepared.body.contents.slice(-2).map(content => content.parts.map(part => Object.keys(part)[0])), [["functionResponse"], ["text"]]);
  assert.match(prepared.body.contents.at(-1).parts[0].text, /Transport format/);
  assert.deepEqual(prepared.body.contents.map(content => content.role), ["user", "model", "user", "user"]);
});
