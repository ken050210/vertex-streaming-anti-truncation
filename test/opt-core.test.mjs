import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createGatewayServer } from "../src/gateway.mjs";
import { loadConfig, MODEL_ID, UPSTREAM_MODEL } from "../src/config.mjs";
import { googleErrorDetail, upstreamErrorLogFields } from "../src/wire.mjs";
import { wrapAntiTruncationStream } from "../src/anti-truncation.mjs";
import { guardCompletionStream } from "../src/completion-integrity.mjs";

const key = "synthetic-local-key-for-tests";
const token = "synthetic-oauth-token";
const payload = { model: MODEL_ID, messages: [{ role: "user", content: "fixture prompt" }], max_tokens: 512 };
const normal = [{ id: MODEL_ID, upstreamModel: UPSTREAM_MODEL, mode: "normal", enabled: true }];
const sse = value => "data: " + (typeof value === "string" ? value : JSON.stringify(value)) + "\n\n";
const records = wire => wire.split("\n").filter(line => line.startsWith("data:") && !line.includes("[DONE]")).map(line => JSON.parse(line.slice(5)));
// Built at runtime so the release scan never sees credential-shaped literals.
const apiKey = "AI" + "zaSy" + "Q".repeat(35);
const account = "vertex-runner@example-project." + "iam.gserviceaccount.com";

async function fixture(t, upstream, override = {}) {
  const events = [], requests = [];
  const config = { ...await loadConfig({ GATEWAY_API_KEY: key, VERTEX_PROJECT_ID: "example-project", VERTEX_ACCESS_TOKEN: token }), ...override };
  const server = createGatewayServer(config, { logger: event => events.push(event), fetchImpl: async (url, options) => {
    const request = { url, ...options, json: JSON.parse(options.body) };
    requests.push(request);
    return upstream(request);
  } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { events, requests, post };
}

test("Google error envelopes reduce to a fixed, redacted, bounded shape", () => {
  const longToken = "z".repeat(48);
  const message = `<p>Permission denied</p>\n\tfor ${account}: key ${apiKey}, bearer ${token}, id ${longToken}.`;
  const body = { error: { code: 403, status: "PERMISSION_DENIED", message, details: [
    { "@type": "type.googleapis.com/google.rpc.Help", reason: "NOT_THIS_ONE" },
    { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "IAM_PERMISSION_DENIED", metadata: { permission: "aiplatform.endpoints.predict" } }] } };
  for (const shape of [body, [body]]) {
    assert.deepEqual(googleErrorDetail(shape, token), { code: 403, status: "PERMISSION_DENIED", reason: "IAM_PERMISSION_DENIED",
      message: "Permission denied for [email]: key [key], bearer [key], id [token]." });
  }
  assert.equal(googleErrorDetail(body).message.includes(token), true, "only the given secret is removed exactly");
  const words = "abc ".repeat(1024).slice(0, 4094);
  const long = googleErrorDetail({ error: { message: words + "😀" + " more".repeat(20) } }).message;
  assert.equal(long, words + "…", "a split surrogate pair is dropped at the cap");
  assert.deepEqual(googleErrorDetail({ error: { status: "denied <b>", message: 42, details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "x".repeat(80) }] } }), null);
  for (const value of [null, "text", [], { message: "no envelope" }]) assert.equal(googleErrorDetail(value), null);
  assert.equal(googleErrorDetail({error:"text"}).message, "text");
  assert.deepEqual(upstreamErrorLogFields({ status: "NOT_FOUND", reason: null, message: "private" }), { upstreamError: { status: "NOT_FOUND", reason: null } });
  assert.deepEqual(upstreamErrorLogFields({ status: "lower", reason: "has space", message: "private" }), {});
  assert.deepEqual(upstreamErrorLogFields(null), {});
});

