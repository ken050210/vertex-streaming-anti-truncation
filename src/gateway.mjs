import { prepareImageInput, imageInputLogFields } from "./image-input.mjs";
import { prepareUnicodeInput, unicodeInputLogFields } from "./unicode-input.mjs";
import { guardCompletionStream, inspectCompletion, integrityLogFields } from "./completion-integrity.mjs";
import { assertStructuredOutput, structuredOutputExpectation } from "./vertex-schema.mjs";
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { prepareAntiTruncation, restoreAntiTruncationCompletion, wrapAntiTruncationStream, antiTruncationLogFields } from "./anti-truncation.mjs";
import { buildNativeTextBody, buildNativeUrl, nativeRequestBody, supportsNativeRequest, translateUsage } from "./vertex-native.mjs";
import { estimateCostUsd, usageTokens } from "./pricing.mjs";
import { wrapNativeTextStream } from "./vertex-text-stream.mjs";
import { translateNativeCompletion, wrapNativeStream } from "./vertex-protocol.mjs";
import { geminiModelKey, modelProfiles } from "./model-profiles.mjs";
import { completionStream, aliasStream } from "./completion-stream.mjs";
import { convertGeminiPrefill, fetchWithGeminiRecovery, compatibilityLogFields } from "./gemini-compat.mjs";
import { capGemini4Output, outputLimitHeaders, prepareGemini4Request, validateGemini4Connection } from "./gemini4.mjs";
import { fetchLongDecode, longDecodeUrl } from "./vertex-long-decode.mjs";
import { documentedUnsupported, dropParams } from "./unsupported-params.mjs";
import { googleErrorDetail, trafficType, upstreamErrorLogFields } from "./wire.mjs";
import { waitWithSignal } from "./abort.mjs";
import { createAccountPool } from "./account-pool.mjs";

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
function readRequest(request, limit, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const cleanup = () => {
      request.off("data", data);
      request.off("end", end);
      request.off("error", fail);
      signal.removeEventListener("abort", abort);
    };
    const fail = error => { cleanup(); request.pause(); reject(error); };
    const abort = () => fail(signal.reason);
    // Keep reading past the limit without buffering: replying while the client is still
    // uploading resets the socket and the client never sees the 413. The deadline and
    // disconnect listeners still end an oversized upload that never finishes.
    const data = chunk => {
      total += chunk.length;
      if (total <= limit) chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      if (total > limit) { reject(new Problem(413, "request_too_large")); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Problem(400, "invalid_json")); }
    };
    if (signal.aborted) { abort(); return; }
    request.on("data", data);
    request.once("end", end);
    request.once("error", fail);
    signal.addEventListener("abort", abort, { once: true });
  });
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
// A bounded prefix of a provider error body, reduced to its fixed fields. The status
// decides the reply even if the body is broken, slow or not JSON.
const ERROR_DETAIL_BYTES = 16 * 1024;
async function readUpstreamError(response, credential) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => reader.cancel().catch(() => {}), 5000);
  try {
    while (size < ERROR_DETAIL_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.byteLength;
    }
  } catch { /* keep what arrived */ } finally { clearTimeout(timer); reader.cancel().catch(() => {}); }
  try { return googleErrorDetail(JSON.parse(Buffer.concat(chunks).subarray(0, ERROR_DETAIL_BYTES).toString("utf8")), credential); }
  catch { return null; }
}
function validate(payload) {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") throw new Problem(400, "invalid_request");
  if (!Array.isArray(payload.messages) || !payload.messages.length || payload.messages.some(message =>
    !message || typeof message !== "object" || !["system", "developer", "user", "assistant", "tool", "function"].includes(message.role))) {
    throw new Problem(400, "invalid_messages");
  }
  if (payload.stream != null && typeof payload.stream !== "boolean") throw new Problem(400, "invalid_stream");
}

// Node's built-in fetch (bundled undici) gives up after 300 s without response headers
// or between body chunks, whatever timeoutMs says. Once fetch has loaded, undici's shared
// global-dispatcher slot holds its Agent; build the same class with timeouts that follow
// the setting (the AbortSignal still bounds the call). Otherwise keep the default.
const nativeFetch = globalThis.fetch;
const upstreamAgents = new Map();
export function upstreamDispatcher(timeoutMs) {
  if (!upstreamAgents.has(timeoutMs)) {
    upstreamAgents.set(timeoutMs, nativeFetch("data:,").then(response => response.arrayBuffer()).then(() => {
      // With NODE_USE_ENV_PROXY the slot holds an EnvHttpProxyAgent, which reads the proxy
      // environment itself and passes these timeouts to its inner agents.
      const Agent = globalThis[Symbol.for("undici.globalDispatcher.1")]?.constructor;
      return ["Agent", "EnvHttpProxyAgent"].includes(Agent?.name) ? new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs }) : undefined;
    }));
  }
  return upstreamAgents.get(timeoutMs);
}

