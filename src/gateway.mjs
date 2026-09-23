import { guardCompletionStream, inspectCompletion, integrityLogFields } from "./completion-integrity.mjs";
import { assertStructuredOutput, structuredOutputExpectation } from "./vertex-schema.mjs";
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { prepareAntiTruncation, restoreAntiTruncationCompletion, wrapAntiTruncationStream, antiTruncationLogFields } from "./anti-truncation.mjs";
import { buildNativeUrl } from "./vertex-native.mjs";
import { buildNativeTextBody, wrapNativeTextStream } from "./vertex-text-stream.mjs";
import { supportsNativeRequest, nativeRequestBody, translateNativeCompletion, wrapNativeStream } from "./vertex-protocol.mjs";
import { modelProfiles } from "./model-profiles.mjs";
import { completionStream, aliasStream } from "./completion-stream.mjs";
import { convertGeminiPrefill, fetchWithGeminiRecovery, compatibilityLogFields } from "./gemini-compat.mjs";

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
async function readCompletion(response, limit, native = false, model) {
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
  if (parsed?.error) throw new Problem(502, "upstream_error_object");
  if (native) parsed = translateNativeCompletion(parsed, model);
  if (!parsed || parsed.error || !Array.isArray(parsed.choices) || !parsed.choices.length) {
    throw new Problem(502, "invalid_upstream_completion");
  }
  const inspected = inspectCompletion(parsed);
  if (!inspected.valid) throw Object.assign(new Problem(502, inspected.reason), { integrity: inspected.integrity });
  return parsed;
}
function validate(payload) {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") throw new Problem(400, "invalid_request");
  if (!Array.isArray(payload.messages) || !payload.messages.length || payload.messages.some(message =>
    !message || typeof message !== "object" || !["system", "developer", "user", "assistant", "tool", "function"].includes(message.role))) {
    throw new Problem(400, "invalid_messages");
  }
  if (payload.stream != null && typeof payload.stream !== "boolean") throw new Problem(400, "invalid_stream");
}

