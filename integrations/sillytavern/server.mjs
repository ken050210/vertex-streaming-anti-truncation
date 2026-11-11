import { once } from "node:events";
import { buildConnectionConfig } from "../../src/config.mjs";
import { prepareImageInput } from "../../src/image-input.mjs";
import { buildNativeUrl } from "../../src/vertex-native.mjs";
import { parseServiceAccount } from "../../src/vertex-auth.mjs";
import { outputLimitHeaders, validateGemini4Connection } from "../../src/gemini4.mjs";
import { fetchLongDecode, longDecodeUrl } from "../../src/vertex-long-decode.mjs";
import { upstreamDispatcher } from "../../src/gateway.mjs";
import { prepareSillyTavernRequest, restoreSillyTavernResponse, requestError } from "../../src/sillytavern.mjs";
import { googleErrorDetail, sseData, upstreamMessage } from "../../src/wire.mjs";
import { waitWithSignal } from "../../src/abort.mjs";
import { BODY_LIMIT, PLUGIN_FEATURES, PLUGIN_ID, PLUGIN_VERSION } from "./shared.js";

import { loadUsageEstimator } from "./google-usage-estimate.mjs";

export const info = { id: PLUGIN_ID, name: "Vertex AI Anti-Truncation", description: "Native Vertex text transport using SillyTavern's saved credentials." };

function imageErrorLocation(error) {
  return error.code === "image_input_unsupported_characters"
    ? { param: error.param, character: error.character } : {};
}

// PayGo owns generation and billing. Its UI only needs our local rasterizer.
export async function convertImages(request, response) {
  if (!request.user?.directories) return response.sendStatus(401);
  const { mode, messages } = request.body ?? {};
  const client = new AbortController();
  const close = () => client.abort();
  response.once("close", close);
  try {
    if (!["all", "current-turn"].includes(mode)) throw requestError("invalid_image_input_mode");
    if (Buffer.byteLength(JSON.stringify(request.body)) > BODY_LIMIT) throw Object.assign(requestError("image_input_too_large"), { status: 413 });
    const { payload, metadata } = await prepareImageInput({ messages }, mode, BODY_LIMIT, { signal: client.signal });
    response.setHeader("cache-control", "no-store");
    return response.json({ messages: payload.messages, metadata });
  } catch (error) {
    if (!client.signal.aborted) return response.status(error.status ?? 503).json({ error: { code: error.code ?? "image_render_failed", ...imageErrorLocation(error) } });
  } finally { response.off("close", close); }
}

export function connectionForRequest(request, { readSecret, SECRET_KEYS }) {
  const body = request.body;
  const auth = body.vertexai_auth_mode ?? "express";
  if (!["express", "full"].includes(auth) || body.reverse_proxy) throw requestError("unsupported_authentication_mode");
  const settings = { authMode: auth === "full" ? "service-account" : "express", location: body.vertexai_region || "us-central1",
    serviceTier: body.vertexai_service_tier || "standard", projectId: body.vertexai_express_project_id || "" };
  if (auth === "full") {
    settings.serviceAccountJson = readSecret(request.user.directories, SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, body.secret_id);
    settings.projectId = parseServiceAccount(settings.serviceAccountJson).project_id;
  } else {
    settings.apiKey = readSecret(request.user.directories, SECRET_KEYS.VERTEXAI, body.secret_id);
  }
  // Reuse the gateway's validated official Google destinations and token cache.
  const config = buildConnectionConfig(settings);
  validateGemini4Connection(config, body.model);
  return config;
}

