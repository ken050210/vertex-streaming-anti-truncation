import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, DEFAULT_SETTINGS, MODEL_ID, publicSettings } from "../src/config.mjs";
import { modelProfiles } from "../src/model-profiles.mjs";
import { discoverModels } from "../src/model-discovery.mjs";
import { createGatewayServer } from "../src/gateway.mjs";
import { createSettingsStore, mergeSettings } from "../src/settings-store.mjs";
import { createConsole } from "../src/console-server.mjs";

const credentials = { ...DEFAULT_SETTINGS, gatewayKey: "synthetic-models-local-key", authMode: "express", apiKey: "synthetic-models-express-key" };
const profiles = [
  { id: "正常-gemini-a", upstreamModel: "google/gemini-fixture-a", mode: "normal" },
  { id: "完整-gemini-a", upstreamModel: "google/gemini-fixture-a", mode: "buffered" },
  { id: "分段-gemini-a", upstreamModel: "google/gemini-fixture-a", mode: "streaming" },
  { id: "分段-gemini-b", upstreamModel: "google/gemini-fixture-b", mode: "streaming" },
];
const encode = value => new TextEncoder().encode("data: " + JSON.stringify(value) + "\n\n");
const records = wire => wire.split(/\r?\n/).filter(l => l.startsWith("data:") && !l.includes("[DONE]")).map(l => JSON.parse(l.slice(5)));
const visible = wire => records(wire).flatMap(r => r.choices || []).map(c => c.delta?.content || "").join("");

test("model profiles preserve legacy modes, normalize IDs and reject duplicates, unsafe paths and invalid modes", () => {
  assert.equal(modelProfiles(null)[0].id, MODEL_ID);
  assert.equal(modelProfiles(null, false)[0].mode, "normal");
  assert.deepEqual(modelProfiles([]), []);
  assert.equal(modelProfiles([{ ...profiles[0], upstreamModel: "publishers/google/models/gemini-fixture-a" }])[0].upstreamModel, profiles[0].upstreamModel);
  assert.deepEqual(buildConfig({ ...credentials, models: profiles, antiTruncation: false }).models, profiles);
  for (const value of [[profiles[0], profiles[0]], [{ ...profiles[0], id: "contains space" }],
    [{ ...profiles[0], upstreamModel: "gemini-a/../../metadata" }], [{ ...profiles[0], upstreamModel: "https://example.invalid" }],
    [{ ...profiles[0], mode: "unknown" }], [{ ...profiles[0], secret: "unexpected" }], Array(101).fill(profiles[0])]) assert.throws(() => modelProfiles(value));
  assert.equal(publicSettings(credentials).models[0].mode, "streaming");
});

test("discovery lists all pages with selected auth, deduplicates Gemini models and never sends inference or tier headers", async () => {
  for (const authMode of ["express", "access-token"]) {
    const config = buildConfig({ ...credentials, authMode, projectId: "example-project", accessToken: "synthetic-models-oauth", serviceTier: "priority" });
    const requests = [];
    const result = await discoverModels(config, { fetchImpl: async (input, init) => {
      const url = new URL(input); requests.push({ url, init });
      assert.equal(url.host, "aiplatform.googleapis.com");
      assert.equal(url.pathname, "/v1beta1/publishers/google/models");
      assert.equal(init.method, "GET"); assert.equal(init.body, undefined);
      assert.equal(url.searchParams.get("listAllVersions"), "true");
      assert.equal(init.headers["x-vertex-ai-llm-shared-request-type"], undefined);
      assert.equal(init.headers[authMode === "express" ? "x-goog-api-key" : "authorization"], authMode === "express" ? credentials.apiKey : "Bearer synthetic-models-oauth");
      return Response.json(requests.length === 1 ? { publisherModels: [
        { name: "publishers/google/models/gemini-fixture-b", displayName: "Fixture B" }, { name: "publishers/google/models/imagen-fixture" },
        { name: "publishers/google/models/gemini-evil/../../" },
      ], nextPageToken: "next/page&token" } : { publisherModels: [
        { name: "publishers/google/models/gemini-fixture-a" }, { name: "publishers/google/models/gemini-fixture-b" },
      ] });
    } });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url.searchParams.get("pageToken"), "next/page&token");
    assert.deepEqual(result.models.map(m => m.id), ["gemini-fixture-a", "gemini-fixture-b"]);
    assert.equal(result.source, "vertex-publisher-catalog");
  }
});

