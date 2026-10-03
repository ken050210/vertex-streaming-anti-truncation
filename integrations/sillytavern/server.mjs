import { once } from "node:events";
import { buildConnectionConfig } from "../../src/config.mjs";
import { prepareImageInput } from "../../src/image-input.mjs";
import { buildNativeUrl } from "../../src/vertex-native.mjs";
import { parseServiceAccount } from "../../src/vertex-auth.mjs";
import { upstreamDispatcher } from "../../src/gateway.mjs";
import { prepareSillyTavernRequest, restoreSillyTavernResponse, requestError } from "../../src/sillytavern.mjs";
import { sseData } from "../../src/wire.mjs";
import { waitWithSignal } from "../../src/abort.mjs";
import { PLUGIN_ID, PLUGIN_VERSION } from "./shared.js";

export const info = { id: PLUGIN_ID, name: "Vertex AI Anti-Truncation", description: "Native Vertex text transport using SillyTavern's saved credentials." };

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
  // Preserve ST's optional Express project scope.
  if (auth === "express" && settings.projectId) config.baseUrl += `/projects/${settings.projectId}/locations/${settings.location}`;
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
    try {
      const imageMode = request.body?.vertex_image_input ?? "off";
      // Validate normal plugin eligibility before spending CPU rasterizing.
      let prepared = prepareSillyTavernRequest(request, adapters);
      if (imageMode !== "off") {
        const converted = await prepareImageInput(request.body, imageMode, 8 * 1024 * 1024, {signal});
        prepared = prepareSillyTavernRequest({ ...request, body: converted.payload }, adapters);
        response.setHeader("x-image-input", converted.metadata?.reason || "disabled");
      }
      stage = "configuration";
      const config = connectionForRequest(request, adapters);
      stage = "authentication";
      const credential = await waitWithSignal(() => config.accessToken(), signal);
      signal.throwIfAborted();
      const headers = { ...config.tierHeaders, "content-type": "application/json",
        ...(config.authMode === "express" ? { "x-goog-api-key": credential } : { authorization: `Bearer ${credential}` }) };
      stage = "upstream";
      const dispatcher = await waitWithSignal(() => upstreamDispatcher(timeoutMs), signal);
      signal.throwIfAborted();
      const upstream = await fetchImpl(buildNativeUrl(config.baseUrl, prepared.model, prepared.upstreamStream), {
        method: "POST", headers, body: JSON.stringify(prepared.body), signal, redirect: "error",
        dispatcher,
      });
      stage = "restoration";
      const restored = await restoreSillyTavernResponse(upstream, prepared);
      response.setHeader("cache-control", "no-store");
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("x-anti-truncation-transport", prepared.upstreamStream ? "native-streaming" : "buffered");
      response.setHeader("content-type", restored.headers.get("content-type"));
      if (prepared.stream) response.setHeader("x-accel-buffering", "no");
      for await (const bytes of restored.body) {
        signal.throwIfAborted();
        if (!response.write(Buffer.from(bytes))) await once(response, "drain", { signal });
      }
      response.end();
    } catch (error) {
      if (client.signal.aborted || response.destroyed) return;
      const status = deadline.aborted ? 504 : error.status ?? (stage === "configuration" ? 400 : 502);
      // Do not echo provider error bodies, URLs, prompts or credential exceptions.
      const code = deadline.aborted ? "vertex_timeout" : error.protocolFailure || error.status ? error.code : `vertex_${stage}_failed`;
      const detail = stage === "configuration" ? "检查 Vertex 凭据和地区；Express、Flex、Priority 需要 global。" :
        stage === "authentication" ? "Vertex 鉴权失败，请检查已保存的凭据。" : "Vertex 抗截断请求失败。";
      const payload = { error: { code, message: `${detail} (${code}, HTTP ${status})` } };
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
    response.json({ id: PLUGIN_ID, version: PLUGIN_VERSION, ready: true });
  });
  router.post("/generate", createGenerateHandler(adapters));
}