export function createGenerateHandler(adapters, { fetchImpl = fetch, timeoutMs = 600000 } = {}) {
  return async (request, response) => {
    if (!request.user?.directories) return response.status(401).json({ error: { message: "SillyTavern login required" } });
    const client = new AbortController();
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([client.signal, deadline]);
    const close = () => { if (!response.writableEnded) client.abort(); };
    response.once("close", close);
    let stage = "request";
    let credential;
    const imageMode = request.body?.vertex_image_input ?? "off";
    try {
      // Validate normal plugin eligibility before spending CPU rasterizing.
      let prepared = prepareSillyTavernRequest(request, adapters);
      if (imageMode !== "off") {
        stage = "image";
        const converted = await prepareImageInput(request.body, imageMode, BODY_LIMIT, {signal});
        prepared = prepareSillyTavernRequest({ ...request, body: converted.payload }, adapters);
        response.setHeader("x-image-input", converted.metadata?.reason || "disabled");
        response.setHeader("x-image-input-pages", String(converted.metadata?.pages ?? 0));
      }
      stage = "configuration";
      const config = connectionForRequest(request, adapters);
      stage = "authentication";
      credential = await waitWithSignal(() => config.accessToken(), signal);
      signal.throwIfAborted();
      const headers = { ...config.tierHeaders, "content-type": "application/json",
        ...(config.authMode === "express" ? { "x-goog-api-key": credential } : { authorization: `Bearer ${credential}` }) };
      stage = "upstream";
      const dispatcher = await waitWithSignal(() => upstreamDispatcher(timeoutMs), signal);
      signal.throwIfAborted();
      const longDecode = prepared.outputLimit?.longDecode === true;
      const url = buildNativeUrl(config.baseUrl, prepared.model, prepared.upstreamStream);
      const post = body => fetchImpl(longDecode ? longDecodeUrl(url) : url, {
        method: "POST", headers, body: JSON.stringify(body), signal, redirect: "error",
        dispatcher,
      });
      const upstream = await (longDecode ? fetchLongDecode(post, prepared.body, prepared.upstreamStream) : post(prepared.body));
      stage = "restoration";
      const restored = await restoreSillyTavernResponse(upstream, prepared, credential, upstream.ok ? await loadUsageEstimator() : undefined);
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
        if (!response.write(Buffer.from(bytes))) await once(response, "drain", { signal });
      }
      response.end();
    } catch (error) {
      if (client.signal.aborted || response.destroyed) return;
      const upstreamError = deadline.aborted ? null : error.upstreamError ?? googleErrorDetail(error.upstreamBody, credential);
      const status = deadline.aborted ? 504 : error.status ?? upstreamError?.code ?? (stage === "configuration" ? 400 : stage === "image" ? 503 : 502);
      const code = deadline.aborted ? "vertex_timeout" : error.protocolFailure || error.status ? error.code
        : stage === "image" ? "image_render_failed" : `vertex_${stage}_failed`;
      const detail = code === "express_project_required" ? "快速模式使用 Gemini 4 Argon 需要填写 API Key 所属的项目 ID，以指定 global 地区。" :
        stage === "configuration" ? "检查 Vertex 凭据和地区；Express、Flex、Priority 需要 global。" :
        stage === "authentication" ? "Vertex 鉴权失败，请检查已保存的凭据。" : stage === "image" ? "图片输入转换失败，未改用明文发送。" :
        imageMode !== "off" && request.body?.vertex_anti_truncation === "off" ? "Vertex 图片输入请求失败。" : "Vertex 抗截断请求失败。";
      const location = imageErrorLocation(error);
      const where = location.character ? ` ${location.character}，${location.param}。` : "";
      const message = upstreamMessage(upstreamError, code === "invalid_transport_tool_name" ? error.message : detail + where);
      const locationInResponse = response.headersSent ? "流式错误" : `HTTP ${status}`;
      const payload = { error: { code, ...location, message: `${message} (${code}, ${locationInResponse})`, ...(upstreamError ? { upstreamError } : {}) } };
      if (response.headersSent) { response.write(sseData(payload)); response.end(); }
      else {
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.status(status).json(payload);
      }
    } finally { response.off("close", close); }
  };
}

export async function init(router) {
  // Installed at <SillyTavern>/plugins/<repo>/integrations/sillytavern/server.mjs.
  const [prompts, secrets, constants] = await Promise.all([
    import(new URL("../../../../src/prompt-converters.js", import.meta.url)),
    import(new URL("../../../../src/endpoints/secrets.js", import.meta.url)),
    import(new URL("../../../../src/constants.js", import.meta.url)),
  ]);
  const adapters = { ...prompts, ...secrets, safetySettings: [...constants.GEMINI_SAFETY, ...constants.VERTEX_SAFETY] };
  router.get("/status", (request, response) => {
    response.setHeader("cache-control", "no-store");
    if (!request.user?.directories) return response.sendStatus(401);
    response.json({ id: PLUGIN_ID, version: PLUGIN_VERSION, ready: true, features: PLUGIN_FEATURES });
  });
  router.post("/generate", createGenerateHandler(adapters));
  router.post("/image-input", convertImages);
}
