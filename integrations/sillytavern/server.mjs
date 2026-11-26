import { once } from "node:events";
import { buildConnectionConfig, vertexBaseUrl } from "../../src/config.mjs";
import { legacyVertexLocation, requestLocations } from "../../src/vertex-locations.mjs";
import { createRegionSender } from "../../src/region-retry.mjs";
import { prepareImageInput } from "../../src/image-input.mjs";
import { buildNativeUrl } from "../../src/vertex-native.mjs";
import { parseServiceAccount } from "../../src/vertex-auth.mjs";
import { outputLimitHeaders, validateGemini4Connection } from "../../src/gemini4.mjs";
import { fetchLongDecode, longDecodeUrl } from "../../src/vertex-long-decode.mjs";
import { prepareSillyTavernRequest, restoreSillyTavernResponse, requestError } from "../../src/sillytavern.mjs";
import { enumToken, googleErrorDetail, sseData, upstreamMessage } from "../../src/wire.mjs";
import { waitWithSignal } from "../../src/abort.mjs";
import { BODY_LIMIT, PLUGIN_FEATURES, PLUGIN_ID, PLUGIN_VERSION, tavernDefaultsToGlobal } from "./shared.js";

import { loadUsageEstimator } from "./google-usage-estimate.mjs";
import { configurationProblem, DIAGNOSTIC_HEADER, googleProblem, oauthProblem, systemCodes } from "./diagnostic-fields.js";
import { identifyServerBuild, readDiagnostics, serverEnvironment, startDiagnostic } from "./server-diagnostics.mjs";

export { info } from "./server-entry.mjs";

function imageErrorLocation(error) {
  return error.code === "image_input_unsupported_characters"
    ? { param: error.param, character: error.character } : {};
}

// PayGo owns generation and billing. Its UI only needs our local rasterizer.
export async function convertImages(request, response) {
  if (!request.user?.directories) return response.sendStatus(401);
  const { mode, messages } = request.body ?? {};
  const client = new AbortController();
  const diagnostic = startDiagnostic(request, PLUGIN_VERSION, "image");
  response.setHeader(DIAGNOSTIC_HEADER, diagnostic.record.id);
  const close = () => client.abort();
  response.once("close", close);
  try {
    if (!["all", "current-turn"].includes(mode)) throw requestError("invalid_image_input_mode");
    if (Buffer.byteLength(JSON.stringify(request.body)) > BODY_LIMIT) throw Object.assign(requestError("image_input_too_large"), { status: 413 });
    const { payload, metadata } = await prepareImageInput({ messages }, mode, BODY_LIMIT, { signal: client.signal });
    response.setHeader("cache-control", "no-store");
    await diagnostic.finish("ok", null, null, null, response);
    return response.json({ messages: payload.messages, metadata });
  } catch (error) {
    const code = error.code ?? "image_render_failed";
    diagnostic.record.resultStatus = error.status ?? 503;
    await diagnostic.finish(client.signal.aborted ? "disconnected" : "error", error, code, null, response);
    if (!client.signal.aborted) return response.status(diagnostic.record.resultStatus).json({ error: { code, ...imageErrorLocation(error), diagnostic: diagnostic.record } });
  } finally { response.off("close", close); }
}

function webResponseBody(source) {
  // Read on demand. With Readable.toWeb, a queued 'data' event can hit a closed controller after a 429 retry.
  const chunks = source[Symbol.asyncIterator]();
  let cancelled = false;
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await chunks.next();
      if (cancelled) return;
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel() {
      cancelled = true;
      source.destroy();
      return chunks.return();
    },
  }, { highWaterMark: 0 });
}

// Tavern's node-fetch uses the http(s).globalAgent installed by requestProxy.
export const webFetch = nodeFetch => async (url, init) => {
  const reply = await nodeFetch(url, init);
  const body = reply.body && ![204, 205, 304].includes(reply.status) ? webResponseBody(reply.body) : null;
  return new Response(body, { status: reply.status, headers: reply.headers });
};