test("upstream HTTP errors keep their code and add Google's fields; logs keep only status and reason", async t => {
  const message = `<p>Vertex AI API has not been used in project example-project before or it is disabled.</p>
    Ask ${account} (key ${apiKey}, bearer ${token}) to enable it.`;
  const body = { error: { code: 403, status: "PERMISSION_DENIED", message, details: [
    { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", domain: "googleapis.com", metadata: { consumer: "projects/example-project" } }] } };
  for (const [shape, retry] of [["native", false], ["compatible", false], ["native", true]]) {
    const f = await fixture(t, () => Response.json(shape === "compatible" ? [body] : body, { status: 403, headers: { "retry-after": "5" } }),
      { models: normal, geminiPromptRetry: { enabled: retry, text: "retry text" } });
    const response = await f.post(payload);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("retry-after"), "5");
    const error = (await response.json()).error;
    assert.equal(error.code, "upstream_http_error");
    assert.match(error.message, /PERMISSION_DENIED.*SERVICE_DISABLED.*API has not been used/);
    assert.deepEqual(error.upstreamError, { code: 403, status: "PERMISSION_DENIED", reason: "SERVICE_DISABLED",
      message: "Vertex AI API has not been used in project example-project before or it is disabled. Ask [email] (key [key], bearer [key]) to enable it." });
    assert.deepEqual(f.events[0].upstreamError, { status: "PERMISSION_DENIED", reason: "SERVICE_DISABLED" });
    assert.equal(f.events[0].code, "upstream_http_error");
    for (const value of ["has not been used", account, apiKey, token]) assert.equal(JSON.stringify(f.events).includes(value), false);
    assert.equal(f.requests.length, 1);
  }
});

test("plain-text and prompt-rejection messages reach the client; unbounded bodies keep the status", async t => {
  const endless = () => new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('{"error":{"message":"' + "x".repeat(4096))); } });
  for (const body of [() => "private provider error", () => '{"error":"private provider error"}', endless]) {
    const f = await fixture(t, () => new Response(body(), { status: 503, headers: { "retry-after": "3" } }), { models: normal });
    const response = await f.post(payload);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "3");
    const error = (await response.json()).error;
    assert.equal(error.code, "upstream_http_error");
    assert.equal(error.upstreamError?.message, body === endless ? undefined : "private provider error");
    assert.equal(f.events[0].upstreamError, undefined);
  }
  const rejected = { error: { status: "INVALID_ARGUMENT", message: "The prompt could not be submitted." } };
  const f = await fixture(t, () => Response.json(rejected, { status: 400 }), { models: normal, geminiPromptRetry: { enabled: true, text: "retry text" } });
  const response = await f.post(payload);
  assert.equal(response.status, 400);
  const error = (await response.json()).error;
  assert.equal(error.code, "prompt_submission_failed");
  assert.match(error.message, /The prompt could not be submitted/);
  assert.deepEqual(f.events[0].upstreamError, {status:"INVALID_ARGUMENT", reason:null});
  assert.equal(f.requests.length, 2);
});

test("a stalled error body gives up after about five seconds, with or without the prompt retry", { timeout: 15000 }, async t => {
  await Promise.all([false, true].map(async retry => {
    let cancelled = false;
    const f = await fixture(t, () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('{"error":{')); },
      cancel() { cancelled = true; },
    }), { status: 503 }), { models: normal, geminiPromptRetry: { enabled: retry, text: "retry text" } });
    const started = Date.now();
    const response = await f.post(payload);
    const elapsed = Date.now() - started;
    assert.equal(response.status, 503);
    const error = (await response.json()).error;
    assert.equal(error.code, "upstream_http_error");
    assert.equal(error.upstreamError, undefined);
    assert.equal(cancelled, true, "the upstream body is cancelled");
    assert.ok(elapsed >= 4500 && elapsed < 7000, `retry=${retry}: ${elapsed} ms`);
    assert.equal(f.requests.length, 1);
  }));
});

test("provider error events in a stream carry the same fields before the first byte", async t => {
  // The request's own credential matches no key pattern here; only the exact-secret rule removes it.
  const failure = { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: `Resource exhausted for bearer ${token}. Please try again later.` } };
  for (const [name, override, expected] of [
    ["native tools", { antiTruncation: false, nativeOnly: true }, "native_stream_error"],
    ["native anti-truncation", {}, "upstream_stream_error"],
    ["compatible", { models: normal }, "upstream_stream_error"],
  ]) {
    const f = await fixture(t, () => new Response(sse(failure), { headers: { "content-type": "text/event-stream" } }), override);
    const response = await f.post({ ...payload, stream: true });
    assert.equal(response.status, 502, name);
    const error = (await response.json()).error;
    assert.equal(error.code, expected, name);
    assert.deepEqual(error.upstreamError, { code: 429, status: "RESOURCE_EXHAUSTED", reason: null, message: "Resource exhausted for bearer [key]. Please try again later." }, name);
    assert.deepEqual(f.events[0].upstreamError, { status: "RESOURCE_EXHAUSTED", reason: null });
    for (const value of ["Resource exhausted", token]) assert.equal(JSON.stringify(f.events).includes(value), false);
  }
});

