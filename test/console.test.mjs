import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile, utimes, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createConsole } from "../src/console-server.mjs";
import { upstreamDispatcher } from "../src/gateway.mjs";
import { createSettingsStore } from "../src/settings-store.mjs";
import { loadNetworkConfig } from "../src/network-config.mjs";

test("container console supports an explicit HTTPS origin without weakening login or CSRF", async t => {
  const network = loadNetworkConfig({ LISTEN_HOST: "0.0.0.0", GUI_ORIGIN: "https://console.example", GATEWAY_PUBLIC_URL: "https://api.example/v1" });
  const f = await fixture(t, { network });
  assert.equal(f.app.server.address().address, "0.0.0.0");
  const request = (path, body, extra = {}) => new Promise((resolve, reject) => {
    const req = http.request(f.base + path, { method: body === undefined ? "GET" : "POST",
      headers: { host: "console.example", origin: "https://console.example", "content-type": "application/json", ...extra } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  assert.equal((await request("/api/config")).status, 401);
  assert.equal((await request("/api/login", { key: f.app.bootstrapToken }, { origin: "https://evil.example" })).status, 403);
  const login = await request("/api/login", { key: f.app.bootstrapToken });
  assert.equal(login.status, 200);
  assert.match(login.headers["set-cookie"][0], /; Secure;/);
  const cookie = login.headers["set-cookie"][0].split(";")[0];
  const headers = { cookie, "x-csrf-token": login.body.csrf };
  assert.equal((await request("/api/config", { revision: "new", settings: f.settings }, { cookie })).status, 403);
  const saved = await request("/api/config", { revision: "new", settings: f.settings }, headers);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.status.network, { listenHost: "0.0.0.0", gatewayPublicUrl: "https://api.example/v1" });
  assert.equal((await fetch(`http://127.0.0.1:${f.settings.port}/healthz`)).status, 200);
  assert.equal((await request("/api/logout", {}, headers)).status, 200);
  assert.equal(f.requests.length, 0);
});

async function freePort(t, keep = false) {
  const s = http.createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const port = s.address().port;
  if (keep) t.after(() => new Promise(resolve => s.close(resolve)));
  else await new Promise(resolve => s.close(resolve));
  return port;
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "vertex-console-test-"));
  const store = createSettingsStore({ directory, env: options.env ?? {} });
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

test("weak and keyless access require confirmation, persist across restart and can be secured again", async t => {
  for (const mode of ["weak", "none"]) await t.test(mode, async t => {
    const f = await fixture(t);
    const initial = await (await f.api("/api/config", { revision: "new", settings: f.settings })).json();
    const settings = { gatewayKeyMode: mode, gatewayKey: mode === "weak" ? "123456" : null };
    for (const confirmation of [undefined, false, "true"]) {
      const denied = await f.api("/api/config", { revision: initial.revision, settings, confirmGatewayAccess: confirmation });
      assert.equal(denied.status, 400);
      assert.match((await denied.json()).error.message, /Confirm the risks/);
      assert.equal((await f.store.load()).revision, initial.revision);
      assert.equal((await fetch(`http://127.0.0.1:${f.settings.port}/v1/models`)).status, 401);
    }
    const applied = await f.api("/api/config", { revision: initial.revision, settings, confirmGatewayAccess: true });
    assert.equal(applied.status, 200);
    const saved = await applied.json();
    assert.equal(saved.status.active.gatewayKeyMode, mode);
    assert.equal(saved.settings.gatewayKeySet, mode !== "none");
    assert.equal((await f.store.load()).settings.gatewayKey, mode === "none" ? "" : "123456");
    assert.equal((await f.api("/api/config", { revision: saved.revision, settings: { timeoutMs: 120000 } })).status, 200);
    await f.app.close();

    const restarted = await createConsole({ store: f.store, fetchImpl: () => assert.fail("No inference") });
    t.after(() => restarted.close()); await restarted.listen(0);
    assert.equal(restarted.status().running, true);
    assert.equal(restarted.bootstrapToken, null);
    const base = `http://127.0.0.1:${restarted.server.address().port}`;
    const post = (path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const session = await (await fetch(base + "/api/session")).json();
    assert.equal(session.setup, false);
    assert.equal(session.keyless, mode === "none");
    assert.equal((await post("/api/login", {})).status, mode === "none" ? 200 : 401);
    const login = await post("/api/login", { key: mode === "none" ? "arbitrary-client-value" : "123456" });
    assert.equal(login.status, 200);
    const headers = { cookie: login.headers.get("set-cookie").split(";")[0], "x-csrf-token": (await login.json()).csrf };
    const other = await post("/api/login", { key: "123456" });
    const otherCookie = other.headers.get("set-cookie").split(";")[0];
    const current = await (await fetch(base + "/api/config", { headers })).json();
    const secure = { revision: current.revision, settings: { gatewayKeyMode: "strict", gatewayKey: f.settings.gatewayKey } };
    assert.equal((await post("/api/config", secure, { cookie: headers.cookie })).status, 403);
    assert.equal((await post("/api/login", {}, { origin: "https://evil.example" })).status, 403);
    assert.equal((await post("/api/login", {}, { "sec-fetch-site": "cross-site" })).status, 403);
    if (mode === "none") {
      assert.equal((await post("/api/config", { revision: current.revision, settings: { gatewayKeyMode: "weak", gatewayKey: "123456" } }, headers)).status, 400);
      assert.equal((await post("/api/config", { revision: current.revision, settings: { gatewayKeyMode: "strict" } }, headers)).status, 400);
    }
    assert.equal((await post("/api/config", secure, headers)).status, 200);
    assert.equal((await fetch(base + "/api/config", { headers: { cookie: otherCookie } })).status, 401);
    assert.equal((await fetch(base + "/api/config", { headers })).status, 200);
    assert.equal((await post("/api/login", {})).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${f.settings.port}/v1/models`)).status, 401);
    assert.equal(f.requests.length, 0);
  });
});

test("first setup can explicitly choose keyless access and an empty key alone never disables login", async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  for (const gatewayKey of ["", null, "123456"]) {
    assert.equal((await f.api("/api/config", { revision: "new", settings: { ...f.settings, gatewayKey } })).status, 400);
  }
  const result = await f.api("/api/config", { revision: "new", settings: { ...f.settings, gatewayKeyMode: "none", gatewayKey: null }, confirmGatewayAccess: true });
  assert.equal(result.status, 200);
  assert.equal((await (await fetch(f.base + "/api/session")).json()).setup, false);
  assert.equal((await fetch(`http://127.0.0.1:${f.settings.port}/v1/models`)).status, 200);
  assert.equal(f.requests.length, 0);
});

test("console saves account rotation, redacts nested credentials and preserves them across reloads", async t => {
  const f = await fixture(t);
  const account = { id: "backup", name: "Backup", authMode: "express", projectId: "backup-project", location: "global", credential: "synthetic-backup-key" };
  let saved = await f.api("/api/config", { revision: "new", settings: { ...f.settings, accountRotationEnabled: true,
    accountTimeoutMs: 15000, accountFailureThreshold: 3, accountCooldownMs: 90000, accounts: [account] } });
  assert.equal(saved.status, 200);
  let config = await (await f.api("/api/config")).json();
  assert.equal(config.settings.accounts[0].credentialSet, true);
  assert.equal(JSON.stringify(config).includes(account.credential), false);
  assert.equal((await f.store.load()).settings.accounts[0].credential, account.credential);
  const { credentialSet, ...publicAccount } = config.settings.accounts[0];
  saved = await f.api("/api/config", { revision: config.revision, settings: { accounts: [{ ...publicAccount, name: "Renamed", credential: "" }] } });
  assert.equal(saved.status, 200);
  assert.equal((await f.store.load()).settings.accounts[0].credential, account.credential);
  const status = await (await f.api("/api/status")).json();
  assert.equal(status.accounts.length, 2);
  assert.equal(status.active.accountRotationEnabled, true);
  config = await (await f.api("/api/config")).json();
  saved = await f.api("/api/config", { revision: config.revision, settings: { accountRotationEnabled: false, accounts: [] } });
  assert.equal(saved.status, 200);
  assert.deepEqual((await f.store.load()).settings.accounts, []);
  assert.equal(f.requests.length, 0);
});

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
  const samePort = await f.api("/api/validate", { settings: { ...f.settings, port: Number(new URL(f.base).port) } });
  assert.equal(samePort.status, 400);
  assert.equal((await samePort.json()).error.message, "Gateway and console must use different ports");
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

test("a lock left by an interrupted save expires after a minute; a recent lock still blocks saving", async t => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-console-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createSettingsStore({ directory, env: {} });
  const settings = { ...(await store.load()).settings, authMode: "express", apiKey: "synthetic-express-credential", gatewayKey: "synthetic-local-console-key" };
  const lock = join(directory, "settings.lock");
  await writeFile(lock, "");
  await assert.rejects(store.save(settings, "new"), { status: 409, message: /another process/ });
  const expired = new Date(Date.now() - 120000);
  await utimes(lock, expired, expired);
  assert.equal((await store.save(settings, "new")).saved, true);
  await assert.rejects(access(lock), { code: "ENOENT" });
});

test("competing stale-lock recoveries commit exactly the acknowledged revision", async t => {
  const root = await mkdtemp(join(tmpdir(), "vertex-console-lock-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Independent stores exercise filesystem coordination, including contenders
  // that observed the old lock before another writer created a replacement.
  for (let round = 0; round < 30; round++) {
    const directory = join(root, String(round));
    await mkdir(directory);
    const store = createSettingsStore({ directory, env: {} });
    const settings = { ...(await store.load()).settings, authMode: "express", apiKey: "synthetic-express-credential", gatewayKey: "synthetic-local-console-key" };
    const lock = join(directory, "settings.lock");
    await writeFile(lock, "");
    const expired = new Date(Date.now() - 120000);
    await utimes(lock, expired, expired);
    const results = await Promise.allSettled(Array.from({ length: 16 }, (_, index) =>
      createSettingsStore({ directory, env: {} }).save({ ...settings, timeoutMs: 100000 + index }, "new")));
    const committed = results.filter(result => result.status === "fulfilled");
    assert.equal(committed.length, 1, `round ${round} must acknowledge only one writer`);
    const persisted = await store.load();
    assert.equal(persisted.revision, committed[0].value.revision);
    assert.equal(persisted.settings.timeoutMs, committed[0].value.settings.timeoutMs);
    for (const result of results.filter(result => result.status === "rejected")) assert.equal(result.reason.status, 409);
    await assert.rejects(access(lock), { code: "ENOENT" });
    await assert.rejects(access(lock + ".recovery"), { code: "ENOENT" });
  }
});

test("an interrupted recovery marker cannot be stolen by another stale-lock recovery", async t => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-console-lock-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createSettingsStore({ directory, env: {} });
  const settings = { ...(await store.load()).settings, authMode: "express", apiKey: "synthetic-express-credential", gatewayKey: "synthetic-local-console-key" };
  const lock = join(directory, "settings.lock"), marker = lock + ".recovery";
  await writeFile(lock, "original lock"); await writeFile(marker, "recovery in progress");
  const expired = new Date(Date.now() - 120000);
  await utimes(lock, expired, expired); await utimes(marker, expired, expired);
  await assert.rejects(store.save(settings, "new"), { status: 409 });
  assert.equal(await readFile(lock, "utf8"), "original lock");
  assert.equal(await readFile(marker, "utf8"), "recovery in progress");
  assert.equal((await store.load()).saved, false);
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

test("Unicode save/apply persists and affects new requests independently of transport", async t => {
  const f = await fixture(t);
  let result = await (await f.api("/api/config", { revision: "new", settings: { ...f.settings, unicodeInput: true } })).json();
  assert.equal(result.settings.unicodeInput, true);
  assert.equal(f.app.status().active.unicodeInput, true);
  assert.equal((await f.store.load()).settings.unicodeInput, true);
  const before = f.requests.length;
  const response = await fetch(`http://127.0.0.1:${f.settings.port}/v1/chat/completions`, {
    method: "POST", headers: { authorization: "Bearer " + f.settings.gatewayKey, "content-type": "application/json" },
    body: JSON.stringify({ model: result.settings.models[0].id, messages: [{ role: "user", content: "missing floor" }] }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "unicode_floor_required");
  assert.equal(f.requests.length, before);
  result = await (await f.api("/api/config", { revision: result.revision, settings: { unicodeInput: false } })).json();
  assert.equal(f.app.status().active.unicodeInput, false);
  assert.equal((await f.store.load()).settings.unicodeInput, false);
  await f.api("/api/stop", {}); await f.api("/api/start", {});
  assert.equal(f.app.status().active.unicodeInput, false);
});

test("a custom upstream lists models, saves and applies through the console without echoing its key", async t => {
  const listed = [];
  const f = await fixture(t, { fetchImpl: async (url, init) => { listed.push([url, init.headers]); return Response.json({ data: [{ id: "google/gemini-fixture" }] }); } });
  const custom = { ...f.settings, authMode: "custom", apiKey: "", customBaseUrl: "https://relay.example.invalid/v1/", customApiKey: "synthetic-relay-credential",
    models: [{ id: "relay", upstreamModel: "[满血]Gemini-Fixture", mode: "normal" }] };
  const discovered = await (await f.api("/api/models/discover", { settings: custom })).json();
  assert.deepEqual(discovered.models.map(m => m.upstreamModel), ["google/gemini-fixture"]);
  assert.deepEqual(listed, [["https://relay.example.invalid/v1/models", { authorization: "Bearer synthetic-relay-credential" }]]);
  const response = await f.api("/api/config", { revision: "new", settings: custom });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes("synthetic-relay-credential"), false);
  const result = JSON.parse(text);
  assert.equal(result.settings.customApiKeySet, true);
  assert.equal(result.settings.models[0].upstreamModel, "[满血]Gemini-Fixture");
  assert.equal((await f.store.load()).settings.models[0].upstreamModel, "[满血]Gemini-Fixture");
  // Vertex keeps its strict model IDs, so going back needs the name changed first.
  const vertex = await f.api("/api/config", { revision: result.revision, settings: { authMode: "express", apiKey: "synthetic-express-credential" } });
  assert.equal(vertex.status, 400);
  assert.equal((await vertex.json()).error.message, "Invalid upstream Gemini model ID");
  assert.equal(f.app.status().active.authMode, "custom");
  assert.equal(f.app.status().active.customBaseUrl, "https://relay.example.invalid/v1");
  assert.equal((await f.store.load()).settings.customApiKey, "synthetic-relay-credential");
  const invalid = await f.api("/api/config", { revision: result.revision, settings: { customBaseUrl: "relay.example.invalid" } });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.message, "Invalid CUSTOM_UPSTREAM_URL");
});

test("image input setting persists and conflicts are rejected before writeback",async t=>{
 const f=await fixture(t);
 const response=await f.api('/api/config',{revision:'new',settings:{...f.settings,imageInput:'current-turn'}});
 assert.equal(response.status,200);const saved=await response.json();
 assert.equal(saved.status.active.imageInput,'current-turn');assert.equal((await f.store.load()).settings.imageInput,'current-turn');
 const rejected=await f.api('/api/config',{revision:saved.revision,settings:{unicodeInput:true}});assert.equal(rejected.status,400);
 assert.equal((await f.store.load()).settings.unicodeInput,false);assert.equal(f.requests.length,0);
});

test("a port change refuses later requests on kept-alive sockets of the retired listener", { timeout: 5000 }, async t => {
  let release; const keys = [];
  const f = await fixture(t, { fetchImpl: async (_url, request) => {
    keys.push(request.headers["x-goog-api-key"]);
    const name = JSON.parse(request.body).tools[0].functionDeclarations[0].name;
    if (keys.length === 1) await new Promise(resolve => { release = resolve; });
    return Response.json({ candidates: [{ content: { parts: [{ functionCall: { name, args: { content: "reply" } } }] }, finishReason: "STOP" }] });
  } });
  const first = await (await f.api("/api/config", { revision: "new", settings: f.settings })).json();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const post = (port, content = "local test") => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", agent,
      headers: { authorization: "Bearer " + f.settings.gatewayKey, "content-type": "application/json" } }, res => {
      let text = ""; res.setEncoding("utf8");
      res.on("data", chunk => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ model: "gemini-3.7-flash-antitruncation", messages: [{ role: "user", content }] }));
  });
  const running = post(f.settings.port);
  while (!release) await delay(5);
  const port = await freePort(t);
  const changed = await f.api("/api/config", { revision: first.revision, settings: { port, gatewayKey: "synthetic-rotated-local-key", apiKey: "synthetic-replacement-api-key" } });
  assert.equal(changed.status, 200);
  release();
  assert.equal((await running).status, 200);
  // The client reuses the socket that was busy at the switch; the old key must not reach Google again.
  // A large upload (within the gateway's body limit) still gets the error, not a reset mid-upload.
  const reused = await post(f.settings.port, "x".repeat(3 * 1024 * 1024));
  assert.equal(reused.status, 503);
  assert.equal(JSON.parse(reused.text).error.code, "gateway_port_changed");
  assert.deepEqual(keys, [f.settings.apiKey]);
  await assert.rejects(post(f.settings.port), { code: "ECONNREFUSED" });
  for (let i = 0; i < 50 && f.app.status().activeRequests; i++) await delay(10);
  assert.equal(f.app.status().activeRequests, 0);
});

test("the first save keeps only the selected mode's credential from the environment; null clears a stored one", async t => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-console-env-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "unrelated-service-account.json");
  await writeFile(file, JSON.stringify({ type: "service_account", private_key: "synthetic-unrelated-private-key" }));
  const f = await fixture(t, { env: { GOOGLE_APPLICATION_CREDENTIALS: file } });
  const initial = await (await f.api("/api/config")).json();
  assert.equal(initial.saved, false);
  assert.equal(initial.settings.serviceAccountJsonSet, true);
  // Untouched credential fields arrive blank, exactly as the GUI sends them.
  let result = await (await f.api("/api/config", { revision: "new", settings: { ...f.settings, serviceAccountJson: "", accessToken: "" } })).json();
  assert.equal(result.settings.serviceAccountJsonSet, false);
  assert.equal((await readFile(join(f.directory, "settings.json"), "utf8")).includes("synthetic-unrelated-private-key"), false);
  result = await (await f.api("/api/config", { revision: result.revision, settings: { accessToken: "synthetic-unused-token" } })).json();
  assert.equal(result.settings.accessTokenSet, true);
  result = await (await f.api("/api/config", { revision: result.revision, settings: { accessToken: "" } })).json();
  assert.equal(result.settings.accessTokenSet, true, "blank keeps the stored value");
  result = await (await f.api("/api/config", { revision: result.revision, settings: { accessToken: null } })).json();
  assert.equal(result.settings.accessTokenSet, false);
  assert.equal((await f.store.load()).settings.accessToken, "");
  const required = await f.api("/api/config", { revision: result.revision, settings: { apiKey: null } });
  assert.equal(required.status, 400);
  assert.equal((await f.store.load()).settings.apiKey, f.settings.apiKey);
});

test("an unusable environment value leaves the console open for setup and is reported", async t => {
  const missing = join(tmpdir(), "vertex-console-missing-" + process.pid + ".json");
  const f = await fixture(t, { env: { GOOGLE_APPLICATION_CREDENTIALS: missing, GATEWAY_API_KEY: "synthetic-environment-key" } });
  assert.equal(f.app.status().running, false);
  assert.equal(f.app.status().error, "Environment settings were ignored: Unable to read the Google service-account file (GOOGLE_APPLICATION_CREDENTIALS)");
  const loaded = await (await f.api("/api/config")).json();
  assert.equal(loaded.saved, false);
  assert.equal(loaded.settings.gatewayKeySet, false);
  const saved = await f.api("/api/config", { revision: "new", settings: f.settings });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).status.error, null);
});