// fetchImpl exists for local protocol fixtures; HTTP clients cannot choose hosts,
// credentials or the upstream model. Only the saved configuration names the upstream.
export function createGatewayServer(configSource, { fetchImpl = fetch, logger = () => {} } = {}) {
  const events = [];
  // Reapplying settings or restarting starts a fresh availability observation.
  // Temporary errors (including 403/404/429) never remove models from the list.
  const rejectedCredentials = new WeakSet();
  const pools = new WeakMap();
  const poolFor = config => {
    if (!config.accountRotation?.enabled) return null;
    if (!pools.has(config)) pools.set(config, createAccountPool(config));
    return pools.get(config);
  };
  const currentConfig = () => typeof configSource === "function" ? configSource() : configSource;
  const profiles = config => config.models || modelProfiles(null, config.antiTruncation !== false);
  const availability = config => profiles(config).map(model => {
    const reason = model.enabled === false ? "disabled" : rejectedCredentials.has(config) ? "authentication_failed" : null;
    return { id: model.id, available: reason === null, reason, hidden: config.hideUnavailableModels !== false && reason !== null };
  });
  let active = 0;
  const server = http.createServer(async (request, response) => {
    // Snapshot once: saved settings apply to new requests without changing streams in flight.
    const snapshot = currentConfig();
    let config = snapshot;
    const models = profiles(config);
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    const requestId = randomUUID();
    response.setHeader("x-request-id", requestId);
    let pathname;
    try { pathname = new URL(request.url, "http://localhost").pathname; }
    catch { return send(response, 400, { error: { code: "invalid_path" } }); }
    if (request.method === "GET" && pathname === "/healthz") return send(response, 200, { status: "ok", version: "0.12.0" });
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
    const requestSignal = AbortSignal.any([client.signal, deadline]);
    let signal = requestSignal;
    const onClose = () => { if (!response.writableEnded) client.abort(); };
    response.once("close", onClose);
    request.once("aborted", onClose);
    let unicode = null, image = null, outputLimit = null;
    let stream = false, audit = null, integrity = null, status = 500, code = null, route, droppedParams = [], upstreamError = null, credential = null;
    const compatibility = { prefillConverted: false, promptRetried: false };
    const pool = poolFor(snapshot), tried = new Set(), accountAttempts = [];
    try {
      let payload = await readRequest(request, config.bodyLimitBytes, signal);
      validate(payload);
      route = models.find(model => model.id === payload.model);
      if (!route) throw new Problem(400, "unsupported_model");
      if (route.enabled === false) throw new Problem(503, "model_disabled");
      const originalPayload = payload;
      let entry = pool?.take(tried);
      if (pool && !entry) throw new Problem(503, "accounts_unavailable");
      while (true) {
        const attemptStarted = Date.now();
        const attempt = new AbortController();
        let timedOut = false, submitted = false;
        const timer = pool ? setTimeout(() => { timedOut = true; attempt.abort(); }, snapshot.accountRotation.timeoutMs) : null;
        config = entry ? { ...snapshot, ...entry.connection } : snapshot;
        signal = pool ? AbortSignal.any([requestSignal, attempt.signal]) : requestSignal;
        payload = structuredClone(originalPayload);
        try {
          validateGemini4Connection(config, route.upstreamModel);
          const custom = config.authMode === "custom";
          // A custom upstream gets its own model name verbatim. Gemini-specific handling follows the
          // model that name refers to, and is skipped when none is recognizable.
          const modelKey = custom ? geminiModelKey(route.upstreamModel) : route.upstreamModel;
          payload = prepareGemini4Request(payload, modelKey);
          try {
            const prepared = prepareUnicodeInput(payload, config.unicodeInput === true, config.bodyLimitBytes);
            payload = prepared.payload; unicode = prepared.metadata;
          } catch (error) {
            if (["unicode_floor_required", "unicode_input_too_large"].includes(error.code)) throw new Problem(error.status, error.code);
            throw error;
          }
          response.setHeader("x-unicode-input", unicode?.reason || "disabled");
          const convertPrefill = () => {
            const prefill = convertGeminiPrefill(payload, modelKey, config.geminiPrefillToUser !== false);
            payload = prefill.payload; compatibility.prefillConverted = prefill.converted;
          };
          // All mode also rasterizes a trailing text prefill, so switch its role first.
          // Current-turn keeps its boundary: a trailing prefill leaves the latest user text alone.
          if (config.imageInput === "all") convertPrefill();
          try {
            if (config.unicodeInput && config.imageInput && config.imageInput !== "off") throw Object.assign(new Error(), {status:400,code:"image_input_conflict"});
            const converted = await prepareImageInput(payload, config.imageInput || "off", config.bodyLimitBytes, {signal});
            payload = converted.payload; image = converted.metadata;
          } catch (error) {
            // Input errors keep their status; anything else is a local canvas or encoder failure.
            if (Number.isInteger(error.status) && typeof error.code === "string") throw new Problem(error.status, error.code);
            throw new Problem(503, "image_render_failed");
          }
          response.setHeader("x-image-input", image?.reason || "disabled");
          stream = payload.stream === true;
          if (config.imageInput !== "all") convertPrefill();
          response.setHeader("x-gemini-prefill-converted", String(compatibility.prefillConverted));
          // Google documents these fields as unsupported for this model: drop them before
          // anti-truncation, native translation and the first submission.
          const unsupported = documentedUnsupported(modelKey, payload);
          droppedParams = Object.keys(payload).filter(key => unsupported.has(key));
          payload = dropParams(payload, unsupported);
          if (droppedParams.length) response.setHeader("x-gemini-dropped-params", droppedParams.join(","));
          const transport = prepareAntiTruncation(payload, route.mode !== "normal" && config.antiTruncation !== false, route.mode === "streaming", { native: !custom });
          const buffered = route.mode === "buffered" && Boolean(transport.toolName);
          const upstreamStream = stream && !buffered;
          if (buffered) transport.reason = "tool-transport-buffered";
          // Gemini 4 Argon: a ceiling over one request's limit is capped at it, or kept for long
          // decode on the native API. A custom upstream calls Google in ways the gateway cannot
          // see, so it gets the lowest limit, or its ceiling unchanged when long decode is on.
          if (!(custom && config.geminiLongDecode)) {
            const capped = capGemini4Output(transport.payload, modelKey, custom ? { limit: 32768 } : { stream: upstreamStream,
              longDecode: config.geminiLongDecode && (transport.nativeStreaming || config.nativeOnly || supportsNativeRequest(payload)) });
            transport.payload = capped.payload;
            outputLimit = capped.outputLimit;
          }
          const longDecode = outputLimit?.longDecode === true;
          for (const [name, value] of Object.entries(outputLimitHeaders(outputLimit))) response.setHeader(name, value);
          const native = transport.nativeStreaming || config.nativeOnly || longDecode;
          if (config.nativeOnly && !supportsNativeRequest(payload)) throw new Problem(400, "unsupported_native_fields");
          audit = { transport: transport.reason, restored: transport.toolName ? null : false,
            finishReason: null, streamDone: stream ? false : null };
          response.setHeader("x-anti-truncation-transport", transport.reason);
          let url = native
            ? buildNativeUrl(config.baseUrl, route.upstreamModel, upstreamStream)
            : config.baseUrl + "/chat/completions";
          if (longDecode) url = longDecodeUrl(url);
          const expectation = native ? structuredOutputExpectation(payload) : null;
          const requestBody = value => {
            const body = transport.nativeStreaming ? buildNativeTextBody(value)
              : native ? nativeRequestBody(value) : { ...value, model: route.upstreamModel, stream: upstreamStream };
            if (!upstreamStream) delete body.stream_options;
            // Vertex's compatible stream reports usage only on request; the log's cost estimate needs it.
            else if (!native && !custom) body.stream_options = { ...body.stream_options, include_usage: true };
            return body;
          };
          // Preserve local field/schema rejection before authentication.
          const upstreamPayload = { ...transport.payload, model: route.upstreamModel, stream: upstreamStream };
          const firstBody = requestBody(upstreamPayload);
          // A failed token exchange (or its timeout, or an unusable service account) is a local
          // credential problem; cancellation still reports 499/504 below.
          submitted = true;
          credential = await waitWithSignal(() => config.accessToken(), signal)
            .catch(() => { throw new Problem(502, "credential_error"); });
          const dispatcher = await waitWithSignal(() => upstreamDispatcher(config.timeoutMs), signal);
          signal.throwIfAborted();
          const authentication = config.authMode === "express" ? { "x-goog-api-key": credential } : { authorization: "Bearer " + credential };
          // fetch reports network failures (DNS, connection, TLS, proxy) as TypeError("fetch failed")
          // with a cause. A TypeError without one comes from building the request, where the only
          // variable header is the credential (for example a key with non-Latin-1 characters).
          // Errors while reading a body that has started keep their protocol handling.
          const post = body => {
            if (longDecode) outputLimit.requests = (outputLimit.requests ?? 0) + 1;
            return fetchImpl(url, { method: "POST", redirect: "error", signal, dispatcher,
              headers: { ...authentication, ...config.tierHeaders, "content-type": "application/json", accept: upstreamStream ? "text/event-stream" : "application/json" },
              body: JSON.stringify(body) }).catch(error => {
              throw error instanceof TypeError ? new Problem(502, error.cause ? "upstream_unreachable" : "credential_error") : error;
            });
          };
          let upstream = await fetchWithGeminiRecovery(value => {
            const body = value === upstreamPayload ? firstBody : requestBody(value);
            return longDecode ? fetchLongDecode(post, body, upstreamStream) : post(body);
          }, upstreamPayload, modelKey, {
            settings: config.geminiPromptRetry, signal, bodyLimit: config.bodyLimitBytes,
            onRetry: () => { compatibility.promptRetried = true; },
          });
          response.setHeader("x-gemini-prompt-retried", String(compatibility.promptRetried));
          if (!upstream.ok) {
            if (upstream.status === 401 && !pool) rejectedCredentials.add(config);
            const retryAfter = upstream.headers.get("retry-after");
            if (retryAfter && /^\d{1,6}$/.test(retryAfter)) response.setHeader("retry-after", retryAfter);
            // A matched prompt rejection keeps only its code; other errors add Google's fixed fields.
            const prompt = Boolean(upstream.routerPromptSubmissionError);
            if (prompt) await upstream.body?.cancel().catch(() => {});
            const detail = prompt ? null : await readUpstreamError(upstream, credential);
            throw Object.assign(new Problem(upstream.status, prompt ? "prompt_submission_failed" : "upstream_http_error"), { upstreamError: detail });
          }
          status = upstream.status;
          // A complete upstream reply, restored and attributed to the selected alias.
          const readReply = async reply => {
            const completion = restoreAntiTruncationCompletion(await readCompletion(reply, config.bodyLimitBytes, native, route.id), transport.toolName);
            completion.model = route.id;
            audit.trafficType = trafficType(completion.usage);
            audit.usage = completion.usage;
            if (transport.toolName) audit.restored = completion.router_anti_truncation.restored;
            audit.finishReason = completion.choices[0]?.finish_reason ?? null;
            return completion;
          };
          if (stream) {
            // Like OpenAI, the empty-choices usage chunk is sent only when the client asks for it.
            const includeUsage = payload.stream_options?.include_usage === true;
            if (buffered) {
              upstream = completionStream(await readReply(upstream), includeUsage);
            } else {
              if (transport.nativeStreaming) upstream = wrapNativeTextStream(upstream, transport.toolName, route.id, usage => { audit.trafficType = usage?.trafficType; audit.usage = translateUsage(usage); }, includeUsage);
              else if (native) upstream = wrapNativeStream(upstream, route.id, usage => { audit.trafficType = usage?.traffic_type; audit.usage = usage; }, includeUsage);
              upstream = aliasStream(upstream, route.id, metadata => Object.assign(audit, metadata), includeUsage);
              upstream = wrapAntiTruncationStream(upstream, transport.toolName, metadata => Object.assign(audit, metadata), transport.payload.tools);
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
            const completion = await readReply(upstream);
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
          if (pool) {
            pool.success(entry);
            accountAttempts.push({ accountId: entry.connection.id, status, latencyMs: Date.now() - attemptStarted });
          }
          break;
        } catch (failure) {
          const error = timedOut && !requestSignal.aborted ? new Problem(504, "account_timeout") : failure;
          const failureStatus = error.status || 502;
          const accountFailure = !requestSignal.aborted && (submitted || timedOut) &&
            error.code !== "prompt_submission_failed" && ([401, 403, 408, 429].includes(failureStatus) || failureStatus >= 500);
          let switchAccount = false;
          if (pool) {
            accountAttempts.push({ accountId: entry.connection.id, status: requestSignal.aborted ? (client.signal.aborted ? 499 : 504) : failureStatus,
              code: error.code || "upstream_protocol_error", latencyMs: Date.now() - attemptStarted });
            if (accountFailure) switchAccount = pool.fail(entry);
          }
          const next = switchAccount && !response.headersSent && !response.destroyed ? pool.take(tried) : null;
          if (!next) throw error;
          entry = next;
          // Headers and inspection state describe only the attempt returned to the client.
          for (const name of response.getHeaderNames()) if (name !== "cache-control" && name !== "x-content-type-options" && name !== "x-request-id") response.removeHeader(name);
          audit = integrity = outputLimit = credential = null;
          compatibility.prefillConverted = compatibility.promptRetried = false;
        } finally {
          if (timer) clearTimeout(timer);
          // Cancel any unread response on failure/switch, including a stalled stream.
          attempt.abort();
        }
      }
    } catch (error) {
      // An unfinished upload must not hold a keep-alive connection open after
      // its deadline/body limit; close only after the error response is sent.
      if (!request.complete) response.shouldKeepAlive = false;
      status = client.signal.aborted ? 499 : deadline.aborted ? 504 : (error instanceof Problem || error.status === 400) ? error.status : 502;
      code = client.signal.aborted ? "client_disconnected" : deadline.aborted ? "upstream_timeout" :
        (error instanceof Problem || error.protocolFailure || error.status === 400) ? error.code : "upstream_protocol_error";
      if (error instanceof Problem && error.integrity) integrity = error.integrity;
      // Google's error fields: status and reason for logs, plus the redacted message for the client.
      // Stream readers keep the raw error event in memory only; it is reduced here, with this request's credential.
      if (status !== 499 && !deadline.aborted) upstreamError = error.upstreamError ?? (error.upstreamBody ? googleErrorDetail(error.upstreamBody, credential) : null);
      integrity = { ...integrity, outcome: status === 499 ? "cancelled" :
        ["empty", "incomplete"].includes(integrity?.outcome) ? integrity.outcome : "error" };
      if (response.headersSent) response.destroy();
      else send(response, status === 499 ? 502 : status, { error: { code, message: code, type: "gateway_error", requestId,
        ...integrityLogFields(integrity), ...(error.status === 400 && error.param ? { param: error.param } : {}),
        ...(upstreamError ? { upstreamError } : {}) } });
    } finally {
      active--;
      response.off("close", onClose);
      request.off("aborted", onClose);
      // A reply that reported usage was billed, even if it then failed a local check.
      const tokens = usageTokens(audit?.usage);
      const cost = tokens && config.authMode !== "custom" ? estimateCostUsd(route.upstreamModel, tokens,
        { trafficType: audit.trafficType, serviceTier: config.serviceTier, location: config.location }) : null;
      const event = { at: new Date().toISOString(), event: code ? "request_failed" : "request_complete", requestId,
        model: route?.id || null, upstreamModel: route?.upstreamModel || null, mode: route?.mode || null, stream, status, latencyMs: Date.now() - started,
        serviceTier: config.serviceTier || "standard",
        trafficType: ["ON_DEMAND", "ON_DEMAND_FLEX", "ON_DEMAND_PRIORITY", "PROVISIONED_THROUGHPUT"].includes(audit?.trafficType) ? audit.trafficType : null,
        ...imageInputLogFields(image), ...unicodeInputLogFields(unicode), ...antiTruncationLogFields(audit), ...integrityLogFields(integrity), ...compatibilityLogFields(compatibility),
        ...upstreamErrorLogFields(upstreamError), ...(droppedParams.length ? { droppedParams } : {}), ...(outputLimit ? { outputLimit } : {}), ...(code ? { code } : {}),
        ...(tokens ? { usage: tokens, estimatedCostUsd: cost } : {}) };
      if (pool) event.accountAttempts = accountAttempts;
      events.push(event);
      if (events.length > 200) events.shift();
      logger(event);
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  server.gatewayStats = () => ({ active });
  server.modelAvailability = () => availability(currentConfig());
  server.accountStatus = () => poolFor(currentConfig())?.status() || [];
  return server;
}
