import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { buildConfig, DEFAULT_SETTINGS, publicSettings, settingsFromEnv } from "../src/config.mjs";
import { mergeSettings } from "../src/settings-store.mjs";
import { createGatewayServer } from "../src/gateway.mjs";
import { createAccountPool } from "../src/account-pool.mjs";

const settings = () => ({ ...DEFAULT_SETTINGS, gatewayKey: "synthetic-rotation-gateway-key", authMode: "custom",
  customBaseUrl: "https://primary.invalid/v1", customApiKey: "synthetic-primary",
  models: [{ id: "fixture", upstreamModel: "fixture", mode: "normal" }],
  accountRotationEnabled: true, accountFailureThreshold: 1,
  accounts: [{ id: "second", name: "Second", authMode: "custom", customBaseUrl: "https://second.invalid/v1", credential: "synthetic-second" }] });
const completion = () => Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }] });
const body = { model: "fixture", messages: [{ role: "user", content: "hello" }] };
async function fixture(t, fetchImpl, overrides = {}) {
  let config = { ...buildConfig(settings()), ...overrides };
  const events = [], calls = [];
  const server = createGatewayServer(() => config, { fetchImpl: (url, options) => {
    calls.push({ url, key: options.headers.authorization }); return fetchImpl(url, options);
  }, logger: event => events.push(event) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (payload = body, options = {}) => fetch(base + "/v1/chat/completions", { method: "POST",
    headers: { authorization: "Bearer " + config.gatewayKey, "content-type": "application/json" }, body: JSON.stringify(payload), ...options });
  return { request, calls, events, server, setConfig: next => { config = next; } };
}

test("rotation defaults off; account secrets are redacted and blank updates preserve by ID and auth mode", async () => {
  assert.equal(DEFAULT_SETTINGS.accountRotationEnabled, false);
  assert.equal((await settingsFromEnv({})).accountRotationEnabled, false);
  const s = settings(), visible = publicSettings(s);
  assert.equal(visible.accounts[0].credentialSet, true);
  assert.equal(JSON.stringify(visible).includes("synthetic-second"), false);
  assert.equal(mergeSettings(s, { accounts: [{ ...s.accounts[0], credential: "" }] }).accounts[0].credential, "synthetic-second");
  assert.throws(() => mergeSettings(s, { accounts: [{ ...s.accounts[0], credential: null }] }));
  assert.throws(() => mergeSettings(s, { accounts: [{ ...s.accounts[0], id: "new", credential: "" }] }));
  assert.throws(() => buildConfig({ ...s, accounts: [s.accounts[0], s.accounts[0]] }), /duplicate/);
  assert.throws(() => buildConfig({ ...s, accountFailureThreshold: 0 }), /FAILURE_THRESHOLD/);
  assert.throws(() => buildConfig({ ...s, accountRotationEnabled: "true" }), /toggle/);
  assert.throws(() => buildConfig({ ...s, accounts: [] }), /at least one/);
});

test("round robin distributes sequential and concurrent requests; disabled always uses primary", async t => {
  const f = await fixture(t, async () => completion());
  for (let i = 0; i < 4; i++) assert.equal((await f.request()).status, 200);
  assert.deepEqual(f.calls.map(c => c.key), ["Bearer synthetic-primary", "Bearer synthetic-second", "Bearer synthetic-primary", "Bearer synthetic-second"]);
  const responses = await Promise.all(Array.from({ length: 8 }, () => f.request()));
  assert.ok(responses.every(r => r.status === 200));
  assert.equal(f.calls.filter(c => c.key === "Bearer synthetic-primary").length, 6);
  f.setConfig(buildConfig({ ...settings(), accountRotationEnabled: false }));
  for (let i = 0; i < 3; i++) await f.request();
  assert.ok(f.calls.slice(-3).every(c => c.key === "Bearer synthetic-primary"));
  assert.equal(f.events.at(-1).accountAttempts, undefined);
});

test("failure threshold accumulates across requests, switches at threshold and skips cooling accounts", async t => {
  const cfg = buildConfig({ ...settings(), accountFailureThreshold: 2, rateLimitRetryMax: 0 });
  const f = await fixture(t, async url => url.includes("primary") ? Response.json({ error: { message: "busy" } }, { status: 429 }) : completion(), cfg);
  assert.equal((await f.request()).status, 429);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.request()).status, 200);
  assert.equal((await f.request()).status, 200);
  assert.deepEqual(f.events.at(-1).accountAttempts.map(a => [a.accountId, a.status]), [["primary", 429], ["second", 200]]);
  assert.equal((await f.request()).status, 200);
  assert.equal(f.calls.at(-1).key, "Bearer synthetic-second");
  assert.ok(f.server.accountStatus()[0].cooldownRemainingMs > 0);
});