test("an occupied console port names the console port and GUI_PORT", async t => {
  const port = await freePort(t, true);
  const directory = await mkdtemp(join(tmpdir(), "vertex-console-port-"));
  const app = await createConsole({ store: createSettingsStore({ directory, env: {} }), autoStart: false });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(app.listen(port), { status: 409, message: `Console port ${port} is unavailable (GUI_PORT); another console may already be running` });
});

test("Express Argon probes require a project and use locations/global after save/apply, with old configurations still readable", async t => {
  const requests = [];
  const f = await fixture(t, { fetchImpl: async (url, request) => {
    requests.push({ url, headers: request.headers });
    const result = { candidates: [{ content: { parts: [{ text: "probe reply" }] }, finishReason: "STOP" }] };
    return url.includes(":streamGenerateContent") ? new Response("data: " + JSON.stringify(result) + "\n\n") : Response.json(result);
  } });
  const models = [
    { id: "argon-alias", upstreamModel: "google/gemini-4-argon", mode: "normal" },
    { id: "earlier-model", upstreamModel: "google/gemini-3.7-flash", mode: "normal" },
  ];
  const initial = await f.api("/api/config", { revision: "new", settings: { ...f.settings, projectId: "", models } });
  assert.equal(initial.status, 200);
  const saved = await initial.json();
  assert.equal((await f.store.load()).settings.projectId, "", "legacy Argon configurations remain readable and editable");
  for (const stream of [false, true]) {
    const response = await f.api("/api/probe", { confirm: true, model: "argon-alias", stream });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "express_project_required");
  }
  assert.equal(requests.length, 0, "missing project is rejected before any upstream request");
  const earlier = await f.api("/api/probe", { confirm: true, model: "earlier-model" });
  assert.equal(earlier.status, 200); await earlier.text();
  assert.equal(requests[0].url, "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.7-flash:generateContent");
  const applied = await f.api("/api/config", { revision: saved.revision, settings: { projectId: "example-project" } });
  assert.equal(applied.status, 200);
  assert.equal((await applied.json()).status.active.projectId, "example-project");
  for (const stream of [false, true]) {
    const response = await f.api("/api/probe", { confirm: true, model: "argon-alias", stream });
    assert.equal(response.status, 200); assert.match(await response.text(), /probe reply/);
    const request = requests.at(-1);
    assert.equal(request.url, "https://aiplatform.googleapis.com/v1/projects/example-project/locations/global/publishers/google/models/gemini-4-argon:" + (stream ? "streamGenerateContent?alt=sse" : "generateContent"));
    assert.equal(request.headers["x-goog-api-key"], f.settings.apiKey);
    assert.equal(request.headers.authorization, undefined);
  }
  assert.equal(requests.length, 3);
});

