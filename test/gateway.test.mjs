import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import http from "node:http";
import { createGatewayServer, upstreamDispatcher } from "../src/gateway.mjs";
import { loadConfig, MODEL_ID, UPSTREAM_MODEL } from "../src/config.mjs";

const key = "synthetic-local-key-for-tests";
const token = "synthetic-oauth-token";
const payload = { model: MODEL_ID, messages: [{ role: "user", content: "Write a line about a river." }], max_tokens: 512 };
const sse = data => new TextEncoder().encode("data: " + JSON.stringify(data) + "\n\n");
const call = functionCall => sse({ candidates: [{ content: { parts: [{ functionCall }] } }] });
const part = (stringValue, willContinue = true) => call({ partialArgs: [{ jsonPath: "$.content", stringValue, willContinue }], willContinue: true });
const finish = reason => sse({ candidates: [{ finishReason: reason }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20, trafficType: "ON_DEMAND" } });
const records = wire => wire.split("\n").filter(line => line.startsWith("data:") && !line.includes("[DONE]")).map(line => JSON.parse(line.slice(5)));
const visible = wire => records(wire).map(record => record.choices?.[0]?.delta?.content ?? "").join("");
const completion = (name, reason = "tool_calls") => ({
  id: "chatcmpl-fixture", object: "chat.completion", model: UPSTREAM_MODEL,
  choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_fixture", type: "function", function: { name, arguments: JSON.stringify({ content: "OK" }) } }] }, finish_reason: reason }],
  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
});

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
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, auth = key) => fetch(base + path, { headers: auth ? { authorization: "Bearer " + auth } : {} });
  const post = body => fetch(base + "/v1/chat/completions", {
    method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { events, requests, base, get, post };
}

test("failed nonstream and buffered replies preserve terminal diagnostics without retry or private content", async t => {
  for (const [choice, reason, finishReason, outcome] of [
    [{ finish_reason: "stop" }, "missing_message", "stop", "error"],
    [{ message: null, finish_reason: "content_filter" }, "missing_message", "content_filter", "error"],
    [{ message: [], finish_reason: "length" }, "invalid_message", "length", "error"],
    [{ delta: { content: "private delta marker" }, finish_reason: "stop" }, "unexpected_stream_chunk", "stop", "error"],
    [{ message: { content: "", reasoning_content: "private thought marker" }, finish_reason: "stop" }, "empty_completion", "stop", "empty"],
  ]) for (const mode of ["normal", "buffered"]) {
    const f = await fixture(t, () => Response.json({ choices: [choice] }), {
      models: [{ id: MODEL_ID, upstreamModel: UPSTREAM_MODEL, mode, enabled: true }],
      geminiPromptRetry: { enabled: true, text: "private retry prefix marker" },
    });
    const response = await f.post({ ...payload, stream: mode === "buffered" });
    assert.equal(response.status, 502);
    const error = (await response.json()).error;
    assert.equal(error.code, reason);
    assert.equal(error.responseIntegrity.finishReason, finishReason);
    assert.equal(error.responseIntegrity.outcome, outcome);
    assert.equal(f.requests.length, 1);
    assert.equal(f.events[0].responseIntegrity.finishReason, finishReason);
    assert.equal(f.events[0].responseIntegrity.outcome, outcome);
    assert.notEqual(f.events[0].antiTruncation.restored, true);
    assert.equal(f.events[0].geminiCompatibility.promptRetried, false);
    assert.equal(JSON.stringify(f.requests).includes("retry prefix"), false);
    assert.equal(JSON.stringify(f.events).includes("private"), false);
  }
});

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(10); }
  assert.fail("Timed out waiting for local fixture");
}

test("loopback HTTP API requires auth and validates requests before any upstream call", async t => {
  const f = await fixture(t, () => assert.fail("Unexpected upstream request"));
  assert.equal((await f.get("/healthz", null)).status, 200);
  for (const path of ["/v1/models", "/admin/events"]) {
    assert.equal((await f.get(path, null)).status, 401);
    assert.equal((await f.get(path, "wrong-key")).status, 401);
  }
  assert.deepEqual((await (await f.get("/v1/models")).json()).data.map(x => x.id), [MODEL_ID]);
  assert.equal((await f.get("/unknown")).status, 404);
  for (const body of ["bad-json", {}, { ...payload, model: "unavailable" }, { ...payload, messages: [] }, { ...payload, stream: "true" }]) {
    assert.equal((await f.post(body)).status, 400);
  }
  assert.equal(f.requests.length, 0);
});

