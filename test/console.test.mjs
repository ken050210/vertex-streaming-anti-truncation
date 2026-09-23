import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createConsole } from "../src/console-server.mjs";
import { createSettingsStore } from "../src/settings-store.mjs";

async function freePort(t, keep = false) {
  const s = http.createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const port = s.address().port;
  if (keep) t.after(() => new Promise(resolve => s.close(resolve)));
  else await new Promise(resolve => s.close(resolve));
  return port;
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "vertex-console-test-"));
  const store = createSettingsStore({ directory, env: {} });
  const requests = [];
  const app = await createConsole({ store, fetchImpl: async (...args) => { requests.push(args); throw new Error("Unexpected inference"); }, ...options });
  await app.listen(0);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: app.bootstrapToken }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const csrf = (await login.json()).csrf;
  const api = (path, body, headers = {}) => fetch(base + path, { method: body === undefined ? "GET" : "POST",
    headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const settings = { authMode: "express", projectId: "optional-project", apiKey: "synthetic-express-credential", gatewayKey: "synthetic-local-console-key", port: await freePort(t) };
  return { app, store, directory, base, cookie, csrf, api, settings, requests };
}

test("console protects credentials and mutations with local Host, origin, session and CSRF checks", async t => {
  const f = await fixture(t);
  for (const path of ["/", "/app.js", "/app.css", "/favicon.svg"]) assert.equal((await fetch(f.base + path)).status, 200);
  assert.equal((await fetch(f.base + "/api/config")).status, 401);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(f.base + "/api/config", { headers: { host: "evil.example", cookie: f.cookie } }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
  });
  assert.equal(wrongHostStatus, 403);
  assert.equal((await f.api("/api/config", undefined, { origin: "https://evil.example" })).status, 403);
  assert.equal((await f.api("/api/config", { revision: "new", settings: f.settings }, { "x-csrf-token": "wrong" })).status, 403);
  assert.equal((await f.api("/api/probe", { confirm: false })).status, 400);
  assert.equal((await f.api("/api/validate", { settings: f.settings })).status, 200);
  assert.equal((await f.store.load()).saved, false);
  assert.equal(f.requests.length, 0);
});

test("console persists compatibility toggles and maximum escaped retry text without inference or logging text", async t => {
  const f = await fixture(t);
  const text = "Fixture context\n" + "\u0001".repeat(191984);
  assert.equal(Buffer.byteLength(text), 192000);
  const response = await f.api("/api/config", { revision: "new", settings: { ...f.settings,
    hideUnavailableModels: false, geminiPrefillToUser: false, geminiPromptRetryEnabled: true, geminiPromptRetryText: text } });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.settings.geminiPromptRetryText, text);
  assert.equal(saved.status.active.geminiPromptRetryEnabled, true);
  assert.equal((await f.store.load()).settings.geminiPromptRetryText, text);
  assert.equal((await (await f.api("/api/config")).json()).settings.geminiPrefillToUser, false);
  assert.deepEqual((await (await f.api("/api/events")).json()).events, []);
  assert.equal(f.requests.length, 0);
});

test("save/apply preserves write-only secrets, enforces revision checks and survives controller restart", async t => {
  const f = await fixture(t);
  const response = await f.api("/api/config", { revision: "new", settings: { ...f.settings, serviceTier: "flex" } });
  assert.equal(response.status, 200);
  let current = await response.json();
  assert.equal(current.status.running, true);
  assert.equal(current.status.active.serviceTier, "flex");
  const secretFree = JSON.stringify(current);
  for (const value of [f.settings.apiKey, f.settings.gatewayKey]) assert.equal(secretFree.includes(value), false);
  assert.equal(current.settings.apiKeySet, true);
  const updated = await f.api("/api/config", { revision: current.revision, settings: { apiKey: "", gatewayKey: "", serviceTier: "priority" } });
  assert.equal(updated.status, 200); current = await updated.json();
  assert.equal((await f.store.load()).settings.apiKey, f.settings.apiKey);
  assert.equal((await f.api("/api/config", { revision: "new", settings: f.settings })).status, 409);
  assert.equal((await f.api("/api/stop", {})).status, 200);
  assert.equal((await f.api("/api/start", {})).status, 200);
  assert.equal(f.app.status().active.serviceTier, "priority");
  await f.app.close();
  const restarted = await createConsole({ store: f.store, fetchImpl: () => assert.fail("No automatic inference") });
  t.after(() => restarted.close()); await restarted.listen(0);
  assert.equal(restarted.status().running, true);
  assert.equal(restarted.status().active.serviceTier, "priority");
  assert.equal(restarted.bootstrapToken, null);
  assert.equal(f.requests.length, 0);
});