export function connectionForRequest(request, { readSecret, SECRET_KEYS }, fetchImpl) {
  const body = request.body;
  const auth = body.vertexai_auth_mode ?? "express";
  if (!["express", "full"].includes(auth) || body.reverse_proxy) throw requestError("unsupported_authentication_mode");
  const serviceTier = body.vertexai_service_tier || "standard";
  const fallback = auth === "full" && serviceTier === "standard" && body.vertex_fallback_locations != null;
  const preferred = body.vertexai_region || (tavernDefaultsToGlobal(body.model) ? "global" : "us-central1");
  const settings = { authMode: auth === "full" ? "service-account" : "express",
    location: fallback ? preferred : legacyVertexLocation(preferred, body.model),
    regionFallbackEnabled: fallback, fallbackLocations: body.vertex_fallback_locations ?? [],
    serviceTier, projectId: body.vertexai_express_project_id || "" };
  if (auth === "full") {
    settings.serviceAccountJson = readSecret(request.user.directories, SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, body.secret_id);
    if (!settings.serviceAccountJson) throw requestError("vertex_service_account_missing");
    settings.projectId = parseServiceAccount(settings.serviceAccountJson).project_id;
  } else {
    settings.apiKey = readSecret(request.user.directories, SECRET_KEYS.VERTEXAI, body.secret_id);
    if (!settings.apiKey) throw requestError("vertex_api_key_missing");
  }
  // The shared token exchange consumes failed responses for their HTTP status.
  // Preserve its standard error code for this request without forwarding Google's free text.
  let rejection;
  const tokenFetch = async (...args) => {
    const response = await (fetchImpl ?? fetch)(...args);
    if (response.ok) return response;
    const body = await response.json().catch(() => null);
    rejection = oauthProblem(body?.error) ? body.error : undefined;
    return new Response(null, { status: response.status });
  };
  const config = buildConnectionConfig(settings, { fetchImpl: tokenFetch, maxFallbackLocations: 2 });
  if (auth === "full") {
    const token = config.accessToken;
    config.accessToken = () => token().catch(error => {
      if (error.oauthStatus && rejection) error.oauthReason = rejection;
      throw error;
    });
  }
  validateGemini4Connection(config, body.model);
  return config;
}