test("native HTTP text arrives before upstream completion, with matching metadata-only acceptance logs", { timeout: 5000 }, async t => {
  let controller;
  const f = await fixture(t, request => {
    assert.match(request.url, /\/gemini-3\.7-flash:streamGenerateContent\?alt=sse$/);
    assert.equal(request.headers.authorization, "Bearer " + token);
    assert.equal(request.redirect, "error");
    assert.equal(request.json.toolConfig.functionCallingConfig.streamFunctionCallArguments, true);
    assert.equal(request.json.generationConfig.maxOutputTokens, 512);
    assert.equal(request.json.safetySettings, undefined);
    const name = request.json.tools[0].functionDeclarations[0].name;
    return new Response(new ReadableStream({ start(output) {
      controller = output;
      output.enqueue(call({ name, willContinue: true }));
      output.enqueue(part("The river "));
    } }));
  });
  const response = await f.post({ ...payload, stream: true, thinking: { type: "disabled" } });
  assert.equal(response.headers.get("x-anti-truncation-transport"), "tool-transport-native-streaming");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let wire = "";
  while (!wire.includes("The river ")) wire += decoder.decode((await reader.read()).value, { stream: true });
  assert.equal(f.events.length, 0, "Upstream must still be open when the client receives text");
  assert.equal(wire.includes("[DONE]"), false);
  controller.enqueue(part("flows.", false));
  controller.enqueue(call({}));
  controller.enqueue(finish("STOP"));
  controller.close();
  for (;;) { const { done, value } = await reader.read(); if (done) break; wire += decoder.decode(value, { stream: true }); }
  assert.equal(visible(wire), "The river flows.");
  assert.equal(wire.includes("[DONE]"), true);
  assert.equal(records(wire).some(x => x.choices?.[0]?.delta?.tool_calls), false);
  assert.equal(records(wire).find(x => x.usage).usage.traffic_type, "ON_DEMAND");
  const events = (await (await f.get("/admin/events")).json()).events;
  assert.equal(events[0].requestId, response.headers.get("x-request-id"));
  assert.deepEqual(events[0].antiTruncation, { transport: "tool-transport-native-streaming", restored: true, finishReason: "stop", streamDone: true });
  assert.deepEqual(f.events, events);
  const logs = JSON.stringify(events);
  for (const privateValue of [key, token, payload.messages[0].content, "The river", "router_emit_"]) assert.equal(logs.includes(privateValue), false);
  assert.equal(f.requests.length, 1);
});

test("normal restoration preserves usage and length endings; bypass and fallback preserve request fields", async t => {
  const f = await fixture(t, request => {
    assert.match(request.url, /\/endpoints\/openapi\/chat\/completions$/);
    assert.equal(request.json.model, UPSTREAM_MODEL);
    const name = request.json.tools?.[0]?.function.name;
    if (request.json.stream) return new Response('data: {"choices":[{"index":0,"delta":{"content":"plain"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    return Response.json(name ? completion(name, "length") : { choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }] });
  });
  const response = await f.post(payload);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, "OK");
  assert.equal(body.choices[0].finish_reason, "length");
  assert.equal(body.router_anti_truncation.restored, true);
  assert.equal(body.usage.total_tokens, 20);
  assert.equal(f.events[0].antiTruncation.finishReason, "length");
  const skipped = { ...payload, response_format: { type: "json_object" }, unusual: { value: 1 } };
  await (await f.post(skipped)).json();
  assert.deepEqual(f.requests[1].json, { ...skipped, model: UPSTREAM_MODEL, stream: false });
  assert.equal(f.events[1].antiTruncation.restored, false);
  assert.equal(f.events[1].antiTruncation.transport, "structured-output");
  const fallback = await f.post({ ...payload, stream: true, custom_extension: { retain: true } });
  assert.equal(fallback.headers.get("x-anti-truncation-transport"), "tool-transport-buffered-fields");
  assert.equal(visible(await fallback.text()), "plain");
  assert.deepEqual(f.requests[2].json.custom_extension, { retain: true });
  assert.equal(f.events[2].antiTruncation.restored, false);
});

