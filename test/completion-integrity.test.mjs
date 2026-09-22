import test from "node:test";
import assert from "node:assert/strict";
import { guardCompletionStream, inspectCompletion, integrityLogFields } from "../src/completion-integrity.mjs";
import { vertexJsonSchema } from "../src/vertex-schema.mjs";

const event = value => "data: " + (typeof value === "string" ? value : JSON.stringify(value)) + "\n\n";
const chunk = (delta, finish_reason = null, index = 0) => ({ choices: [{ index, delta, finish_reason }] });
const wireResponse = (wire, slice = 7) => {
  const bytes = new TextEncoder().encode(wire);
  return new Response(new ReadableStream({ start(c) {
    for (let i = 0; i < bytes.length; i += slice) c.enqueue(bytes.slice(i, i + slice));
    c.close();
  } }), { headers: { "content-type": "text/event-stream" } });
};

test("rejects malformed, empty and reasoning-only normal completions while preserving explicit limits and tools", () => {
  for (const value of [{}, { choices: [{}] }, { choices: [{ message: { content: "" }, finish_reason: "stop" }] },
    { choices: [{ message: { reasoning_content: "private reasoning" }, finish_reason: "stop" }] },
    { choices: [{ message: { content: "partial" }, finish_reason: null }] }]) assert.equal(inspectCompletion(value).valid, false);
  const completion = (message, finish_reason) => inspectCompletion({ choices: [{ message, finish_reason }] });
  assert.equal(completion({ content: "", reasoning_content: "private" }, "length").integrity.outcome, "length");
  assert.equal(completion({ content: "", refusal: "declined" }, "stop").integrity.outcome, "content_filter");
  assert.equal(completion({ content: "" }, "content_filter").valid, true);
  assert.equal(completion({ content: null, tool_calls: [{ function: { name: "f", arguments: "{}" } }] }, "tool_calls").valid, true);
  assert.equal(completion({ tool_calls: [{ function: { name: "f", arguments: "{" } }] }, "tool_calls").valid, false);
});

test("validates fragmented Unicode and multiline SSE without modifying a single byte or retaining text in metadata", async () => {
  const wire = ": keepalive\r\n\r\ndata: {\"choices\":[\r\ndata: {\"index\":0,\"delta\":{\"content\":\"中文 😀\"},\"finish_reason\":null}]}\r\n\r\n" +
    event(chunk({}, "stop")) + event({ choices: [], usage: { completion_tokens: 8 } }) + event("[DONE]");
  const snapshots = [];
  const guarded = guardCompletionStream(wireResponse(wire, 1), value => snapshots.push(integrityLogFields(value)));
  assert.equal(await guarded.text(), wire);
  assert.equal(snapshots.at(-1).responseIntegrity.outcome, "complete");
  assert.equal(snapshots.at(-1).responseIntegrity.streamDone, true);
  assert.equal(JSON.stringify(snapshots).includes("中文"), false);
});

test("partial EOF, errors after content, malformed JSON, missing finish and data after DONE cannot pass", async () => {
  const text = event(chunk({ content: "private partial" }));
  const cases = [
    [text, /incomplete_stream/],
    [text + event({ error: { message: "private upstream error" } }), /upstream_stream_error/],
    [text + "event: error\ndata: {}\n\n", /upstream_stream_error/],
    [text + "data: {broken}\n\n", /invalid_sse_json/],
    [text + event("[DONE]"), /missing_finish_reason/],
    [text + event(chunk({}, "stop")) + event("[DONE]") + text, /data_after_done/],
    [event(chunk({ role: "assistant" })), /empty_stream/],
    [event(chunk({ reasoning_content: "thought" })) + event(chunk({}, "stop")) + event("[DONE]"), /empty_completion/],
  ];
  for (const [wire, pattern] of cases) await assert.rejects(guardCompletionStream(wireResponse(wire)).text(), pattern);
});

test("SSE validates every candidate and reports length, refusal and tool endings honestly", async () => {
  for (const [delta, reason, outcome] of [[{ content: "x" }, "length", "length"],
    [{ refusal: "declined" }, "stop", "content_filter"],
    [{ tool_calls: [{ index: 0, function: { name: "f", arguments: "{}" } }] }, "tool_calls", "tool_calls"]]) {
    let result;
    await guardCompletionStream(wireResponse(event(chunk(delta)) + event(chunk({}, reason)) + event("[DONE]")), value => { result = value; }).text();
    assert.equal(result.outcome, outcome);
  }
  const multiple = event(chunk({ content: "first" }, "stop", 0)) + event(chunk({ content: "second" }, null, 1)) + event("[DONE]");
  await assert.rejects(guardCompletionStream(wireResponse(multiple)).text(), /missing_finish_reason/);
});

test("integrity logging projects only fixed enums and booleans", () => {
  const result = integrityLogFields({ outcome: "private-output", finishReason: "private-tool", streamDone: "true", content: "secret", hasContent: 1 });
  assert.deepEqual(result.responseIntegrity, { outcome: "incomplete", finishReason: null, streamDone: null,
    hasContent: false, hasToolCalls: false, hasReasoning: false, hasRefusal: false });
  assert.deepEqual(integrityLogFields(null), {});
});

test("JSON Schema preserves business property names, closed objects and unconstrained arrays", () => {
  const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
    properties: { additionalProperties: { type: "string" }, $schema: { type: "string", enum: ["additionalProperties"] },
      values: { type: "array" }, nested: { type: ["array", "null"], items: { type: "array" } } },
    required: ["additionalProperties", "$schema", "values"] };
  const before = structuredClone(schema);
  const result = vertexJsonSchema(schema);
  assert.deepEqual(result, Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema")));
  assert.deepEqual(schema, before);
  assert.equal(result.properties.values.items, undefined);
});

test("unsupported constraints and unresolved or external refs fail with a parameter path", () => {
  for (const schema of [{ oneOf: [{ type: "string" }, { type: "number" }] },
    { type: "string", pattern: "x" }, { $ref: "https://example.invalid/schema" }, { $ref: "#/$defs/missing" },
    { type: "object", properties: { bad: { type: "invalid" } } }]) {
    assert.throws(() => vertexJsonSchema(schema), error => error.status === 400 && error.code === "unsupported_native_schema" && error.param.startsWith("/response_format/"));
  }
  const schema = { type: "object", $defs: { value: { type: ["string", "null"] } }, properties: { value: { $ref: "#/$defs/value" } } };
  assert.deepEqual(vertexJsonSchema(schema), schema);
});

test("native structured output validates closed objects, refs and arrays without repairing values", async () => {
  const schema = vertexJsonSchema({ type: "object", additionalProperties: false, required: ["values"],
    properties: { values: { type: "array", items: { anyOf: [{ type: "null" }, { type: "array" }] } } } });
  const { assertStructuredOutput } = await import("../src/vertex-schema.mjs");
  assert.doesNotThrow(() => assertStructuredOutput('{"values":[null,[1,"x"]]}', { schema }));
  assert.throws(() => assertStructuredOutput('{"values":[true]}', { schema }), /schema_validation_failed/);
  const payload = event(chunk({ content: '{"values":[null],"extra":true}' })) + event(chunk({}, "stop")) + event("[DONE]");
  await assert.rejects(guardCompletionStream(wireResponse(payload), () => {}, { schema }).text(), /schema_validation_failed/);
  const limited = event(chunk({ content: '{"values":[' })) + event(chunk({}, "length")) + event("[DONE]");
  let audit;
  await guardCompletionStream(wireResponse(limited), value => { audit = value; }, { schema }).text();
  assert.equal(audit.outcome, "length");
});