test("console probe allows the gateway its configured timeout and names local connection failures", async t => {
  const f = await fixture(t, { fetchImpl: async (_url, request) => {
    const name = JSON.parse(request.body).tools[0].functionDeclarations[0].name;
    return Response.json({ candidates: [{ content: { parts: [{ functionCall: { name, args: { content: "probe reply" } } }] }, finishReason: "STOP" }] });
  } });
  assert.equal((await f.api("/api/config", { revision: "new", settings: { ...f.settings, timeoutMs: 900000 } })).status, 200);
  const original = globalThis.fetch; let probe, failure = null;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (url, init) => {
    if (!String(url).endsWith("/v1/chat/completions")) return original(url, init);
    probe = init;
    return failure ? Promise.reject(failure) : original(url, init);
  };
  const ok = await f.api("/api/probe", { confirm: true });
  assert.equal(ok.status, 200); assert.match(await ok.text(), /probe reply/);
  assert.equal(probe.dispatcher, await upstreamDispatcher(930000), "the probe hop outlasts the gateway's own timeout");
  for (const [code, status, message] of [["UND_ERR_HEADERS_TIMEOUT", 504, "The gateway did not respond in time"], ["ECONNREFUSED", 502, "Cannot reach the local gateway"]]) {
    failure = new TypeError("fetch failed", { cause: Object.assign(new Error("fixture"), { code }) });
    const response = await f.api("/api/probe", { confirm: true });
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.message, message);
  }
});