test("upstream errors are not retried or logged as provider text, and input/JSON bounds are enforced", async t => {
  const denied = await fixture(t, () => new Response('private provider error', { status: 429, headers: { "retry-after": "7" } }));
  const response = await denied.post(payload);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "7");
  assert.equal((await response.json()).error.code, "upstream_http_error");
  assert.equal(JSON.stringify(denied.events).includes("private provider"), false);
  assert.equal(denied.requests.length, 1);
  const large = await fixture(t, () => assert.fail("Oversized body must not be forwarded"), { bodyLimitBytes: 32 });
  assert.equal((await large.post(payload)).status, 413);
  for (const invalid of ['{"error":{"message":"private provider error"}}', '{}', 'not-json', 'x'.repeat(2048)]) {
    const f = await fixture(t, () => new Response(invalid), { bodyLimitBytes: 1024 });
    assert.equal((await f.post(payload)).status, 502);
    assert.equal(f.requests.length, 1);
  }
});

test("client disconnect cancels the upstream request without recording restored success", { timeout: 5000 }, async t => {
  let upstreamCancelled = false;
  const f = await fixture(t, request => new Response(new ReadableStream({
    start(controller) {
      const name = request.json.tools[0].functionDeclarations[0].name;
      controller.enqueue(call({ name, willContinue: true }));
      controller.enqueue(part("The river "));
      request.signal.addEventListener("abort", () => controller.error(new Error("cancelled")), { once: true });
    },
    cancel() { upstreamCancelled = true; },
  })));
  const response = await f.post({ ...payload, stream: true });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await waitFor(() => f.events.length === 1);
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(upstreamCancelled || f.requests[0].signal.aborted, true);
  assert.equal(f.events[0].status, 499);
  assert.equal(f.events[0].antiTruncation.restored, null);
  assert.equal(f.events[0].antiTruncation.streamDone, false);
  assert.equal(f.requests.length, 1);
});

test("failure after downstream bytes interrupts the stream and cannot become a successful stop", { timeout: 5000 }, async t => {
  let controller;
  const f = await fixture(t, request => new Response(new ReadableStream({ start(output) {
    controller = output;
    output.enqueue(call({ name: request.json.tools[0].functionDeclarations[0].name, willContinue: true }));
    output.enqueue(part("A partial river line"));
  } })));
  const response = await f.post({ ...payload, stream: true });
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.equal(first.includes("[DONE]"), false);
  controller.close();
  await assert.rejects(async () => { while (!(await reader.read()).done) {} });
  await waitFor(() => f.events.length === 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.events[0].status, 502);
  assert.equal(f.events[0].antiTruncation.restored, null);
  assert.equal(f.events[0].antiTruncation.streamDone, false);
});

test("fields Google documents as unsupported are removed before the first submission", async t => {
  const tuned = { ...payload, temperature: 0.9, top_p: 0.95, top_k: 40, presence_penalty: 0.3, frequency_penalty: 0.2, n: 1, seed: 7 };
  const dropped = ["temperature", "top_p", "top_k", "presence_penalty", "frequency_penalty", "n"];
  for (const nativeOnly of [false, true]) {
    const f = await fixture(t, request => request.json.contents
      ? Response.json({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }] })
      : Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }),
    { nativeOnly, models: [{ id: MODEL_ID, upstreamModel: UPSTREAM_MODEL, mode: "normal" }] });
    const response = await f.post(tuned);
    assert.equal(response.status, 200); await response.text();
    assert.equal(f.requests.length, 1, "no rejected round trip is needed");
    assert.equal(response.headers.get("x-gemini-dropped-params"), dropped.join(","));
    assert.deepEqual(f.events.at(-1).droppedParams, dropped);
    if (nativeOnly) assert.deepEqual(f.requests[0].json.generationConfig, { maxOutputTokens: 512, seed: 7 });
    else assert.deepEqual(Object.keys(f.requests[0].json).sort(), ["max_tokens", "messages", "model", "seed", "stream"]);
    assert.equal(f.requests[0].dispatcher, await upstreamDispatcher(600000), "the configured timeout reaches fetch");
  }
});

test("upstream calls use the configured timeout instead of fetch's fixed 300 s header limit", async t => {
  const slow = http.createServer((request, response) => setTimeout(() => response.end("late"), 1500));
  slow.listen(0, "127.0.0.1"); await once(slow, "listening");
  t.after(() => new Promise(resolve => { slow.close(resolve); slow.closeAllConnections(); }));
  const url = "http://127.0.0.1:" + slow.address().port + "/";
  // undici checks header timers on a ~0.5 s tick, hence the wide margins.
  const short = await upstreamDispatcher(100);
  assert.ok(short, "the built-in fetch Agent must be reachable on this Node version");
  await assert.rejects(fetch(url, { dispatcher: short }), error => error.cause?.code === "UND_ERR_HEADERS_TIMEOUT");
  assert.equal(await (await fetch(url, { dispatcher: await upstreamDispatcher(5000) })).text(), "late");
});
