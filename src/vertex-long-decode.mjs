import { createSseParser, isObject, protocolError, readUpstreamError, sseData, upstreamMessage } from "./wire.mjs";

// Gemini 4 Argon long decode, documented for generateContent and streamGenerateContent in
// v1beta1 only. A reply that reaches one request's output limit ends with finishReason
// CONTINUATION and a continuationToken; the same request sent again with that token
// continues it. The requests are joined here into one native reply, so the readers after
// this one see an ordinary response.
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon
export const longDecodeUrl = url => url.replace(/^(https:\/\/[^/]+\/)v1\//, "$1v1beta1/");

const partsOf = candidate => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
// Every request is billed, so usage adds up across them; a stream reports each request's running total.
const addUsage = (a, b) => !a || !b ? b ?? a : Object.fromEntries(Object.entries({ ...a, ...b })
  .map(([key, value]) => [key, typeof a[key] === "number" && typeof b[key] === "number" ? a[key] + b[key] : value]));
// A continued request must have produced output, or the requests could repeat without end.
const progressed = (hasParts, usage) => hasParts || (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0) > 0;

// send(body) posts one request and resolves to its Response. A failed first request is
// returned as it is. A failed later one is returned too when unary; a stream ends with an
// error event instead, since the text it already delivered cannot be taken back.
export async function fetchLongDecode(send, body, stream) {
  const first = await send(body);
  if (!first.ok || !first.body) return first;
  return stream ? joinStream(send, body, first) : joinUnary(send, body, first);
}

async function joinUnary(send, body, response) {
  const parts = [];
  let usage, continued = false;
  for (;;) {
    const text = await response.text();
    let reply;
    try { reply = JSON.parse(text); } catch {}
    const candidate = isObject(reply) && Array.isArray(reply.candidates) && isObject(reply.candidates[0]) ? reply.candidates[0] : null;
    const token = candidate?.finishReason === "CONTINUATION" && candidate.continuationToken;
    if (!token) {
      // A reply that ended in its first request, or a broken one, passes on as it arrived.
      if (!continued || !candidate) return new Response(text, { status: response.status, headers: response.headers });
      return new Response(JSON.stringify({ ...reply, usageMetadata: addUsage(usage, reply.usageMetadata),
        candidates: [{ ...candidate, content: { role: "model", ...candidate.content, parts: [...parts, ...partsOf(candidate)] } }] }),
      { status: response.status, headers: { "content-type": "application/json; charset=utf-8" } });
    }
    if (!progressed(partsOf(candidate).length > 0, reply.usageMetadata)) throw protocolError("long_decode_no_progress");
    parts.push(...partsOf(candidate));
    usage = addUsage(usage, reply.usageMetadata);
    continued = true;
    response = await send({ ...body, continuationToken: token });
    if (!response.ok) return response;
  }
}

function joinStream(send, body, first) {
  const encoder = new TextEncoder(), queue = [];
  let reader = first.body.getReader(), parser, token, finishReason, moved, hopUsage, usage, ended, closed = false;
  const start = () => {
    token = finishReason = hopUsage = undefined; moved = ended = false;
    parser = createSseParser(({ raw, data }) => {
      let event;
      try { event = JSON.parse(data); } catch {}
      if (!isObject(event)) return void queue.push(raw + "\n\n");
      const candidate = Array.isArray(event.candidates) && isObject(event.candidates[0]) ? event.candidates[0] : null;
      if (candidate) {
        // Checkpoints carry the latest token; only the last request's ending reaches the reader.
        if (candidate.continuationToken) token = candidate.continuationToken;
        if (candidate.finishReason) finishReason = candidate.finishReason;
        if (partsOf(candidate).length) moved = true;
        delete candidate.continuationToken;
        if (candidate.finishReason === "CONTINUATION") delete candidate.finishReason;
      }
      if (isObject(event.usageMetadata)) { hopUsage = event.usageMetadata; event.usageMetadata = addUsage(usage, hopUsage); }
      queue.push(sseData(event));
    });
  };
  start();
  return new Response(new ReadableStream({
    async pull(controller) {
      for (;;) {
        if (queue.length) return controller.enqueue(encoder.encode(queue.shift()));
        if (closed) return controller.close();
        if (!ended) {
          const { done, value } = await reader.read();
          if (done) { parser.finish(); ended = true; } else parser.push(value);
          continue;
        }
        // This request has ended and its events are out: stop, or continue the reply.
        if (finishReason !== "CONTINUATION" || !token) { closed = true; continue; }
        if (!progressed(moved, hopUsage)) throw protocolError("long_decode_no_progress");
        usage = addUsage(usage, hopUsage);
        const next = await send({ ...body, continuationToken: token });
        if (!next.ok || !next.body) {
          const detail = await readUpstreamError(next);
          queue.push(sseData({ error: { code: next.status, message: upstreamMessage(detail, `Long decode continuation request failed with HTTP ${next.status}.`) } }));
          closed = true;
          continue;
        }
        reader = next.body.getReader();
        start();
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  }), { status: first.status, headers: first.headers });
}
