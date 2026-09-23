import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, DEFAULT_SETTINGS, loadConfig, publicSettings } from "../src/config.mjs";
import { createSettingsStore, mergeSettings } from "../src/settings-store.mjs";
import { createGatewayServer } from "../src/gateway.mjs";
import { convertGeminiPrefill, fetchWithGeminiRecovery, compatibilityLogFields } from "../src/gemini-compat.mjs";

const phrase = "The prompt could not be submitted. Fixture rejection.";
const errorBody = { error: { code: 400, message: phrase, status: "INVALID_ARGUMENT" } };
const context = "Private custom retry context.\n".repeat(1000);
const credentials = { ...DEFAULT_SETTINGS, authMode: "access-token", projectId: "example-project",
  gatewayKey: "synthetic-roleplay-local-key", accessToken: "synthetic-roleplay-oauth", apiKey: "synthetic-roleplay-express" };
const profile = { id: "roleplay", upstreamModel: "google/gemini-3.8-flash", mode: "normal" };
const payload = () => ({ model: profile.id, messages: [{ role: "system", content: "System rules" },
  { role: "developer", content: "Developer rules" }, { role: "user", content: "Start" },
  { role: "assistant", content: "Earlier answer" }, { role: "user", content: "Continue" },
  { role: "assistant", content: "A narrative prefix" }], temperature: 0.8 });
const encode = value => new TextEncoder().encode("data: " + JSON.stringify(value) + "\n\n");
const sse = (...records) => new Response(new ReadableStream({
  start(c) { for (const record of records) c.enqueue(encode(record)); c.close(); },
}), { headers: { "content-type": "text/event-stream" } });
const regular = text => ({ choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });
function success({ url, body }, text = "Fixture answer") {
  const native = !url.endsWith("/chat/completions");
  const name = native ? body.tools?.[0]?.functionDeclarations?.[0]?.name : body.tools?.[0]?.function?.name;
  const stream = native ? url.includes(":streamGenerateContent") : body.stream;
  if (native) {
    const part = name ? { functionCall: { name, args: { content: text } } } : { text };
    const result = { candidates: [{ index: 0, content: { role: "model", parts: [part] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, trafficType: "ON_DEMAND" } };
    return stream ? sse(result) : Response.json(result);
  }
  const message = name ? { role: "assistant", tool_calls: [{ id: "fixture-tool", type: "function",
    function: { name, arguments: JSON.stringify({ content: text }) } }] } : { role: "assistant", content: text };
  const finish = name ? "tool_calls" : "stop";
  if (!stream) return Response.json({ choices: [{ index: 0, message, finish_reason: finish }], usage: { total_tokens: 16 } });
  return new Response("data: " + JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: finish }] }) +
    "\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
