import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { once } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { createGenerateHandler, webFetch } from "../integrations/sillytavern/server.mjs";
import { vertexAccessToken } from "../src/vertex-auth.mjs";
import { sseData } from "../src/wire.mjs";

const localFetch = globalThis.fetch;
const decoder = new TextDecoder();
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const serviceAccount = () => JSON.stringify({ type: "service_account", project_id: "example-project", client_email: "fixture@example.invalid",
  token_uri: "https://oauth2.googleapis.com/token", private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) });
const adapters = secret => ({ getPromptNames: () => ({}), calculateGoogleBudgetTokens: () => undefined, safetySettings: [],
  convertGooglePrompt: messages => ({ contents: messages.map(message => ({ role: "user", parts: [{ text: message.content }] })) }),
  SECRET_KEYS: { VERTEXAI_SERVICE_ACCOUNT: "fixture" }, readSecret: () => secret });
const body = { chat_completion_source: "vertexai", model: "gemini-3-flash-preview", stream: true, vertex_anti_truncation: "streaming",
  vertexai_auth_mode: "full", vertexai_region: "global", messages: [{ role: "user", content: "你好" }] };
const nativeCall = functionCall => sseData({ candidates: [{ content: { parts: [{ functionCall }] } }] });
const piece = (stringValue, willContinue) => nativeCall({ partialArgs: [{ jsonPath: "$.content", stringValue, willContinue }], willContinue });
// The reply text in the complete events received so far.
const contents = text => text.slice(0, Math.max(0, text.lastIndexOf("\n\n"))).split("\n")
  .filter(line => line.startsWith("data:") && !line.includes("[DONE]")).flatMap(line => JSON.parse(line.slice(5)).candidates ?? [])
  .flatMap(candidate => candidate.content?.parts ?? []).map(part => part.text ?? "").join("");
// Reads until `until` holds for the text so far, or the reply ends.
async function read(reader, until = () => false, text = "") {
  for (let chunk; !until(text) && !(chunk = await reader.read()).done;) text += decoder.decode(chunk.value, { stream: true });
  return text;
}

test("direct plugin retries only the selected model's regional candidates and preserves the final rejection", async t => {
  const calls = [], secret = serviceAccount();
  const post = await tavern(t, createGenerateHandler(adapters(secret), { fetchImpl: async (url, options) => {
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "synthetic", expires_in: 3600 });
    calls.push({ url, body: options.body });
    return Response.json({ error: { code: 429, message: "capacity", status: "RESOURCE_EXHAUSTED" } },
      { status: 429, headers: { "retry-after": "0" } });
  } }));
  const input = { model: "gemini-4-neon", vertexai_region: "eu", vertex_fallback_locations: ["asia-southeast1","us"] };
  const response = await post(input);
  assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), "0");
  assert.match((await response.json()).error.message, /capacity/);
  assert.equal(response.headers.get("x-vertex-region-attempts"), "eu=429,us=429");
  assert.deepEqual(calls.map(c => c.url), ["eu","us"].map(r =>
    `https://aiplatform.${r}.rep.googleapis.com/v1/projects/example-project/locations/${r}/publishers/google/models/gemini-4-neon:streamGenerateContent?alt=sse`));
  assert.equal(calls[0].body, calls[1].body);
  for (const fallback of [["global","us","eu"], ["us","us"], ["https://untrusted.invalid"]]) {
    assert.equal((await post({ ...input, vertex_fallback_locations: fallback })).status, 400);
  }
  assert.equal(calls.length, 2);
});

// The part of SillyTavern's node-fetch this plugin relies on: https.request with no agent of its own, so
// the global agent picks the route, and the reply body as a Node stream. The repository cannot depend on
// node-fetch itself, since Git installs run npm ci in the plugin folder.
const nodeFetch = (url, { method, headers, body, signal }) => new Promise((resolve, reject) => {
  const request = https.request(url, { method, headers, signal }, reply => resolve({ status: reply.statusCode, headers: reply.headers, body: reply }));
  request.on("error", reject);
  request.end(String(body));
});

async function listen(t, server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return server;
}

async function tavern(t, handler) {
  const server = await listen(t, http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    req.body = JSON.parse(Buffer.concat(chunks).toString()); req.user = { directories: {} };
    res.status = value => { res.statusCode = value; return res; };
    res.json = value => res.end(JSON.stringify(value));
    await handler(req, res);
  }));
  return (extra, signal) => localFetch(`http://127.0.0.1:${server.address().port}`, { method: "POST", body: JSON.stringify({ ...body, ...extra }), signal });
}