// fetchImpl exists for local protocol fixtures; HTTP clients cannot choose hosts,
// credentials or the upstream model. The CLI always uses Google's fixed endpoint.
export function createGatewayServer(configSource, { fetchImpl = fetch, logger = () => {} } = {}) {
  const events = [];
  // Reapplying settings or restarting starts a fresh availability observation.
  // Temporary errors (including 403/404/429) never remove models from the list.
  const rejectedCredentials = new WeakSet();
  const currentConfig = () => typeof configSource === "function" ? configSource() : configSource;
  const availability = config => (config.models || modelProfiles(null, config.antiTruncation !== false)).map(model => {
    const reason = model.enabled === false ? "disabled" : rejectedCredentials.has(config) ? "authentication_failed" : null;
    return { id: model.id, available: reason === null, reason, hidden: config.hideUnavailableModels !== false && reason !== null };
  });
  let active = 0;
  const server = http.createServer(async (request, response) => {
    // Snapshot once: saved settings apply to new requests without changing streams in flight.
    const config = currentConfig();
    const models = config.models || modelProfiles(null, config.antiTruncation !== false);
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    const requestId = randomUUID();
    response.setHeader("x-request-id", requestId);
    let pathname;
    try { pathname = new URL(request.url, "http://localhost").pathname; }
    catch { return send(response, 400, { error: { code: "invalid_path" } }); }
    if (request.method === "GET" && pathname === "/healthz") return send(response, 200, { status: "ok", version: "0.4.1" });
    if (!authorized(request, config.gatewayKey)) return send(response, 401, { error: { code: "unauthorized" } });
    if (request.method === "GET" && pathname === "/v1/models") return send(response, 200, {
      object: "list", data: availability(config).filter(model => !model.hidden).map(model => ({ id: model.id, object: "model", owned_by: "vertex-streaming-anti-truncation" })),
    });
    if (request.method === "GET" && pathname === "/admin/events") return send(response, 200, { events: events.slice().reverse() });
    if (request.method !== "POST" || pathname !== "/v1/chat/completions") return send(response, 404, { error: { code: "not_found" } });

    const started = Date.now();
    active++;
    const client = new AbortController();
    const deadline = AbortSignal.timeout(config.timeoutMs);
    const signal = AbortSignal.any([client.signal, deadline]);
    const onClose = () => { if (!response.writableEnded) client.abort(); };
    response.once("close", onClose);
    request.once("aborted", onClose);
    let stream = false, audit = null, integrity = null, status = 500, code = null, route;
    const compatibility = { prefillConverted: false, promptRetried: false };
    try {
      let payload = await readRequest(request, config.bodyLimitBytes);
      validate(payload);
      route = models.find(model => model.id === payload.model);
      if (!route) throw new Problem(400, "unsupported_model");
      if (route.enabled === false) throw new Problem(503, "model_disabled");
      stream = payload.stream === true;
      const prefill = convertGeminiPrefill(payload, route.upstreamModel, config.geminiPrefillToUser !== false);
      payload = prefill.payload; compatibility.prefillConverted = prefill.converted;
      response.setHeader("x-gemini-prefill-converted", String(prefill.converted));
      const transport = prepareAntiTruncation(payload, route.mode !== "normal" && config.antiTruncation !== false, route.mode === "streaming");
      const buffered = route.mode === "buffered" && Boolean(transport.toolName);
      const upstreamStream = stream && !buffered;
      if (buffered) transport.reason = "tool-transport-buffered";
      const native = transport.nativeStreaming || config.nativeOnly;
      if (config.nativeOnly && !supportsNativeRequest(payload)) throw new Problem(400, "unsupported_native_fields");
      audit = { transport: transport.reason, restored: transport.toolName ? null : false,
        finishReason: null, streamDone: stream ? false : null };
      response.setHeader("x-anti-truncation-transport", transport.reason);
      const url = native
        ? buildNativeUrl(config.baseUrl, route.upstreamModel, upstreamStream)
        : config.baseUrl + "/chat/completions";
      const expectation = native ? structuredOutputExpectation(payload) : null;
      const requestBody = value => {
        const body = transport.nativeStreaming ? buildNativeTextBody(value)
          : native ? nativeRequestBody(value) : { ...value, model: route.upstreamModel, stream: upstreamStream };
        if (!upstreamStream) delete body.stream_options;
        return body;
      };
      // Preserve local field/schema rejection before authentication.
      const upstreamPayload = { ...transport.payload, stream: upstreamStream };
      const firstBody = requestBody(upstreamPayload);
      const credential = await config.accessToken();
      const authentication = config.authMode === "express" ? { "x-goog-api-key": credential } : { authorization: "Bearer " + credential };
      let upstream = await fetchWithGeminiRecovery(value => fetchImpl(url, { method: "POST", redirect: "error", signal,
        headers: { ...authentication, ...config.tierHeaders, "content-type": "application/json", accept: upstreamStream ? "text/event-stream" : "application/json" },
        body: JSON.stringify(value === upstreamPayload ? firstBody : requestBody(value)) }), upstreamPayload, route.upstreamModel, {
        settings: config.geminiPromptRetry, signal, bodyLimit: config.bodyLimitBytes,
        onRetry: () => { compatibility.promptRetried = true; },
      });
      response.setHeader("x-gemini-prompt-retried", String(compatibility.promptRetried));
      if (!upstream.ok) {
        if (upstream.status === 401) rejectedCredentials.add(config);
        const retryAfter = upstream.headers.get("retry-after");
        if (retryAfter && /^\d{1,6}$/.test(retryAfter)) response.setHeader("retry-after", retryAfter);
        await upstream.body?.cancel();
        throw new Problem(upstream.status, upstream.routerPromptSubmissionError ? "prompt_submission_failed" : "upstream_http_error");
      }
      status = upstream.status;
      if (stream) {
        if (buffered) {
          const completion = restoreAntiTruncationCompletion(await readCompletion(upstream, config.bodyLimitBytes, native, route.id), transport.toolName);
          completion.model = route.id;
          audit.trafficType = completion.usage?.traffic_type;
          audit.restored = completion.router_anti_truncation.restored;
          audit.finishReason = completion.choices[0]?.finish_reason ?? null;
          upstream = completionStream(completion, payload.stream_options?.include_usage === true);
        } else {
          if (transport.nativeStreaming) upstream = wrapNativeTextStream(upstream, transport.toolName, route.id);
          else if (native) upstream = wrapNativeStream(upstream, route.id, usage => { audit.trafficType = usage?.traffic_type; });
          upstream = aliasStream(upstream, route.id, metadata => Object.assign(audit, metadata));
          upstream = wrapAntiTruncationStream(upstream, transport.toolName, metadata => Object.assign(audit, metadata));
        }
        upstream = guardCompletionStream(upstream, metadata => { integrity = metadata; }, expectation, config.bodyLimitBytes);
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
        if (buffered) audit.streamDone = true;
      } else {
        const completion = restoreAntiTruncationCompletion(await readCompletion(upstream, config.bodyLimitBytes, native, route.id), transport.toolName);
        completion.model = route.id;
        audit.trafficType = completion.usage?.traffic_type;
        if (transport.toolName) audit.restored = completion.router_anti_truncation.restored;
        audit.finishReason = completion.choices[0]?.finish_reason ?? null;
        const inspected = inspectCompletion(completion);
        integrity = inspected.integrity;
        if (!inspected.valid) throw new Problem(502, inspected.reason);
        for (const choice of completion.choices) {
          if (choice.finish_reason === "stop" && !choice.message.refusal && !choice.message.tool_calls?.length) {
            assertStructuredOutput(choice.message.content, expectation);
          }
        }
        send(response, status, completion);
      }
      rejectedCredentials.delete(config);
    } catch (error) {
      status = client.signal.aborted ? 499 : deadline.aborted ? 504 : (error instanceof Problem || error.status === 400) ? error.status : 502;
      code = client.signal.aborted ? "client_disconnected" : deadline.aborted ? "upstream_timeout" :
        (error instanceof Problem || error.protocolFailure || error.status === 400) ? error.code : "upstream_protocol_error";
      if (error instanceof Problem && error.integrity) integrity = error.integrity;
      integrity = { ...integrity, outcome: status === 499 ? "cancelled" :
        ["empty", "incomplete"].includes(integrity?.outcome) ? integrity.outcome : "error" };
      if (response.headersSent) response.destroy();
      else send(response, status === 499 ? 502 : status, { error: { code, message: code, type: "gateway_error", requestId,
        ...integrityLogFields(integrity), ...(error.status === 400 && error.param ? { param: error.param } : {}) } });
    } finally {
      active--;
      response.off("close", onClose);
      request.off("aborted", onClose);
      const event = { at: new Date().toISOString(), event: code ? "request_failed" : "request_complete", requestId,
        model: route?.id || null, upstreamModel: route?.upstreamModel || null, mode: route?.mode || null, stream, status, latencyMs: Date.now() - started,
        serviceTier: config.serviceTier || "standard",
        trafficType: ["ON_DEMAND", "ON_DEMAND_FLEX", "ON_DEMAND_PRIORITY", "PROVISIONED_THROUGHPUT"].includes(audit?.trafficType) ? audit.trafficType : null,
        ...antiTruncationLogFields(audit), ...integrityLogFields(integrity), ...compatibilityLogFields(compatibility), ...(code ? { code } : {}) };
      events.push(event);
      if (events.length > 200) events.shift();
      logger(event);
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  server.gatewayStats = () => ({ active });
  server.modelAvailability = () => availability(currentConfig());
  return server;
}