test("discovery reports redacted failures, rejects broken pagination and cannot return partial catalogs", async () => {
  const config = buildConfig(credentials);
  await assert.rejects(discoverModels({ ...config, accessToken: async () => { throw new Error("private provider detail"); } }),
    error => error.status === 502 && error.message === "Model list authentication failed; check the selected credentials");
  await assert.rejects(discoverModels(config, { fetchImpl: async () => new Response("secret response text", { status: 403 }) }), error => /Express.*HTTP 403/.test(error.message) && !error.message.includes("secret response"));
  await assert.rejects(discoverModels(config, { fetchImpl: async () => { throw new Error(credentials.apiKey); } }), error => !error.message.includes(credentials.apiKey));
  await assert.rejects(discoverModels(config, { fetchImpl: async () => Response.json({ publisherModels: {}, nextPageToken: "x" }) }), /Invalid model catalog/);
  let requests = 0;
  await assert.rejects(discoverModels(config, { fetchImpl: async () => { requests++; return Response.json({ publisherModels: [{ name: "gemini-fixture-a" }], nextPageToken: "same" }); } }), /pagination/);
  assert.equal(requests, 2);
  requests = 0;
  await assert.rejects(discoverModels(config, { fetchImpl: async () => Response.json({ nextPageToken: String(++requests) }) }), /page limit/);
  assert.equal(requests, 20);
  assert.deepEqual((await discoverModels(config, { fetchImpl: async () => Response.json({}) })).models, []);
});

