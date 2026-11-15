import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import { createGatewayServer } from "../src/gateway.mjs";
import { loadConfig } from "../src/config.mjs";
import { fetchWithGeminiRecovery } from "../src/gemini-compat.mjs";
import { vertexAccessToken } from "../src/vertex-auth.mjs";

const key = "synthetic-fix-gateway-key";
const model = { id: "fixture", upstreamModel: "gemini-3.7-flash", mode: "normal", enabled: true };
const payload = { model: "fixture", messages: [{ role: "user", content: "fixture prompt" }] };
const ok = () => Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });

async function gateway(t, upstream, override = {}) {
  const events = [], requests = [];
  const config = { ...await loadConfig({ GATEWAY_API_KEY: key, VERTEX_PROJECT_ID: "example-project", VERTEX_ACCESS_TOKEN: "synthetic-token" }),
    antiTruncation: false, models: [model], ...override };
  const server = createGatewayServer(config, { logger: event => events.push(event), fetchImpl: async (url, init) => {
    requests.push({ url, json: JSON.parse(init.body) });
    return upstream();
  } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { events, requests, post };
}

test("an oversized upload is read to the end so the client receives the 413", async t => {
  const f = await gateway(t, () => assert.fail("an oversized request must not reach the upstream"), { bodyLimitBytes: 1024 });
  for (let i = 0; i < 3; i++) {
    const response = await f.post("x".repeat(8 * 1024 * 1024));
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, "request_too_large");
  }
  assert.equal(f.requests.length, 0);
});

test("credential and network failures before a reply get their own codes", async t => {
  const credential = await gateway(t, () => assert.fail("no inference without a credential"),
    { accessToken: async () => { throw new Error("vertex token exchange failed with HTTP 400"); } });
  let response = await credential.post(payload);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "credential_error");
  assert.equal(credential.events[0].code, "credential_error");
  const offline = await gateway(t, () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) });
  });
  response = await offline.post(payload);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "upstream_unreachable");
  assert.equal(offline.events[0].code, "upstream_unreachable");
  // fetch throws a cause-less TypeError while building the request, e.g. for a key with smart quotes.
  const malformed = await gateway(t, () => { throw new TypeError("Cannot convert argument to a ByteString"); });
  response = await malformed.post(payload);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "credential_error");
  assert.equal(malformed.events[0].code, "credential_error");
});

test("a broken upstream error body keeps the upstream status and Retry-After", async t => {
  const bodies = {
    errored: () => new ReadableStream({ start(c) { c.error(new TypeError("terminated")); } }),
    partial: () => { let sent = false; return new ReadableStream({ pull(c) {
      if (sent) c.error(new TypeError("terminated")); else { sent = true; c.enqueue(new TextEncoder().encode('{"error":{"mess')); }
    } }); },
  };
  for (const retry of [false, true]) for (const [shape, body] of Object.entries(bodies)) {
    const f = await gateway(t, () => new Response(body(), { status: 429, headers: { "retry-after": "7" } }),
      { rateLimitRetryMax: 0, geminiPromptRetry: { enabled: retry, text: "retry text" } });
    const response = await f.post(payload);
    assert.equal(response.status, 429, `${shape} body, prompt retry ${retry}`);
    assert.equal(response.headers.get("retry-after"), "7");
    assert.equal((await response.json()).error.code, "upstream_http_error");
    assert.equal(f.requests.length, 1);
  }
  const broken = new Response(bodies.partial(), { status: 503, statusText: "Unavailable", headers: { "retry-after": "9" } });
  const recovered = await fetchWithGeminiRecovery(async () => broken, payload, "gemini-3.7-flash", { settings: { enabled: true, text: "retry text" } });
  assert.equal(recovered.status, 503);
  assert.equal(recovered.headers.get("retry-after"), "9");
  assert.equal(recovered.routerPromptSubmissionError, undefined);
});