test("a save signs out other sessions only when it changes the gateway key", async t => {
  const f = await fixture(t);
  let result = await (await f.api("/api/config", { revision: "new", settings: f.settings })).json();
  const login = await fetch(f.base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: f.settings.gatewayKey }) });
  const other = login.headers.get("set-cookie").split(";")[0];
  const otherStatus = async () => (await fetch(f.base + "/api/status", { headers: { cookie: other } })).status;
  result = await (await f.api("/api/config", { revision: result.revision, settings: { timeoutMs: 120000 } })).json();
  assert.equal(await otherStatus(), 200);
  result = await (await f.api("/api/config", { revision: result.revision, settings: { gatewayKey: f.settings.gatewayKey } })).json();
  assert.equal(await otherStatus(), 200, "re-entering the same key is not a change");
  assert.equal((await f.api("/api/config", { revision: result.revision, settings: { gatewayKey: "synthetic-rotated-local-key" } })).status, 200);
  assert.equal(await otherStatus(), 401);
  assert.equal((await f.api("/api/status")).status, 200, "the saving session stays signed in");
});

test("the first save signs out other bootstrap sessions and retires the bootstrap token", async t => {
  const f = await fixture(t);
  const bootstrapLogin = () => fetch(f.base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: f.app.bootstrapToken }) });
  const other = (await bootstrapLogin()).headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(f.base + "/api/status", { headers: { cookie: other } })).status, 200);
  assert.equal((await f.api("/api/config", { revision: "new", settings: f.settings })).status, 200);
  assert.equal((await fetch(f.base + "/api/status", { headers: { cookie: other } })).status, 401);
  assert.equal((await bootstrapLogin()).status, 401);
  assert.equal((await f.api("/api/status")).status, 200, "the saving session stays signed in");
});