test("persistent HTTP 429 gets ten retries in total even when rotation switches accounts", async t => {
  let replies = 0, cancelled = 0;
  const f = await fixture(t, async () => {
    replies++;
    if (replies <= 10) return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 429 });
    return Response.json({ error: { message: "busy on attempt " + replies } }, { status: 429, headers: { "retry-after": "7" } });
  }, { rateLimitRetryIntervalSeconds: 0 });
  const response = await f.request();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "7");
  assert.equal((await response.json()).error.upstreamError.message, "busy on attempt 12");
  assert.equal(cancelled, 10);
  assert.deepEqual(f.calls.map(call => call.key), [...Array(11).fill("Bearer synthetic-primary"), "Bearer synthetic-second"]);
  assert.equal(f.events[0].rateLimitRetries, 10);
});

test("a disconnect or total deadline during the 429 wait ends the request before another submission", { timeout: 5000 }, async t => {
  for (const cancel of [false, true]) {
    const waiting = Promise.withResolvers();
    const f = await fixture(t, async () => new Response(new ReadableStream({ cancel: waiting.resolve }), { status: 429 }),
      { timeoutMs: cancel ? 10000 : 200, rateLimitRetryIntervalSeconds: 5 });
    const controller = new AbortController();
    const pending = f.request(body, { signal: controller.signal });
    await waiting.promise;
    if (cancel) {
      controller.abort();
      await assert.rejects(pending);
    } else assert.equal((await pending).status, 504);
    while (f.server.gatewayStats().active) await delay(2);
    assert.equal(f.calls.length, 1);
    assert.equal(f.events[0].status, cancel ? 499 : 504);
    assert.ok(f.server.accountStatus().every(a => a.failures === 0));
  }
});

test("success clears failure count and cooldown expires without probes", () => {
  let time = 100;
  const config = buildConfig({ ...settings(), accountFailureThreshold: 2 }), pool = createAccountPool(config, () => time);
  const first = pool.take(new Set());
  assert.equal(pool.fail(first), false);
  pool.success(first);
  assert.equal(pool.fail(first), false);
  assert.equal(pool.fail(first), true);
  assert.equal(pool.take(new Set()).connection.id, "second");
  time += config.accountRotation.cooldownMs;
  assert.equal(pool.take(new Set()).connection.id, "primary");
});

test("switching Vertex accounts starts at the new primary without replenishing the region retry budget", async t => {
  const cfg = buildConfig({ authMode: "access-token", gatewayKey: "synthetic-rotation-gateway-key", projectId: "first", accessToken: "synthetic-first",
    location: "eu", regionFallbackEnabled: true, fallbackLocations: ["us"], rateLimitRetryMax: 1, rateLimitRetryIntervalSeconds: 0,
    models: [{ id: "fixture", upstreamModel: "gemini-4-neon", mode: "normal" }], accountRotationEnabled: true, accountFailureThreshold: 1,
    accounts: [{ id: "second", name: "Second", authMode: "access-token", projectId: "next", location: "global",
      regionFallbackEnabled: true, fallbackLocations: ["eu"], credential: "synthetic-second" }] });
  const f = await fixture(t, async () => new Response(null, { status: 429 }), cfg);
  assert.equal((await f.request()).status, 429);
  assert.deepEqual(f.events[0].regionAttempts.map(a => [a.accountId, a.location, a.status]),
    [["primary","eu",429],["primary","us",429],["second","global",429]]);
  assert.equal(f.events[0].rateLimitRetries, 1);
});

test("a provider Retry-After longer than the request deadline prevents a cross-region submission", { timeout: 5000 }, async t => {
  const cfg = buildConfig({ authMode: "access-token", gatewayKey: "synthetic-rotation-gateway-key", projectId: "first", accessToken: "synthetic-first",
    location: "eu", regionFallbackEnabled: true, fallbackLocations: ["us"], rateLimitRetryMax: 1, rateLimitRetryIntervalSeconds: 0,
    models: [{ id: "fixture", upstreamModel: "gemini-4-neon", mode: "normal" }] });
  const f = await fixture(t, async () => new Response(null, { status: 429, headers: { "retry-after": new Date(Date.now()+60000).toUTCString() } }),
    { ...cfg, timeoutMs: 250 });
  assert.equal((await f.request()).status, 504);
  assert.equal(f.calls.length, 1);
});

test("all failed accounts are tried at most once; subsequent requests fail without submissions", async t => {
  const f = await fixture(t, async () => Response.json({}, { status: 503 }));
  assert.equal((await f.request()).status, 503);
  assert.equal(f.calls.length, 2);
  const unavailable = await f.request();
  assert.equal((await unavailable.json()).error.code, "accounts_unavailable");
  assert.equal(f.calls.length, 2);
  f.setConfig(buildConfig(settings()));
  await f.request(); assert.equal(f.calls.length, 4);
});