export function createGenerateHandler(adapters, { fetchImpl = fetch, timeoutMs = 600000 } = {}) {
  return async (request, response) => {
    if (!request.user?.directories) return response.status(401).json({ error: { message: "SillyTavern login required" } });
    const client = new AbortController();
    const deadline = AbortSignal.timeout(timeoutMs);
    const diagnostic = startDiagnostic(request, PLUGIN_VERSION);
    const log = diagnostic.record;
    response.setHeader(DIAGNOSTIC_HEADER, log.id);
    const signal = AbortSignal.any([client.signal, deadline]);
    const close = () => { if (!response.writableEnded) client.abort(); };
    response.once("close", close);
    let config;
    let credential;
    const attempts = log.attempts;
    const writeRegionHeaders = () => {
      if (config?.projectId && attempts.length && !response.headersSent) {
        response.setHeader("x-vertex-location", attempts.at(-1).location);
        response.setHeader("x-vertex-region-attempts", attempts.map(a => a.location + "=" + (a.status ?? "no-response")).join(","));
      }
    };
    const imageMode = request.body?.vertex_image_input ?? "off";
    try {
      // Validate normal plugin eligibility before spending CPU rasterizing.
      let prepared = prepareSillyTavernRequest(request, adapters);
      log.inputBytes = prepared.inputBytes;
      if (imageMode !== "off") {
        diagnostic.stage("image");
        const converted = await prepareImageInput(request.body, imageMode, BODY_LIMIT, {signal});
        prepared = prepareSillyTavernRequest({ ...request, body: converted.payload }, adapters);
        response.setHeader("x-image-input", converted.metadata?.reason || "disabled");
        response.setHeader("x-image-input-pages", String(converted.metadata?.pages ?? 0));
      }
      diagnostic.stage("configuration");
      config = connectionForRequest(request, adapters, fetchImpl);
      const locations = requestLocations(config, prepared.model);
      Object.assign(log, { locations, transport: prepared.upstreamStream ? "streaming" : "buffered",
        imageMode, textTool: prepared.meowCompat ? "meow" : !prepared.toolName ? "off" : request.body.vertex_transport_tool_name ? "preset" : "builtin",
        tagStop: prepared.tucaoStop, stopCount: prepared.stopCount, waitForUsage: prepared.waitForStopUsage,
        outputLimit: prepared.outputLimit, timeoutMs });
      diagnostic.stage("authentication");
      credential = await waitWithSignal(() => config.accessToken(), signal);
      signal.throwIfAborted();
      const headers = { ...config.tierHeaders, "content-type": "application/json",
        ...(config.authMode === "express" ? { "x-goog-api-key": credential } : { authorization: `Bearer ${credential}` }) };
      diagnostic.stage("upstream");
      const longDecode = prepared.outputLimit?.longDecode === true;
      const sendRegion = createRegionSender({ locations, budget: { remaining: locations.length - 1 }, intervalMs: 1000, signal,
        retryLast: false, canRetry: () => !response.headersSent,
        onAttempt(attempt) {
          // Repeated continuation segments share a region. Keep its latest status in the bounded header.
          if (attempts.at(-1)?.location === attempt.location) attempts.pop();
          attempts.push(attempt);
          attempt.startedMs = diagnostic.elapsed();
        } });
      const post = body => {
        const serialized = JSON.stringify(body);
        return sendRegion(async location => {
          const base = location === config.location ? config.baseUrl : vertexBaseUrl(config.authMode, config.projectId, location);
          const url = buildNativeUrl(base, prepared.model, prepared.upstreamStream);
          const reply = await fetchImpl(longDecode ? longDecodeUrl(url) : url, {
            method: "POST", headers, body: serialized, signal, redirect: "error",
          });
          attempts.at(-1).headersMs = diagnostic.elapsed();
          const traceId = reply.headers.get("x-goog-request-id") ?? reply.headers.get("x-request-id");
          if (traceId && !traceId.includes(credential) && !/^(?:AIza|sk-|ghp_|github_pat_)/.test(traceId) && /^[a-z0-9_-]{1,96}$/i.test(traceId)) attempts.at(-1).upstreamRequestId = traceId;
          return reply;
        }, Boolean(body.continuationToken || body.cachedContent));
      };
      const upstream = await (longDecode ? fetchLongDecode(post, prepared.body, prepared.upstreamStream) : post(prepared.body));
      writeRegionHeaders();
      if (upstream.status === 429 && upstream.headers.has("retry-after")) response.setHeader("retry-after", upstream.headers.get("retry-after"));
      if (upstream.ok) diagnostic.stage("restoration");
      const restored = await restoreSillyTavernResponse(upstream, prepared, credential, upstream.ok ? await loadUsageEstimator() : undefined, frame => {
        const finish = enumToken(frame?.candidates?.[0]?.finishReason);
        if (finish) log.upstreamFinish = finish;
      });
      // ST's global compression() would hold SSE chunks until the reply ends; no-transform opts out.
      response.setHeader("cache-control", prepared.stream ? "no-store, no-transform" : "no-store");
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("x-anti-truncation-transport", prepared.upstreamStream ? "native-streaming" : "buffered");
      if (prepared.continuation) response.setHeader("x-vertex-continuation", "suffix");
      for (const [name, value] of Object.entries(outputLimitHeaders(prepared.outputLimit))) response.setHeader(name, value);
      response.setHeader("content-type", restored.headers.get("content-type"));
      if (prepared.stream) response.setHeader("x-accel-buffering", "no");
      for await (const bytes of restored.body) {
        signal.throwIfAborted();
        log.firstWriteMs ??= diagnostic.elapsed();
        log.lastWriteMs = diagnostic.elapsed();
        log.bytesSent += bytes.length;
        if (!response.write(Buffer.from(bytes))) await once(response, "drain", { signal });
      }
      signal.throwIfAborted();
      response.end();
      await diagnostic.finish("ok", null, null, null, response);
    } catch (error) {
      if (client.signal.aborted || response.destroyed) {
        await diagnostic.finish("disconnected", error, "downstream_disconnected", null, response);
        return;
      }
      const stage = log.stage;
      writeRegionHeaders();
      const upstreamError = deadline.aborted ? null : error.upstreamError ?? googleErrorDetail(error.upstreamBody, credential);
      const status = deadline.aborted ? 504 : error.status ?? upstreamError?.code ?? (stage === "configuration" ? 400 : stage === "image" ? 503 : 502);
      const code = deadline.aborted ? "vertex_timeout" : error.protocolFailure || error.status ? error.code
        : error.unreachable && stage === "authentication" ? "vertex_authentication_unreachable"
        : stage === "image" ? "image_render_failed" : `vertex_${stage}_failed`;
      const detail = configurationProblem(error.message) ?? configurationProblem(code) ?? oauthProblem(error.oauthReason) ?? (
        stage === "configuration" ? "读取 Vertex 连接设置失败。" :
        code === "vertex_authentication_unreachable" ? "无法连接 Google 换取 Vertex 令牌。请检查网络和酒馆 config.yaml 中的 requestProxy 代理设置。" :
        stage === "authentication" ? "Vertex 鉴权失败，请检查已保存的凭据。" : stage === "image" ? "图片输入转换失败，未改用明文发送。" :
        imageMode !== "off" && request.body?.vertex_anti_truncation === "off" ? "Vertex 图片输入请求失败。" : "Vertex 抗截断请求失败。");
      const location = imageErrorLocation(error);
      const where = location.character ? ` ${location.character}，${location.param}。` : "";
      const message = [googleProblem(upstreamError), upstreamMessage(upstreamError, ["invalid_transport_tool_name", "unsupported_primary_location"].includes(code) ? error.message : detail + where)].filter(Boolean).join(" · ");
      const locationInResponse = response.headersSent ? "流式错误" : `HTTP ${status}`;
      log.resultStatus = status;
      await diagnostic.finish("error", error, code, upstreamError, response);
      const cause = log.network.map(value => `${systemCodes[value]}（${value}）`).join("、");
      const find = log.storage === "stderr" ? "酒馆服务端控制台" : "Vertex AI → 最近请求";
      const payload = { error: { code, ...location, diagnostic: log,
        message: [message, cause, `(${code}, ${locationInResponse})`, `${find} · ${log.id}`].filter(Boolean).join(" "),
        ...(upstreamError ? { upstreamError } : {}) } };
      if (response.headersSent) { response.write(sseData(payload)); response.end(); }
      else {
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.status(status).json(payload);
      }
    } finally { response.off("close", close); }
  };
}