test("all-mode images keep the 3.7/3.8 prefill switch; current-turn keeps its boundary", async t => {
  const messages = [{ role: "user", content: "写一段" }, { role: "assistant", content: "好的，我继续写：" }];
  for (const mode of ["all", "current-turn"]) {
    const f = await gateway(t, ok, { imageInput: mode });
    const response = await f.post({ model: "fixture", messages });
    assert.equal(response.status, 200); await response.json();
    assert.equal(response.headers.get("x-gemini-prefill-converted"), "true");
    const sent = f.requests[0].json.messages;
    if (mode === "all") {
      assert.deepEqual(sent.map(message => message.role), ["user", "user"]);
      assert.ok(sent.every(message => message.content.every(part => part.type === "image_url")));
      assert.equal(f.events[0].imageInput.messages, 2);
    } else {
      assert.equal(f.events[0].imageInput.reason, "no-text");
      assert.deepEqual(sent, [messages[0], { ...messages[1], role: "user" }]);
    }
  }
});

test("a canvas failure after the renderer loads is a local 503, not an upstream error", async t => {
  t.mock.method(Object.getPrototypeOf(createCanvas(1, 1)), "encode", async () => {
    throw Object.assign(new Error("native encode failure"), { code: "GenericFailure" });
  });
  const f = await gateway(t, () => assert.fail("a render failure must not reach the upstream"), { imageInput: "all" });
  const response = await f.post(payload);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "image_render_failed");
  assert.equal(f.events[0].code, "image_render_failed");
  assert.equal(f.requests.length, 0);
});

test("the upstream timeout also applies through Node's environment proxy agent", { timeout: 10000 }, async t => {
  const slow = http.createServer((request, response) => setTimeout(() => response.end("late"), 1500));
  slow.listen(0, "127.0.0.1"); await once(slow, "listening");
  t.after(() => new Promise(resolve => { slow.close(resolve); slow.closeAllConnections(); }));
  const script = `import { upstreamDispatcher } from ${JSON.stringify(new URL("../src/gateway.mjs", import.meta.url).href)};
    const dispatcher = await upstreamDispatcher(100);
    const global = globalThis[Symbol.for("undici.globalDispatcher.1")]?.constructor?.name;
    let result;
    try { result = await (await fetch(process.argv[1], { dispatcher })).text(); } catch (error) { result = error.cause?.code; }
    console.log(JSON.stringify({ global, dispatcher: dispatcher?.constructor?.name, result }));`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:https?|no|all)_proxy$/i.test(name)));
  // Requests to 127.0.0.1 bypass the (unused) proxy through the agent's own direct Agent.
  Object.assign(env, { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1" });
  const output = await new Promise((resolve, reject) => execFile(process.execPath, ["--input-type=module", "-e", script,
    `http://127.0.0.1:${slow.address().port}/`], { env }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const result = JSON.parse(output.trim().split("\n").at(-1));
  assert.equal(result.dispatcher, result.global, "the dispatcher matches the built-in global agent class");
  // undici checks header timers on a ~0.5 s tick; the slow reply takes 1.5 s.
  assert.equal(result.result, "UND_ERR_HEADERS_TIMEOUT");
});

test("a failed early token refresh keeps using the still-valid token; an expired one is not reused", async t => {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  const secret = name => JSON.stringify({ type: "service_account", project_id: "example-project", private_key: privateKey,
    client_email: name + "@example.invalid", token_uri: "https://oauth2.googleapis.com/token" });
  let replies = [
    // 120 s left is inside the 5-minute refresh margin but still valid.
    () => Response.json({ access_token: "still-valid", expires_in: 120 }),
    () => new Response("unavailable", { status: 503 }),
    () => { throw new TypeError("fetch failed"); },
    () => Response.json({ access_token: "refreshed", expires_in: 3600 }),
  ];
  const fetchMock = t.mock.method(globalThis, "fetch", async () => replies.shift()());
  const early = secret("early-refresh");
  assert.equal(await vertexAccessToken(early), "still-valid");
  assert.equal(await vertexAccessToken(early), "still-valid", "the refresh failed with HTTP 503, so the valid token is used");
  assert.equal(await vertexAccessToken(early), "still-valid", "the refresh failed in transport, so the valid token is used");
  assert.equal(await vertexAccessToken(early), "refreshed", "the next request retries the refresh");
  assert.equal(fetchMock.mock.callCount(), 4);
  replies = [
    () => Response.json({ access_token: "expired", expires_in: 0.001 }),
    () => new Response("unavailable", { status: 503 }),
  ];
  const expiring = secret("expired-refresh");
  assert.equal(await vertexAccessToken(expiring), "expired");
  await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(vertexAccessToken(expiring), /HTTP 503/);
});