async function fixture(t, respond = call => success(call), settings = {}) {
  let config = buildConfig({ ...credentials, models: [profile], ...settings });
  const calls = [], events = [];
  const server = createGatewayServer(() => config, { logger: event => events.push(event), fetchImpl: async (url, init) => {
    const call = { url, headers: init.headers, body: JSON.parse(init.body), signal: init.signal };
    calls.push(call); return respond(call, calls.length);
  } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + server.address().port;
  const headers = { authorization: "Bearer " + config.gatewayKey, "content-type": "application/json" };
  return { calls, events, server, get config() { return config; },
    apply: patch => { config = buildConfig({ ...credentials, models: [profile], ...settings, ...patch }); },
    post: (body = payload()) => fetch(base + "/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(body) }),
    list: async () => (await (await fetch(base + "/v1/models", { headers })).json()).data.map(m => m.id),
  };
}

test("prefill conversion preserves history and only converts plain-text trailing 3.7/3.8 Flash assistant messages", () => {
  const original = payload(), copy = structuredClone(original);
  for (const model of ["gemini-3.7-flash", "google/gemini-3.8-flash", "google/gemini-3.8-flash-preview", "google/gemini-3.8-flash@001"]) {
    const result = convertGeminiPrefill(original, model, true);
    assert.equal(result.converted, true);
    assert.deepEqual(result.payload.messages.at(-1), { ...original.messages.at(-1), role: "user" });
    assert.deepEqual(result.payload.messages.slice(0, -1), original.messages.slice(0, -1));
  }
  assert.deepEqual(original, copy);
  assert.equal(convertGeminiPrefill(original, "gemini-3-flash", true).payload, original);
  assert.equal(convertGeminiPrefill(original, "gemini-3.8-flash", false).payload, original);
  for (const last of [{ role: "assistant", content: "  " }, { role: "assistant", content: "text", reasoning_content: "thought" },
    { role: "assistant", content: "text", tool_calls: [] }, { role: "assistant", content: [{ type: "image_url", image_url: {} }] }]) {
    const request = { messages: [last] };
    assert.equal(convertGeminiPrefill(request, "gemini-3.8-flash", true).payload, request);
  }
  const parts = { messages: [{ role: "assistant", name: "Narrator", content: [{ type: "text", text: "前文" }] }] };
  assert.equal(convertGeminiPrefill(parts, "gemini-3.7-flash", true).payload.messages[0].role, "user");
});

test("model visibility hides disabled routes and rejected credentials while preserving temporary failures", async t => {
  let status = 429;
  const f = await fixture(t, call => status === 200 ? success(call) : new Response("Fixture failure", { status }), {
    models: [profile, { ...profile, id: "disabled", enabled: false }],
  });
  assert.deepEqual(await f.list(), ["roleplay"]); assert.equal(f.calls.length, 0);
  const disabled = await f.post({ ...payload(), model: "disabled" });
  assert.equal(disabled.status, 503); await disabled.text(); assert.equal(f.calls.length, 0);
  for (status of [403, 404, 408, 429, 500, 503]) {
    const response = await f.post(); assert.equal(response.status, status); await response.text();
    assert.deepEqual(await f.list(), ["roleplay"]);
  }
  status = 401;
  const rejected = await f.post(); assert.equal(rejected.status, 401); await rejected.text();
  assert.deepEqual(await f.list(), []);
  assert.equal(f.server.modelAvailability()[0].reason, "authentication_failed");
  f.config.hideUnavailableModels = false;
  assert.deepEqual(await f.list(), ["roleplay", "disabled"]);
  f.config.hideUnavailableModels = true;
  f.apply({});
  assert.deepEqual(await f.list(), ["roleplay"]);
  const again = await f.post(); await again.text(); assert.deepEqual(await f.list(), []);
  status = 200;
  const recovered = await f.post(); await recovered.text();
  assert.deepEqual(await f.list(), ["roleplay"]);
});

for (const authMode of ["access-token", "express"]) for (const mode of ["normal", "buffered", "streaming"]) {
  for (const stream of [false, true]) test("one retry preserves exact text, prefill and transport: " + authMode + "/" + mode + "/" + stream, async t => {
    const f = await fixture(t, (call, count) => count === 1 ? Response.json(errorBody, { status: 400 }) : success(call), {
      authMode, models: [{ ...profile, mode }], geminiPromptRetryEnabled: true, geminiPromptRetryText: context,
    });
    const response = await f.post({ ...payload(), stream });
    assert.equal(response.status, 200); assert.match(await response.text(), /Fixture answer/);
    assert.equal(response.headers.get("x-gemini-prefill-converted"), "true");
    assert.equal(response.headers.get("x-gemini-prompt-retried"), "true");
    assert.equal(f.calls.length, 2);
    const [first, retry] = f.calls;
    assert.equal(first.url, retry.url); assert.deepEqual(first.headers, retry.headers);
    const native = Boolean(first.body.contents);
    if (native) {
      assert.deepEqual(retry.body.systemInstruction, first.body.systemInstruction);
      assert.equal(retry.body.contents[0].role, "user");
      assert.equal(retry.body.contents[0].parts[0].text, context);
      assert.ok(first.body.contents.some(row => row.role === "user" && row.parts.some(part => part.text === "A narrative prefix")));
    } else {
      assert.deepEqual(retry.body.messages.slice(0, 2), first.body.messages.slice(0, 2));
      assert.deepEqual(retry.body.messages[2], { role: "user", content: context });
      assert.deepEqual(retry.body.messages.slice(3), first.body.messages.slice(2));
      assert.equal(first.body.messages.find(row => row.content === "A narrative prefix").role, "user");
    }
    assert.deepEqual(retry.body.tools, first.body.tools);
    const event = f.events.at(-1);
    assert.deepEqual(event.geminiCompatibility, { prefillConverted: true, promptRetried: true });
    assert.equal(event.responseIntegrity.outcome, "complete");
    assert.equal(event.antiTruncation.restored, mode !== "normal");
    for (const value of [context, "A narrative prefix", "Fixture answer", credentials.accessToken]) {
      assert.equal(JSON.stringify(f.events).includes(value), false);
    }
  });
}

test("HTTP-200 JSON errors and fragmented early SSE errors recover; a second rejection stops", async t => {
  for (const kind of ["json200", "sse", "repeated"]) {
    const f = await fixture(t, (call, count) => {
      if (count > 1 && kind !== "repeated") return success(call);
      if (kind === "json200") return Response.json(errorBody);
      if (kind === "repeated") return Response.json(errorBody, { status: 503 });
      const wire = 'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\r\n\r\nevent: error\r\ndata: ' + JSON.stringify(errorBody) + "\r\n\r\n";
      return new Response(new ReadableStream({ start(c) {
        for (let i = 0; i < wire.length; i += 7) c.enqueue(new TextEncoder().encode(wire.slice(i, i + 7)));
        c.close();
      } }), { headers: { "content-type": "text/event-stream" } });
    }, { geminiPromptRetryEnabled: true, geminiPromptRetryText: context });
    const response = await f.post({ ...payload(), stream: kind === "sse" });
    assert.equal(response.status, kind === "repeated" ? 503 : 200);
    const text = await response.text();
    assert.equal(f.calls.length, 2);
    if (kind === "repeated") assert.equal(JSON.parse(text).error.code, "prompt_submission_failed");
    else { assert.match(text, /Fixture answer/); assert.equal(text.includes(phrase), false); }
  }
});

test("matching is case-insensitive but literal, scoped to error fields and bounded before real output", async () => {
  const cases = [
    [400, errorBody, true], [400, [errorBody], true], [400, { message: phrase }, true],
    [400, "Error: THE PROMPT COULD NOT BE SUBMITTED.", true], [200, { error: phrase }, true],
    [400, { error: { message: "The prompt  could not be submitted" } }, false],
    [400, { error: { message: "The prompt couldn't be submitted" } }, false],
    [400, { data: errorBody }, false], [200, { message: phrase }, false], [200, regular(phrase), false],
    [400, "x".repeat(65536) + phrase, false],
  ];
  for (const [status, body, retry] of cases) {
    let calls = 0;
    const result = await fetchWithGeminiRecovery(async () => {
      calls++; return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }, payload(), profile.upstreamModel, { settings: { enabled: true, text: context } });
    await result.text(); assert.equal(calls, retry ? 2 : 1);
  }
});

test("disabled recovery, unrelated errors, quoted dialogue and request-size limits never add submissions", async t => {
  for (const kind of ["off", "unrelated", "quoted", "body-limit"]) {
    const f = await fixture(t, call => kind === "quoted" ? success(call, phrase) :
      Response.json(kind === "unrelated" ? { error: { message: "Invalid parameter" } } : errorBody, { status: 400 }), {
      geminiPrefillToUser: false, geminiPromptRetryEnabled: kind !== "off", geminiPromptRetryText: context,
    });
    if (kind === "body-limit") f.config.bodyLimitBytes = 2000;
    const response = await f.post(); await response.text();
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.messages.at(-1).role, "assistant");
  }
});

test("real HTTP output stays progressive and a later submission error cannot retry", { timeout: 5000 }, async t => {
  let upstream;
  const f = await fixture(t, () => new Response(new ReadableStream({ start(c) {
    upstream = c; c.enqueue(encode({ choices: [{ index: 0, delta: { content: "First part" }, finish_reason: null }] }));
  } }), { headers: { "content-type": "text/event-stream" } }), {
    geminiPromptRetryEnabled: true, geminiPromptRetryText: context,
  });
  const response = await f.post({ ...payload(), stream: true }), reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /First part/);
  upstream.enqueue(encode(errorBody)); upstream.close();
  await assert.rejects(async () => { while (!(await reader.read()).done) { /* Await protocol failure. */ } });
  assert.equal(f.calls.length, 1); assert.equal(f.events.at(-1).status, 502);
  assert.equal(f.events.at(-1).geminiCompatibility.promptRetried, false);
});

test("cancelled and already-retried requests do not replay and logging projects only booleans", async () => {
  let calls = 0;
  const send = async () => { calls++; return Response.json(errorBody, { status: 400 }); };
  const options = { settings: { enabled: true, text: context }, state: { used: true } };
  await (await fetchWithGeminiRecovery(send, payload(), profile.upstreamModel, options)).text();
  const abort = new AbortController(); abort.abort();
  await (await fetchWithGeminiRecovery(send, payload(), profile.upstreamModel, { ...options, state: { used: false }, signal: abort.signal })).text();
  assert.equal(calls, 2);
  assert.deepEqual(compatibilityLogFields({ prefillConverted: true, promptRetried: true, text: context }),
    { geminiCompatibility: { prefillConverted: true, promptRetried: true } });
});

test("new defaults migrate old settings, reject unsafe input and persist exact custom text and toggles", async t => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-roleplay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = { ...credentials };
  for (const name of ["hideUnavailableModels", "geminiPrefillToUser", "geminiPromptRetryEnabled", "geminiPromptRetryText"]) delete legacy[name];
  await writeFile(join(directory, "settings.json"), JSON.stringify({ version: 1, settings: legacy }));
  const store = createSettingsStore({ directory, env: {} }), loaded = await store.load();
  assert.equal(loaded.settings.hideUnavailableModels, true); assert.equal(loaded.settings.geminiPrefillToUser, true);
  assert.equal(loaded.settings.geminiPromptRetryEnabled, false);
  for (const patch of [{ hideUnavailableModels: "false" }, { geminiPrefillToUser: 0 }, { geminiPromptRetryEnabled: true },
    { geminiPromptRetryText: "字".repeat(64001) }, { models: [{ ...profile, enabled: "false" }] }]) {
    assert.throws(() => mergeSettings(loaded.settings, patch));
  }
  const exact = "\n  自定义文本\n" + context + "\n";
  const next = mergeSettings(loaded.settings, { hideUnavailableModels: false, geminiPrefillToUser: false,
    geminiPromptRetryEnabled: true, geminiPromptRetryText: exact, models: [{ ...profile, enabled: false }] });
  await store.save(next, loaded.revision);
  const saved = await createSettingsStore({ directory, env: {} }).load();
  assert.equal(saved.settings.geminiPromptRetryText, exact); assert.equal(saved.settings.models[0].enabled, false);
  assert.equal(buildConfig(saved.settings).geminiPromptRetry.text, exact);
  assert.equal(publicSettings(saved.settings).accessToken, undefined);
  const file = join(directory, "context.txt"); await writeFile(file, exact);
  const config = await loadConfig({ GATEWAY_API_KEY: credentials.gatewayKey, VERTEX_PROJECT_ID: credentials.projectId,
    VERTEX_ACCESS_TOKEN: credentials.accessToken, GEMINI_PROMPT_RETRY_ENABLED: "true", GEMINI_PROMPT_RETRY_TEXT_FILE: file,
    HIDE_UNAVAILABLE_MODELS: "false", GEMINI_PREFILL_TO_USER: "false" });
  assert.equal(config.geminiPromptRetry.text, exact); assert.equal(config.hideUnavailableModels, false);
  assert.equal(config.geminiPrefillToUser, false);
});
