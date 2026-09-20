import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { MODEL_ID } from "./config.mjs";
import { prepareAntiTruncation, restoreAntiTruncationCompletion, wrapAntiTruncationStream, antiTruncationLogFields } from "./anti-truncation.mjs";
import { buildNativeUrl } from "./vertex-native.mjs";
import { buildNativeTextBody, wrapNativeTextStream } from "./vertex-text-stream.mjs";

class Problem extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
function authorized(request, key) {
  const actual = Buffer.from(request.headers.authorization || "");
  const expected = Buffer.from("Bearer " + key);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function send(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
async function readRequest(request, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total <= limit) chunks.push(chunk);
  }
  if (total > limit) throw new Problem(413, "request_too_large");
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Problem(400, "invalid_json"); }
}
async function readCompletion(response, limit) {
  const chunks = [];
  let total = 0;
  for await (const bytes of response.body ?? []) {
    total += bytes.length;
    if (total > limit) throw new Problem(502, "upstream_body_limit");
    chunks.push(bytes);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Problem(502, "invalid_upstream_json"); }
  if (!parsed || parsed.error || !Array.isArray(parsed.choices) || !parsed.choices.length) {
    throw new Problem(502, "invalid_upstream_completion");
  }
  return parsed;
}
function validate(payload, model) {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") throw new Problem(400, "invalid_request");
  if (payload.model !== model) throw new Problem(400, "unsupported_model");
  if (!Array.isArray(payload.messages) || !payload.messages.length || payload.messages.some(message =>
    !message || typeof message !== "object" || !["system", "developer", "user", "assistant", "tool", "function"].includes(message.role))) {
    throw new Problem(400, "invalid_messages");
  }
  if (payload.stream != null && typeof payload.stream !== "boolean") throw new Problem(400, "invalid_stream");
}

// fetchImpl exists for local protocol fixtures; HTTP clients cannot choose hosts,
// credentials or the upstream model. The CLI always uses Google's fixed endpoint.
export function createGatewayServer(config, { fetchImpl = fetch, logger = () => {} } = {}) {
  const events = [];
  const server = http.createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    const requestId = randomUUID();
    response.setHeader("x-request-id", requestId);
    let pathname;
    try { pathname = new URL(request.url, "http://localhost").pathname; }
    catch { return send(response, 400, { error: { code: "invalid_path" } }); }
    if (request.method === "GET" && pathname === "/healthz") return send(response, 200, { status: "ok", version: "0.1.0" });
    if (!authorized(request, config.gatewayKey)) return send(response, 401, { error: { code: "unauthorized" } });
    if (request.method === "GET" && pathname === "/v1/models") return send(response, 200, {
      object: "list", data: [{ id: config.model || MODEL_ID, object: "model", owned_by: "vertex-streaming-anti-truncation" }],
    });
    if (request.method === "GET" && pathname === "/admin/events") return send(response, 200, { events: events.slice().reverse() });
    if (request.method !== "POST" || pathname !== "/v1/chat/completions") return send(response, 404, { error: { code: "not_found" } });

    const started = Date.now();
    const client = new AbortController();
    const deadline = AbortSignal.timeout(config.timeoutMs);
    const signal = AbortSignal.any([client.signal, deadline]);
    const onClose = () => { if (!response.writableEnded) client.abort(); };
    response.once("close", onClose);
    request.once("aborted", onClose);
    let stream = false, audit = null, status = 500, code = null;
    try {
      const payload = await readRequest(request, config.bodyLimitBytes);
      validate(payload, config.model);
      stream = payload.stream === true;
      const transport = prepareAntiTruncation(payload, true, true);
      audit = { transport: transport.reason, restored: transport.toolName ? null : false,
        finishReason: null, streamDone: stream && transport.toolName ? false : null };
      response.setHeader("x-anti-truncation-transport", transport.reason);
      const bearer = await config.accessToken();
      const url = transport.nativeStreaming
        ? buildNativeUrl(config.baseUrl, config.upstreamModel, true)
        : config.baseUrl + "/chat/completions";
      const body = transport.nativeStreaming ? buildNativeTextBody(transport.payload)
        : { ...transport.payload, model: config.upstreamModel, stream };
      let upstream = await fetchImpl(url, { method: "POST", redirect: "error", signal,
        headers: { authorization: "Bearer " + bearer, "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json" },
        body: JSON.stringify(body) });
      if (!upstream.ok) {
        const retryAfter = upstream.headers.get("retry-after");
        if (retryAfter && /^\d{1,6}$/.test(retryAfter)) response.setHeader("retry-after", retryAfter);
        await upstream.body?.cancel();
        throw new Problem(upstream.status, "upstream_http_error");
      }
      status = upstream.status;
      if (stream) {
        if (transport.nativeStreaming) upstream = wrapNativeTextStream(upstream, transport.toolName, config.model);
        upstream = wrapAntiTruncationStream(upstream, transport.toolName, metadata => Object.assign(audit, metadata));
        if (!upstream.body) throw new Problem(502, "empty_upstream_stream");
        let received = false;
        for await (const bytes of upstream.body) {
          if (response.destroyed) throw new Problem(499, "client_disconnected");
          if (!received) {
            response.writeHead(status, { "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no" });
            received = true;
          }
          if (!response.write(Buffer.from(bytes))) await once(response, "drain", { signal });
        }
        if (!received) throw new Problem(502, "empty_upstream_stream");
        if (response.destroyed) throw new Problem(499, "client_disconnected");
        response.end();
      } else {
        const completion = restoreAntiTruncationCompletion(await readCompletion(upstream, config.bodyLimitBytes), transport.toolName);
        if (transport.toolName) audit.restored = completion.router_anti_truncation.restored;
        audit.finishReason = completion.choices[0]?.finish_reason ?? null;
        send(response, status, completion);
      }
    } catch (error) {
      status = client.signal.aborted ? 499 : deadline.aborted ? 504 : error instanceof Problem ? error.status : 502;
      code = error instanceof Problem ? error.code : deadline.aborted ? "upstream_timeout" : client.signal.aborted ? "client_disconnected" : "upstream_protocol_error";
      if (response.headersSent) response.destroy();
      else send(response, status === 499 ? 502 : status, { error: { code, message: code, type: "gateway_error" } });
    } finally {
      response.off("close", onClose);
      request.off("aborted", onClose);
      const event = { at: new Date().toISOString(), event: code ? "request_failed" : "request_complete", requestId,
        model: config.model, stream, status, latencyMs: Date.now() - started, ...antiTruncationLogFields(audit), ...(code ? { code } : {}) };
      events.push(event);
      if (events.length > 200) events.shift();
      logger(event);
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  return server;
}
