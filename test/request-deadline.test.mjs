import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter, getEventListeners, once } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { waitWithSignal } from "../src/abort.mjs";
import { createGatewayServer } from "../src/gateway.mjs";
import { discoverModels } from "../src/model-discovery.mjs";
import { createGenerateHandler } from "../integrations/sillytavern/server.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const configFor = accessToken => ({ gatewayKey: "synthetic-deadline-key", timeoutMs: 50, bodyLimitBytes: 10000,
  antiTruncation: false, models: [{ id: "fixture", upstreamModel: "gemini-2.5-pro", mode: "normal" }],
  baseUrl: "https://example.invalid", location: "global", authMode: "access-token", accessToken });
const payload = JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "fixture prompt" }] });

async function gateway(t, accessToken, extra = {}) {
  const events = [], event = deferred();
  let fetchCalls = 0;
  const config = { ...configFor(accessToken), ...extra };
  const server = createGatewayServer(config, {
    fetchImpl: async () => { fetchCalls++; throw new Error("Unexpected inference"); },
    logger: value => { events.push(value); event.resolve(value); },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const request = () => http.request({ hostname: "127.0.0.1", port: server.address().port,
    path: "/v1/chat/completions", method: "POST", headers: { authorization: "Bearer " + config.gatewayKey } });
  return { server, request, events, event: event.promise, fetchCalls: () => fetchCalls };
}

async function jsonResponse(request) {
  const [response] = await once(request, "response");
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return { status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks)) };
}

test("shared asynchronous work stops blocking on cancellation and cleans listeners", async () => {
  const operation = deferred();
  const stopped = new AbortController();
  const other = new AbortController();
  const first = waitWithSignal(() => operation.promise, stopped.signal);
  const second = waitWithSignal(() => operation.promise, other.signal);
  await Promise.resolve();
  stopped.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(getEventListeners(stopped.signal, "abort").length, 0);
  operation.resolve("shared result");
  assert.equal(await second, "shared result");
  assert.equal(getEventListeners(other.signal, "abort").length, 0);
  await assert.rejects(waitWithSignal(() => assert.fail("already cancelled"), stopped.signal), { name: "AbortError" });
  const late = deferred(), cancelled = new AbortController();
  const waiting = waitWithSignal(() => late.promise, cancelled.signal);
  await Promise.resolve(); cancelled.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  late.reject(new Error("late shared failure"));
  await delay(0);
});

test("gateway deadline returns before pending authentication and never starts inference later", { timeout: 2000 }, async t => {
  const credential = deferred();
  const f = await gateway(t, () => credential.promise);
  const request = f.request();
  const response = jsonResponse(request); request.end(payload);
  const result = await response;
  assert.equal(result.status, 504);
  assert.equal(result.body.error.code, "upstream_timeout");
  assert.equal(f.server.gatewayStats().active, 0);
  assert.equal(f.events[0].status, 504);
  credential.resolve("synthetic-token"); await delay(0);
  assert.equal(f.fetchCalls(), 0);
});

test("unfinished uploads reach their deadline or byte limit without waiting for EOF", { timeout: 2000 }, async t => {
  for (const oversized of [false, true]) {
    const f = await gateway(t, () => assert.fail("upload must not authenticate"), { bodyLimitBytes: oversized ? 8 : 10000 });
    const request = f.request();
    const response = jsonResponse(request);
    request.write(oversized ? "x".repeat(16) : "{");
    const result = await response;
    assert.equal(result.status, oversized ? 413 : 504);
    assert.equal(result.headers.connection, "close");
    assert.equal(f.server.gatewayStats().active, 0);
    assert.equal(f.fetchCalls(), 0);
  }
});

test("disconnect during authentication releases the active request without cancelling shared auth", { timeout: 2000 }, async t => {
  const credential = deferred(), started = deferred();
  const f = await gateway(t, () => { started.resolve(); return credential.promise; }, { timeoutMs: 1000 });
  const request = f.request();
  request.on("error", () => {}); request.end(payload);
  await started.promise; request.destroy();
  assert.equal((await f.event).status, 499);
  assert.equal(f.server.gatewayStats().active, 0);
  credential.resolve("synthetic-token"); await delay(0);
  assert.equal(f.fetchCalls(), 0);
});

test("disconnect during an unfinished upload releases listeners and the active request", { timeout: 2000 }, async t => {
  const f = await gateway(t, () => assert.fail("unfinished upload must not authenticate"), { timeoutMs: 1000 });
  const request = f.request();
  request.on("error", () => {}); request.write("{");
  while (!f.server.gatewayStats().active) await delay(1);
  request.destroy();
  assert.equal((await f.event).status, 499);
  assert.equal(f.server.gatewayStats().active, 0);
  assert.equal(f.fetchCalls(), 0);
  await delay(10);
});

test("model discovery cancellation during authentication cannot fetch the catalog", { timeout: 2000 }, async () => {
  const credential = deferred(), started = deferred(), controller = new AbortController();
  let fetchCalls = 0;
  const pending = discoverModels(configFor(() => { started.resolve(); return credential.promise; }), {
    signal: controller.signal, fetchImpl: async () => { fetchCalls++; throw new Error("Unexpected catalog request"); },
  });
  await started.promise; controller.abort();
  await assert.rejects(pending, /cancelled or timed out/);
  credential.reject(new Error("late auth error")); await delay(0);
  assert.equal(fetchCalls, 0);
});

test("SillyTavern authentication respects deadline and disconnect before starting inference", { timeout: 5000 }, async t => {
  for (const disconnect of [false, true]) {
    const credential = deferred(), started = deferred();
    const serviceAccount = JSON.stringify({ type: "service_account", project_id: "example-project",
      client_email: "fixture@example.invalid", token_uri: "https://oauth2.googleapis.com/token",
      private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) });
    const fetchMock = t.mock.method(globalThis, "fetch", async input => {
      assert.equal(input, "https://oauth2.googleapis.com/token");
      started.resolve(); return credential.promise;
    });
    let inference = 0;
    const handler = createGenerateHandler({
      getPromptNames: () => ({}), convertGooglePrompt: () => ({ contents: [{ role: "user", parts: [{ text: "fixture" }] }] }),
      calculateGoogleBudgetTokens: () => undefined, safetySettings: [],
      SECRET_KEYS: { VERTEXAI_SERVICE_ACCOUNT: "fixture" }, readSecret: () => serviceAccount,
    }, { timeoutMs: 50, fetchImpl: async () => { inference++; throw new Error("Unexpected inference"); } });
    const response = new EventEmitter();
    response.setHeader = () => {};
    response.status = code => { response.statusCode = code; return response; };
    response.json = body => { response.body = body; response.writableEnded = true; };
    const pending = handler({ user: { directories: {} }, body: { chat_completion_source: "vertexai", model: "gemini-2.5-flash",
      vertex_anti_truncation: "buffered", vertexai_auth_mode: "full", vertexai_region: "global", messages: [{ role: "user", content: "fixture" }] } }, response);
    await started.promise;
    if (disconnect) response.emit("close");
    await pending;
    assert.equal(response.statusCode, disconnect ? undefined : 504);
    if (!disconnect) assert.equal(response.body.error.code, "vertex_timeout");
    assert.equal(response.listenerCount("close"), 0);
    credential.resolve(Response.json({ access_token: "synthetic-token", expires_in: 3600 }));
    await delay(0); fetchMock.mock.restore();
    assert.equal(inference, 0);
  }
});