test("invalid credentials, occupied ports and stale disk revisions cannot replace a working configuration", async t => {
  const f = await fixture(t);
  const initial = await (await f.api("/api/config", { revision: "new", settings: f.settings })).json();
  const before = await readFile(join(f.directory, "settings.json"), "utf8");
  for (const patch of [{ port: await freePort(t, true) }, { authMode: "service-account", serviceAccountJson: "invalid" }, { port: new URL(f.base).port }]) {
    assert.notEqual((await f.api("/api/config", { revision: initial.revision, settings: patch })).status, 200);
    assert.equal(await readFile(join(f.directory, "settings.json"), "utf8"), before);
    assert.equal(f.app.status().running, true);
    assert.equal(f.app.status().active.port, f.settings.port);
  }
  const current = await f.store.load();
  await f.store.save({ ...current.settings, timeoutMs: 120000 }, current.revision);
  assert.equal((await f.api("/api/config", { revision: initial.revision, settings: { serviceTier: "flex" } })).status, 409);
});

test("port changes release the original listener and hot applies affect the replacement listener", async t => {
  const f = await fixture(t);
  let result = await (await f.api("/api/config", { revision: "new", settings: f.settings })).json();
  const port = await freePort(t);
  result = await (await f.api("/api/config", { revision: result.revision, settings: { port } })).json();
  const newKey = "synthetic-rotated-local-key";
  result = await (await f.api("/api/config", { revision: result.revision, settings: { gatewayKey: newKey } })).json();
  assert.equal(result.status.active.port, port);
  const models = auth => fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: "Bearer " + auth } });
  assert.equal((await models(f.settings.gatewayKey)).status, 401);
  assert.equal((await models(newKey)).status, 200);
  assert.equal((await f.api("/api/logout", {})).status, 200);
  assert.equal((await f.api("/api/status")).status, 401);
});

