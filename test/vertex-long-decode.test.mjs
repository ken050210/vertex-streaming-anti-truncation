import test from "node:test";
import assert from "node:assert/strict";
import { fetchLongDecode, longDecodeUrl } from "../src/vertex-long-decode.mjs";

// Vertex ends SSE events with CRLF pairs.
const sse = (...events) => new Response(events.map(event => "data: " + JSON.stringify(event) + "\r\n\r\n").join(""),
  { headers: { "content-type": "text/event-stream" } });
const events = text => text.split(/\r?\n\r?\n/).filter(Boolean).map(raw => JSON.parse(raw.replace(/^data: /, "")));
const text = value => ({ content: { role: "model", parts: [{ text: value }] } });
const usage = (prompt, output) => ({ promptTokenCount: prompt, candidatesTokenCount: output, totalTokenCount: prompt + output, trafficType: "ON_DEMAND" });
const body = { contents: [{ role: "user", parts: [{ text: "Write" }] }], generationConfig: { maxOutputTokens: 100000 } };
function upstream(...responses) {
  const sent = [];
  return { sent, send: async value => { sent.push(structuredClone(value)); return responses[sent.length - 1]; } };
}

test("long decode switches only the API version to v1beta1", () => {
  assert.equal(longDecodeUrl("https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/gemini-4-argon:generateContent"),
    "https://aiplatform.googleapis.com/v1beta1/projects/p/locations/global/publishers/google/models/gemini-4-argon:generateContent");
  assert.equal(longDecodeUrl("https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse"),
    "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/p/locations/us-central1/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse");
});

test("a unary reply that ends in one request passes through unchanged", async () => {
  const reply = JSON.stringify({ candidates: [{ ...text("Done"), finishReason: "STOP" }], usageMetadata: usage(10, 2) });
  const google = upstream(new Response(reply, { headers: { "content-type": "application/json" } }));
  const response = await fetchLongDecode(google.send, body, false);
  assert.equal(await response.text(), reply);
  assert.deepEqual(google.sent, [body]);
});

test("unary continuations resend the request with each token and join into one reply", async () => {
  const google = upstream(
    Response.json({ candidates: [{ ...text("前半"), finishReason: "CONTINUATION", continuationToken: "token-1" }], usageMetadata: usage(10, 5) }),
    Response.json({ candidates: [{ ...text("中段"), finishReason: "CONTINUATION", continuationToken: "token-2" }], usageMetadata: usage(10, 5) }),
    Response.json({ candidates: [{ ...text("后半"), finishReason: "STOP", safetyRatings: [] }], usageMetadata: usage(10, 3) }));
  const reply = await (await fetchLongDecode(google.send, body, false)).json();
  assert.deepEqual(google.sent, [body, { ...body, continuationToken: "token-1" }, { ...body, continuationToken: "token-2" }]);
  assert.deepEqual(reply.candidates, [{ content: { role: "model", parts: [{ text: "前半" }, { text: "中段" }, { text: "后半" }] }, finishReason: "STOP", safetyRatings: [] }]);
  // Every request is billed, so its input counts again.
  assert.deepEqual(reply.usageMetadata, { promptTokenCount: 30, candidatesTokenCount: 13, totalTokenCount: 43, trafficType: "ON_DEMAND" });
});

test("a failed unary continuation returns its failure, and one without output stops the loop", async () => {
  const continued = Response.json({ candidates: [{ ...text("前半"), finishReason: "CONTINUATION", continuationToken: "token-1" }] });
  const failed = upstream(continued, new Response('{"error":{"code":429}}', { status: 429 }));
  assert.equal((await fetchLongDecode(failed.send, body, false)).status, 429);
  assert.equal(failed.sent.length, 2);
  const empty = upstream(Response.json({ candidates: [{ finishReason: "CONTINUATION", continuationToken: "token-1" }], usageMetadata: usage(10, 0) }));
  await assert.rejects(fetchLongDecode(empty.send, body, false), { code: "long_decode_no_progress" });
  assert.equal(empty.sent.length, 1);
  const rejected = upstream(new Response("{}", { status: 400 }));
  assert.equal((await fetchLongDecode(rejected.send, body, false)).status, 400);
});

test("streamed continuations join into one stream that ends once, with usage added up", async () => {
  const google = upstream(
    sse({ candidates: [{ ...text("A"), continuationToken: "checkpoint-1" }] },
      { candidates: [{ ...text("B"), finishReason: "CONTINUATION", continuationToken: "token-1" }], usageMetadata: usage(10, 6) }),
    sse({ candidates: [text("C")], usageMetadata: usage(10, 1) },
      { candidates: [{ ...text("D"), finishReason: "STOP" }], usageMetadata: usage(10, 4) }));
  const response = await fetchLongDecode(google.send, body, true);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const joined = events(await response.text());
  assert.deepEqual(google.sent, [body, { ...body, continuationToken: "token-1" }]);
  assert.deepEqual(joined.map(event => event.candidates[0].content.parts[0].text), ["A", "B", "C", "D"]);
  assert.deepEqual(joined.map(event => event.candidates[0].finishReason), [undefined, undefined, undefined, "STOP"]);
  assert.equal(JSON.stringify(joined).includes("continuationToken"), false);
  // Within a request each usage report is a running total; across requests they add up.
  assert.deepEqual(joined.map(event => event.usageMetadata?.totalTokenCount), [undefined, 16, 27, 30]);
});

test("a streamed continuation that fails ends with an error event; an interrupted request is not continued", async () => {
  const continued = () => sse({ candidates: [{ ...text("A"), finishReason: "CONTINUATION", continuationToken: "token-1" }] });
  const failed = upstream(continued(), new Response("unavailable", { status: 503 }));
  const ending = events(await (await fetchLongDecode(failed.send, body, true)).text()).at(-1);
  assert.deepEqual(ending, { error: { code: 503, message: "unavailable" } });
  const interrupted = upstream(sse({ candidates: [{ ...text("A"), continuationToken: "checkpoint-1" }] }));
  assert.equal(events(await (await fetchLongDecode(interrupted.send, body, true)).text()).length, 1);
  assert.equal(interrupted.sent.length, 1);
  const empty = upstream(sse({ candidates: [{ finishReason: "CONTINUATION", continuationToken: "token-1" }] }));
  await assert.rejects((await fetchLongDecode(empty.send, body, true)).text(), { code: "long_decode_no_progress" });
  assert.equal(empty.sent.length, 1);
});