test("bad client payload and upstream 400 do not fail over or disable accounts", async t => {
  const f = await fixture(t, async () => Response.json({}, { status: 400 }));
  assert.equal((await f.request({ ...body, messages: [] })).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request()).status, 400);
  assert.equal(f.calls.length, 1);
  assert.ok(f.server.accountStatus().every(a => a.failures === 0));
});

test("authentication timeout switches; late authentication cannot submit; total deadline prevents switching", async t => {
  const cfg = buildConfig(settings());
  cfg.accountRotation.timeoutMs = 30;
  let finishAuth;
  const f = await fixture(t, async () => completion(), { ...cfg, accessToken: () => new Promise(resolve => { finishAuth = resolve; }) });
  assert.equal((await f.request()).status, 200);
  assert.deepEqual(f.events[0].accountAttempts.map(a => a.status), [504, 200]);
  finishAuth("late-token"); await delay(5);
  assert.equal(f.calls.length, 1);
  const g = await fixture(t, async () => completion(), { ...cfg, timeoutMs: 10, accessToken: () => new Promise(() => {}) });
  assert.equal((await g.request()).status, 504);
  assert.equal(g.calls.length, 0);
  assert.ok(g.server.accountStatus().every(a => a.failures === 0));
});

test("real upstream timeout aborts before output and switches; disconnect never retries", async t => {
  const upstream = http.createServer((req, res) => { req.resume(); });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const cfg = buildConfig(settings()); cfg.accountRotation.timeoutMs = 50;
  const f = await fixture(t, (url, options) => url.includes("primary") ? fetch(`http://127.0.0.1:${upstream.address().port}`, options) : Promise.resolve(completion()), cfg);
  assert.equal((await f.request()).status, 200);
  assert.equal(f.events[0].accountAttempts[0].code, "account_timeout");
  f.setConfig({ ...buildConfig(settings()), timeoutMs: 5000 });
  const controller = new AbortController();
  const pending = f.request(body, { signal: controller.signal });
  while (f.calls.length < 3) await delay(2);
  controller.abort(); await assert.rejects(pending);
  while (f.server.gatewayStats().active) await delay(2);
  assert.equal(f.calls.length, 3);
  assert.ok(f.server.accountStatus().every(a => a.failures === 0));
});

test("a stream that already emitted data is never replayed on a second account", async t => {
  const chunk = 'data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n';
  const f = await fixture(t, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(chunk)); setTimeout(() => controller.error(new Error("broken stream")), 30); },
  }), { headers: { "content-type": "text/event-stream" } }));
  const response = await f.request({ ...body, stream: true });
  await assert.rejects(response.text());
  assert.equal(f.calls.length, 1);
  assert.equal(f.server.accountStatus()[0].failures, 1);
});

test("switching Vertex auth modes rebuilds the endpoint, headers and native request body", async t => {
  const cfg = buildConfig({ ...settings(), authMode: "access-token", projectId: "first-project", accessToken: "synthetic-oauth",
    models: [{ id: "fixture", upstreamModel: "gemini-2.5-flash", mode: "normal" }],
    accounts: [{ id: "express", name: "Express", authMode: "express", projectId: "other-project", credential: "synthetic-express" }] });
  const f = await fixture(t, async (url, options) => {
    if (url.includes("first-project")) {
      assert.match(url, /endpoints\/openapi\/chat\/completions$/);
      assert.equal(options.headers.authorization, "Bearer synthetic-oauth");
      return Response.json({}, { status: 401 });
    }
    assert.match(url, /projects\/other-project\/locations\/global\/publishers\/google\/models\/gemini-2.5-flash:generateContent$/);
    assert.equal(options.headers["x-goog-api-key"], "synthetic-express");
    assert.equal(options.headers.authorization, undefined);
    assert.equal(JSON.parse(options.body).contents[0].parts[0].text, "hello");
    return Response.json({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "native reply" }] }, finishReason: "STOP" }] });
  }, cfg);
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "native reply");
  assert.equal(f.calls.length, 2);
  assert.equal(f.server.modelAvailability()[0].available, true);
});

test("stalled nonstream response body times out and switches before returning JSON", async t => {
  const upstream = http.createServer((req, res) => { req.resume(); res.writeHead(200, { "content-type": "application/json" }); res.write('{"choices":'); });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const cfg = buildConfig(settings()); cfg.accountRotation.timeoutMs = 50;
  const f = await fixture(t, (url, options) => url.includes("primary") ? fetch(`http://127.0.0.1:${upstream.address().port}`, options) : Promise.resolve(completion()), cfg);
  assert.equal((await f.request()).status, 200);
  assert.deepEqual(f.events[0].accountAttempts.map(a => a.status), [504, 200]);
});