test("hot application preserves an active stream's credentials and tier; stop refuses to interrupt it", { timeout: 5000 }, async t => {
  const calls = []; let output;
  const encode = data => new TextEncoder().encode("data: " + JSON.stringify(data) + "\n\n");
  const f = await fixture(t, { fetchImpl: async (url, request) => {
    calls.push(request.headers);
    const body = JSON.parse(request.body);
    const name = body.tools[0].functionDeclarations[0].name;
    if (!url.includes("streamGenerateContent")) return Response.json({ candidates: [{ content: { parts: [{ functionCall: { name, args: { content: "new request" } } }] }, finishReason: "STOP" }] });
    return new Response(new ReadableStream({ start(c) {
      output = c;
      c.enqueue(encode({ candidates: [{ content: { parts: [{ functionCall: { name, willContinue: true } }] } }] }));
      c.enqueue(encode({ candidates: [{ content: { parts: [{ functionCall: { partialArgs: [{ jsonPath: "$.content", stringValue: "first ", willContinue: true }], willContinue: true } }] } }] }));
    } }));
  } });
  const first = await (await f.api("/api/config", { revision: "new", settings: { ...f.settings, serviceTier: "flex" } })).json();
  const request = stream => fetch(`http://127.0.0.1:${f.settings.port}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer " + f.settings.gatewayKey, "content-type": "application/json" }, body: JSON.stringify({ model: "gemini-3.7-flash-antitruncation", stream, messages: [{ role: "user", content: "local test" }] }) });
  const response = await request(true), reader = response.body.getReader();
  let wire = new TextDecoder().decode((await reader.read()).value);
  assert.match(wire, /first/);
  assert.equal((await f.api("/api/stop", {})).status, 409);
  const changed = await f.api("/api/config", { revision: first.revision, settings: { serviceTier: "priority", apiKey: "synthetic-replacement-api-key" } });
  assert.equal(changed.status, 200);
  assert.equal((await request(false)).status, 200);
  assert.equal(calls[0]["x-vertex-ai-llm-shared-request-type"], "flex");
  assert.equal(calls[1]["x-vertex-ai-llm-shared-request-type"], "priority");
  assert.equal(calls[1]["x-goog-api-key"], "synthetic-replacement-api-key");
  output.enqueue(encode({ candidates: [{ content: { parts: [{ functionCall: { partialArgs: [{ jsonPath: "$.content", stringValue: "finished", willContinue: false }], willContinue: true } }] } }] }));
  output.enqueue(encode({ candidates: [{ content: { parts: [{ functionCall: {} }] } }] }));
  output.enqueue(encode({ candidates: [{ finishReason: "STOP" }], usageMetadata: { trafficType: "ON_DEMAND_FLEX" } })); output.close();
  for (;;) { const { done, value } = await reader.read(); if (done) break; wire += new TextDecoder().decode(value); }
  assert.match(wire, /finished/); assert.match(wire, /\[DONE\]/);
  const events = (await (await f.api("/api/events")).json()).events;
  assert.equal(events.find(e => e.stream).serviceTier, "flex");
  assert.equal(events.find(e => !e.stream).serviceTier, "priority");
});

test("console probe streams immediately, requires per-request consent and forwards cancellation", { timeout: 5000 }, async t => {
  let signal;
  const encode = v => new TextEncoder().encode("data: " + JSON.stringify(v) + "\n\n");
  const f = await fixture(t, { fetchImpl: async (_url, request) => {
    signal = request.signal;
    const name = JSON.parse(request.body).tools[0].functionDeclarations[0].name;
    return new Response(new ReadableStream({ start(c) {
      c.enqueue(encode({ candidates: [{ content: { parts: [{ functionCall: { name, willContinue: true } }] } }] }));
      c.enqueue(encode({ candidates: [{ content: { parts: [{ functionCall: { partialArgs: [{ jsonPath: "$.content", stringValue: "arrived early", willContinue: true }], willContinue: true } }] } }] }));
      signal.addEventListener("abort", () => c.error(new Error("cancelled")), { once: true });
    } }));
  } });
  await f.api("/api/config", { revision: "new", settings: f.settings });
  assert.equal((await f.api("/api/probe", { stream: true })).status, 400);
  assert.equal(signal, undefined);
  const response = await f.api("/api/probe", { stream: true, confirm: true });
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /arrived early/);
  await reader.cancel();
  for (let i = 0; i < 50 && !signal.aborted; i++) await delay(10);
  assert.equal(signal.aborted, true);
});

test("console probes the selected saved profile and rejects unknown aliases before inference", async t => {
  const calls = [];
  const f = await fixture(t, { fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    const name = body.tools?.[0]?.functionDeclarations?.[0]?.name;
    return Response.json({ candidates: [{ content: { parts: [{ functionCall: { name, args: { content: "Selected model" } } }] }, finishReason: "STOP" }] });
  } });
  const models = [
    { id: "normal-first", upstreamModel: "google/gemini-fixture-a", mode: "normal" },
    { id: "buffered-second", upstreamModel: "google/gemini-fixture-b", mode: "buffered" },
  ];
  assert.equal((await f.api("/api/config", { revision: "new", settings: { ...f.settings, models } })).status, 200);
  assert.equal((await f.api("/api/probe", { confirm: true, model: "missing" })).status, 400);
  assert.equal(calls.length, 0);
  const response = await f.api("/api/probe", { confirm: true, model: "buffered-second", stream: true });
  const wire = await response.text();
  assert.equal(response.status, 200); assert.match(wire, /Selected model/); assert.match(wire, /buffered-second/);
  assert.equal(calls.length, 1); assert.match(calls[0].url, /gemini-fixture-b:generateContent$/);
  assert.equal(calls[0].body.generationConfig.maxOutputTokens, 512);
});