test("the token exchange and the streamed Vertex reply take SillyTavern's request proxy, and cancelling stops Google's reply", { timeout: 10000 }, async t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Node's built-in fetch ignores SillyTavern's request proxy"));
  const seen = [], replies = [];
  const google = await listen(t, http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const sent = Buffer.concat(chunks).toString();
    seen.push({ host: request.headers.host, url: request.url, authorization: request.headers.authorization });
    if (request.headers.host === "oauth2.googleapis.com") {
      seen.at(-1).grant = new URLSearchParams(sent).get("grant_type");
      return response.end(JSON.stringify({ access_token: "synthetic-token", expires_in: 3600 }));
    }
    const reply = { release: deferred(), closed: deferred() };
    replies.push(reply);
    response.on("close", () => reply.closed.resolve(response.writableFinished));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(nativeCall({ name: JSON.parse(sent).tools[0].functionDeclarations[0].name, willContinue: true }) + piece("首段", true));
    await reply.release.promise;
    response.end(piece("尾段", false) + sseData({ candidates: [{ finishReason: "STOP" }], usageMetadata: { totalTokenCount: 15 } }));
  }));
  // SillyTavern's requestProxy replaces https.globalAgent with a proxy agent. This one sends every
  // connection to a local relay in front of the fake Google, in plain text so no certificate is needed.
  const relayed = [];
  const relay = net.createServer(socket => {
    relayed.push(socket);
    const upstream = net.connect(google.address().port, "127.0.0.1");
    socket.pipe(upstream).pipe(socket);
    for (const [from, to] of [[socket, upstream], [upstream, socket]]) from.on("error", () => {}).on("close", () => to.destroy());
  });
  relay.listen(0, "127.0.0.1"); await once(relay, "listening");
  const globalAgent = https.globalAgent;
  https.globalAgent = new class extends https.Agent { createConnection() { return net.connect(relay.address().port, "127.0.0.1"); } }();
  t.after(() => { https.globalAgent = globalAgent; for (const socket of relayed) socket.destroy(); relay.close(); });

  const post = await tavern(t, createGenerateHandler(adapters(serviceAccount()), { fetchImpl: webFetch(nodeFetch) }));
  const response = await post({});
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let text = await read(reader, text => contents(text).includes("首段"));
  assert.ok(!text.includes("[DONE]"), "the first piece arrives while Google is still sending");
  replies[0].release.resolve();
  text = await read(reader, undefined, text);
  assert.equal(contents(text), "首段尾段");
  assert.ok(text.endsWith("data: [DONE]\n\n"));
  assert.deepEqual(seen, [
    { host: "oauth2.googleapis.com", url: "/token", authorization: undefined, grant: "urn:ietf:params:oauth:grant-type:jwt-bearer" },
    { host: "aiplatform.googleapis.com", url: "/v1/projects/example-project/locations/global/publishers/google/models/gemini-3-flash-preview:streamGenerateContent?alt=sse",
      authorization: "Bearer synthetic-token" },
  ]);

  // Stop, as the user would mid-reply: the cached token is reused and Google's connection closes.
  const cancel = new AbortController();
  await read((await post({}, cancel.signal)).body.getReader(), text => contents(text).includes("首段"));
  cancel.abort();
  assert.equal(await replies[1].closed.promise, false, "Google's reply was still open when its connection closed");
  assert.equal(seen.length, 3);
  assert.equal(relayed.length, 3, "every request went through the replaced global agent");
});

test("a token exchange that gets no reply points to the network or proxy, not the saved credentials", async t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Node's built-in fetch ignores SillyTavern's request proxy"));
  const answers = {
    unreachable: () => { throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:7890") }); },
    rejected: () => new Response("secret-detail", { status: 401 }),
  };
  for (const [kind, answer] of Object.entries(answers)) {
    let inference = 0;
    const post = await tavern(t, createGenerateHandler(adapters(serviceAccount()), { fetchImpl: async url => {
      if (url === "https://oauth2.googleapis.com/token") return answer();
      inference++;
    } }));
    const response = await post({});
    const { error } = await response.json();
    assert.equal(response.status, 502);
    assert.equal(error.code, kind === "unreachable" ? "vertex_authentication_unreachable" : "vertex_authentication_failed");
    assert.match(error.message, kind === "unreachable" ? /^无法连接 Google.*requestProxy/ : /^Vertex 鉴权失败，请检查已保存的凭据。/);
    assert.doesNotMatch(error.message, /ECONNREFUSED|7890|secret-detail/);
    assert.equal(inference, 0);
  }
  // The token exchange's own time limit ends it the same way.
  await assert.rejects(vertexAccessToken(serviceAccount(), 20, (url, { signal }) =>
    new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)))), { unreachable: true });
});