export async function init(router) {
  const part = (phase, promise) => promise.catch(cause => {
    throw Object.assign(new Error("Plugin startup failed", { cause }), { startupPhase: phase });
  });
  await part("build", identifyServerBuild());
  // Installed at <SillyTavern>/plugins/<repo>/integrations/sillytavern/server.mjs.
  const [prompts, secrets, constants, nodeFetch] = await Promise.all([
    part("tavern-prompts", import(new URL("../../../../src/prompt-converters.js", import.meta.url))),
    part("tavern-secrets", import(new URL("../../../../src/endpoints/secrets.js", import.meta.url))),
    part("tavern-constants", import(new URL("../../../../src/constants.js", import.meta.url))),
    part("node-fetch", import("node-fetch")),
  ]);
  const adapters = { ...prompts, ...secrets, safetySettings: [...constants.GEMINI_SAFETY, ...constants.VERTEX_SAFETY] };
  router.get("/status", (request, response) => {
    response.setHeader("cache-control", "no-store");
    if (!request.user?.directories) return response.sendStatus(401);
    response.json({ id: PLUGIN_ID, version: PLUGIN_VERSION, environment: serverEnvironment, ready: true, features: PLUGIN_FEATURES });
  });
  router.post("/generate", createGenerateHandler(adapters, { fetchImpl: webFetch(nodeFetch.default) }));
  router.post("/image-input", convertImages);
  router.get("/diagnostics", readDiagnostics);
}