test("an unrecognised native ending is rejected with Google's code in the reply and the log", async t => {
  const malformed = { candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }], usageMetadata: { totalTokenCount: 3 } };
  const nonstream = await fixture(t, () => Response.json(malformed), { nativeOnly: true });
  let response = await nonstream.post(payload);
  assert.equal(response.status, 502);
  let error = (await response.json()).error;
  assert.equal(error.code, "invalid_finish_reason");
  assert.equal(error.responseIntegrity.nativeFinishReason, "MALFORMED_FUNCTION_CALL");
  assert.equal(nonstream.events[0].responseIntegrity.nativeFinishReason, "MALFORMED_FUNCTION_CALL");

  const early = await fixture(t, () => new Response(sse(malformed)));
  response = await early.post({ ...payload, stream: true });
  assert.equal(response.headers.get("x-anti-truncation-transport"), "tool-transport-native-streaming");
  assert.equal(response.status, 502);
  error = (await response.json()).error;
  assert.equal(error.code, "invalid_finish_reason");
  assert.equal(error.responseIntegrity.nativeFinishReason, "MALFORMED_FUNCTION_CALL");
  assert.equal(early.events[0].antiTruncation.finishReason, "other");

  // After part of the synthetic call has streamed, the ending still decides the code.
  const started = await fixture(t, request => {
    const name = request.json.tools[0].functionDeclarations[0].name;
    return new Response(sse({ candidates: [{ content: { parts: [{ functionCall: { name, willContinue: true } }] } }] }) +
      sse({ candidates: [{ content: { parts: [{ functionCall: { partialArgs: [{ jsonPath: "$.content", stringValue: "private partial", willContinue: true }], willContinue: true } }] } }] }) +
      sse(malformed));
  });
  // Bytes may already be out, so the client can see a reset connection instead of a reply.
  await started.post({ ...payload, stream: true }).then(reply => reply.text()).catch(() => {});
  for (let i = 0; i < 100 && !started.events.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const event = started.events[0];
  assert.equal(event.code, "invalid_finish_reason");
  assert.equal(event.responseIntegrity.nativeFinishReason, "MALFORMED_FUNCTION_CALL");
  assert.equal(event.antiTruncation.restored, null);
  assert.equal(JSON.stringify(started.events).includes("private partial"), false);
});

test("native streams send the usage chunk only for include_usage, and the restoration result rides on the finish chunk", async t => {
  const usageMetadata = { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6, trafficType: "ON_DEMAND" };
  for (const [name, override] of [["native anti-truncation", {}], ["native tools", { antiTruncation: false, nativeOnly: true }]]) {
    for (const includeUsage of [false, true]) {
      const f = await fixture(t, request => {
        const tool = request.json.tools?.[0]?.functionDeclarations?.[0]?.name;
        const part = tool ? { functionCall: { name: tool, args: { content: "fixture answer" } } } : { text: "fixture answer" };
        return new Response(sse({ candidates: [{ content: { parts: [part] } }] }) + sse({ candidates: [{ finishReason: "STOP" }], usageMetadata }));
      }, override);
      const response = await f.post({ ...payload, stream: true, ...(includeUsage ? { stream_options: { include_usage: true } } : {}) });
      assert.equal(response.status, 200, name);
      const wire = await response.text();
      const rows = records(wire);
      assert.match(wire, /fixture answer/);
      assert.ok(wire.endsWith("data: [DONE]\n\n"));
      const empty = rows.filter(row => Array.isArray(row.choices) && !row.choices.length);
      assert.equal(empty.length, includeUsage ? 1 : 0, `${name} include_usage=${includeUsage}`);
      if (includeUsage) assert.equal(empty[0].usage.total_tokens, 6);
      assert.equal(f.events[0].trafficType, "ON_DEMAND", "the served tier is logged either way");
      const finish = rows.find(row => row.choices?.[0]?.finish_reason);
      assert.equal(finish.choices[0].finish_reason, "stop");
      assert.equal(finish.router_anti_truncation?.restored, name === "native tools" ? undefined : true);
    }
  }
});

test("the stream restorer leaves an unrecognised ending to the integrity check and drops the extra metadata chunk", async () => {
  const name = "router_emit_test";
  const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
  const call = args => ({ index: 0, id: "call-test", type: "function", function: { name, arguments: args } });
  const run = async wire => {
    const metadata = {};
    const text = await wrapAntiTruncationStream(new Response(wire), name, value => Object.assign(metadata, value)).text();
    return { rows: records(text), metadata, text };
  };
  const done = await run(sse(chunk({ tool_calls: [call('{"content":"whole"}')] })) + sse(chunk({}, "tool_calls")) + sse("[DONE]"));
  assert.equal(done.rows.length, 2, "no separate empty-choices chunk");
  assert.deepEqual(done.rows[1].router_anti_truncation, { restored: true });
  assert.equal(done.rows[1].choices[0].finish_reason, "stop");
  assert.deepEqual(done.metadata, { finishReason: "stop", restored: true, streamDone: true });
  const odd = await run(sse(chunk({ tool_calls: [call('{"content":"partial')] })) +
    sse({ choices: [{ index: 0, delta: {}, finish_reason: "error", native_finish_reason: "MALFORMED_FUNCTION_CALL" }] }) + sse("[DONE]"));
  assert.equal(odd.rows.at(-1).choices[0].finish_reason, "error");
  assert.equal(odd.rows.at(-1).choices[0].native_finish_reason, "MALFORMED_FUNCTION_CALL");
  assert.equal(odd.rows.some(row => row.router_anti_truncation), false);
  assert.deepEqual(odd.metadata, { finishReason: "error", restored: null, streamDone: true });
  await assert.rejects(guardCompletionStream(new Response(odd.text)).text(), /invalid_finish_reason/);
});