async function gateway(t, authMode = "express", mock) {
  const config = buildConfig({ ...credentials, authMode, projectId: "example-project", accessToken: "synthetic-oauth", models: profiles });
  const requests = [], events = [];
  const server = createGatewayServer(config, { logger: e => events.push(e), fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body), request = { url, options, body }; requests.push(request);
    if (mock) return mock(request);
    const native = !url.endsWith("/chat/completions");
    const stream = native ? url.includes(":streamGenerateContent") : body.stream;
    const name = native ? body.tools?.[0]?.functionDeclarations?.[0]?.name : body.tools?.[0]?.function?.name;
    const text = body.generationConfig?.responseMimeType === "application/json" ? '{"ok":true}' : "完整正文：你好 🌊";
    if (!stream) return Response.json(native ? {
      candidates: [{ index: 0, content: { role: "model", parts: [name ? { functionCall: { name, args: { content: text } } } : { text }] }, finishReason: "MAX_TOKENS" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12, trafficType: "ON_DEMAND" },
    } : { id: "fixture", model: body.model, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: name ? null : text,
      ...(name ? { tool_calls: [{ id: "fixture-call", type: "function", function: { name, arguments: JSON.stringify({ content: text }) } }] } : {}) }, finish_reason: "length" }], usage: { total_tokens: 12 } });
    const partial = body.toolConfig?.functionCallingConfig?.streamFunctionCallArguments;
    const data = native ? [
      { candidates: [{ index: 0, content: { parts: [name ? { functionCall: { name, ...(partial ? { partialArgs: [{ jsonPath: "$.content", stringValue: text, willContinue: false }], willContinue: false } : { args: { content: text } }) } } : { text }] } }] },
      { candidates: [{ index: 0, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 12 } },
    ].map(encode) : [encode({ id: "fixture", model: body.model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }),
      encode({ id: "fixture", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), new TextEncoder().encode("data: [DONE]\n\n")];
    return new Response(new ReadableStream({ start(c) { for (const bytes of data) c.enqueue(bytes); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
  } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (model, stream, extra = {}) => fetch(base + "/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer " + credentials.gatewayKey, "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "Fixture" }], stream, ...extra }) });
  return { config, base, post, requests, events };
}

test("saved aliases route different upstreams and three modes in JSON and SSE for Express and OAuth", async t => {
  for (const authMode of ["express", "access-token"]) {
    const f = await gateway(t, authMode);
    const list = await (await fetch(f.base + "/v1/models", { headers: { authorization: "Bearer " + credentials.gatewayKey } })).json();
    assert.deepEqual(list.data.map(m => m.id), profiles.map(m => m.id));
    for (const profile of profiles) for (const stream of [false, true]) {
      const response = await f.post(profile.id, stream, { stream_options: { include_usage: true } });
      assert.equal(response.status, 200);
      const request = f.requests.at(-1), native = !request.url.endsWith("/chat/completions");
      if (native) assert.ok(request.url.includes(profile.upstreamModel.slice(7) + ":"));
      else assert.equal(request.body.model, profile.upstreamModel);
      assert.equal(Boolean(request.body.tools), profile.mode !== "normal");
      const upstreamStream = stream && profile.mode !== "buffered";
      if (native) assert.equal(request.url.includes(":streamGenerateContent"), upstreamStream);
      else assert.equal(request.body.stream, upstreamStream);
      if (!upstreamStream) assert.equal(request.body.stream_options, undefined);
      if (stream) {
        const wire = await response.text(), rows = records(wire);
        assert.match(visible(wire), /完整正文：你好 🌊/); assert.match(wire, /\[DONE\]/);
        assert.ok(rows.every(r => r.model == null || r.model === profile.id));
        assert.equal(rows.flatMap(r => r.choices || []).find(c => c.finish_reason)?.finish_reason, profile.mode === "buffered" ? "length" : "stop");
        if (profile.mode === "buffered") { assert.ok(rows.some(r => r.usage?.total_tokens === 12)); assert.ok(rows.some(r => r.router_anti_truncation?.restored)); }
        if (profile.mode === "streaming") assert.equal(request.body.toolConfig.functionCallingConfig.streamFunctionCallArguments, true);
      } else {
        const body = await response.json(); assert.equal(body.model, profile.id); assert.match(body.choices[0].message.content, /完整正文/); assert.equal(body.choices[0].finish_reason, "length");
        assert.equal(body.router_anti_truncation?.restored === true, profile.mode !== "normal");
      }
      assert.equal(f.events.at(-1).mode, profile.mode); assert.equal(f.events.at(-1).model, profile.id); assert.equal(f.events.at(-1).upstreamModel, profile.upstreamModel);
      assert.equal(f.events.at(-1).antiTruncation.finishReason, !stream || profile.mode === "buffered" ? "length" : "stop");
      if (stream) assert.equal(f.events.at(-1).antiTruncation.streamDone, true);
    }
    const count = f.requests.length;
    assert.equal((await f.post("not-saved", true)).status, 400);
    assert.equal(f.requests.length, count);
  }
});

test("buffered aliases bypass wrapping for structured output and real tools while preserving client streaming", async t => {
  const f = await gateway(t);
  for (const extra of [{ response_format: { type: "json_object" } }, { tools: [{ type: "function", function: { name: "real_tool", parameters: { type: "object" } } }] }]) {
    const response = await f.post(profiles[1].id, true, extra);
    assert.equal(response.status, 200); assert.match(await response.text(), /\[DONE\]/);
    assert.ok(f.requests.at(-1).url.includes(":streamGenerateContent"));
    assert.equal(f.requests.at(-1).body.toolConfig?.functionCallingConfig?.streamFunctionCallArguments, undefined);
    assert.equal(f.events.at(-1).antiTruncation.restored, false);
  }
});

test("normal compatible streams reject premature EOF and provider error events", { timeout: 5000 }, async t => {
  for (const ending of ["eof", "error"]) {
    let upstream;
    const f = await gateway(t, "access-token", () => new Response(new ReadableStream({ start(controller) {
      upstream = controller;
      controller.enqueue(encode({ model: "google/gemini-fixture-a", choices: [{ index: 0, delta: { content: "first part" }, finish_reason: null }] }));
    } })));
    const response = await f.post(profiles[0].id, true), reader = response.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /first part/);
    if (ending === "error") upstream.enqueue(encode({ error: { message: "private provider error" } }));
    upstream.close();
    await assert.rejects(async () => { while (!(await reader.read()).done) { /* Drain until the failure. */ } });
    assert.equal(f.events.at(-1).status, 502);
    assert.equal(f.events.at(-1).code, "upstream_protocol_error");
    assert.equal(f.events.at(-1).antiTruncation.streamDone, false);
    assert.equal(JSON.stringify(f.events).includes("private provider error"), false);
  }
});

test("profiles persist across console restart; discovery never mutates settings or generates", async t => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-models-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createSettingsStore({ directory, env: {} });
  // A v1 settings file written before profiles existed remains readable.
  const legacy = { ...credentials }; delete legacy.models;
  await writeFile(join(directory, "settings.json"), JSON.stringify({ version: 1, settings: { ...legacy, antiTruncation: false } }));
  const old = await store.load(); assert.equal(buildConfig(old.settings).models[0].mode, "normal");
  const calls = [];
  let app = await createConsole({ store, autoStart: false, fetchImpl: async (url, init) => {
    calls.push({ url, init }); assert.equal(init.method, "GET"); return Response.json({ publisherModels: [{ name: "publishers/google/models/gemini-fixture-a" }] });
  } });
  await app.listen(0); t.after(() => app.close());
  let base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: credentials.gatewayKey }) });
  const cookie = login.headers.get("set-cookie").split(";")[0], csrf = (await login.json()).csrf;
  const api = (path, body, overrides = {}) => fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json", ...overrides }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const raw = await readFile(join(directory, "settings.json"), "utf8");
  assert.equal((await api("/api/models/discover", { settings: {} }, { "x-csrf-token": "wrong" })).status, 403);
  const catalog = await (await api("/api/models/discover", { settings: { gatewayKey: "", models: [{ id: "unfinished" }] } })).json();
  assert.equal(catalog.models.length, 1); assert.equal(calls.length, 1);
  assert.equal(await readFile(join(directory, "settings.json"), "utf8"), raw);
  const portHolder = createGatewayServer(buildConfig(credentials)); portHolder.listen(0, "127.0.0.1"); await once(portHolder, "listening");
  const port = portHolder.address().port; await new Promise(resolve => portHolder.close(resolve));
  const savedResponse = await api("/api/config", { revision: old.revision, settings: { models: profiles, port } });
  assert.equal(savedResponse.status, 200); const saved = await savedResponse.json();
  assert.deepEqual(saved.settings.models, profiles);
  assert.equal(JSON.stringify(saved).includes(credentials.apiKey), false);
  assert.equal((await api("/api/probe", { confirm: true, model: "not-saved" })).status, 400);
  assert.equal((await api("/api/probe", { confirm: false, model: profiles[0].id })).status, 400);
  assert.equal(calls.length, 1);
  await app.close(); app = await createConsole({ store, fetchImpl: () => assert.fail("No inference") }); await app.listen(0);
  assert.deepEqual(app.status().models, profiles);
  assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: "Bearer " + credentials.gatewayKey } })).json()).data.map(m => m.id), profiles.map(m => m.id));
  const current = await store.load(); await store.save(mergeSettings(current.settings, { models: [] }), current.revision);
  assert.deepEqual(buildConfig((await store.load()).settings).models, []);
});