test("a failed manual start keeps its reason in status until a start succeeds", async t => {
  const f = await fixture(t);
  await f.api("/api/config", { revision: "new", settings: f.settings });
  assert.equal((await f.api("/api/stop", {})).status, 200);
  const blocker = http.createServer(); blocker.listen(f.settings.port, "127.0.0.1"); await once(blocker, "listening");
  const failed = await f.api("/api/start", {});
  assert.equal(failed.status, 409);
  assert.equal(f.app.status().error, (await failed.json()).error.message);
  await new Promise(resolve => blocker.close(resolve));
  assert.equal((await f.api("/api/start", {})).status, 200);
  assert.equal(f.app.status().error, null);
});

test("a gateway key saved before the visible-ASCII rule still opens the console, which names the problem", async t => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-console-legacy-"));
  const legacyKey = "synthetic-local-key-caf\u00e9";
  await writeFile(join(directory, "settings.json"), JSON.stringify({ version: 1, settings: { authMode: "express", apiKey: "synthetic-express-credential", gatewayKey: legacyKey, port: await freePort(t) } }));
  const app = await createConsole({ store: createSettingsStore({ directory, env: {} }), fetchImpl: () => assert.fail("No inference") });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  await app.listen(0);
  assert.equal(app.status().running, false);
  assert.equal(app.status().error, "GATEWAY_API_KEY must contain only visible ASCII characters");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: legacyKey }) });
  assert.equal(login.status, 200);
  const headers = { cookie: login.headers.get("set-cookie").split(";")[0], "x-csrf-token": (await login.json()).csrf, "content-type": "application/json" };
  const { revision } = await (await fetch(base + "/api/config", { headers })).json();
  const save = settings => fetch(base + "/api/config", { method: "POST", headers, body: JSON.stringify({ revision, settings }) });
  for (const [settings, message] of [[{ timeoutMs: 120000 }, "GATEWAY_API_KEY must contain only visible ASCII characters"],
    [{ gatewayKey: "synthetic-replacement-local-key", apiKey: "\u201csynthetic-express-credential\u201d" }, "VERTEX_API_KEY must contain only visible ASCII characters"]]) {
    const rejected = await save(settings);
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error.message, message);
  }
  const fixed = await save({ gatewayKey: "synthetic-replacement-local-key" });
  assert.equal(fixed.status, 200);
  assert.equal((await fixed.json()).status.running, true);
});
