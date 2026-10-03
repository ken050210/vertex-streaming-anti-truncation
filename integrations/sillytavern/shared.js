import { prepareUnicodeInput } from "../../src/unicode-input.mjs";
export const PLUGIN_ID = "vertex-anti-truncation";
export const PLUGIN_VERSION = "0.3.0";
export const MODES = ["off", "buffered", "streaming"];
export const GENERATE_PATH = "/api/backends/chat-completions/generate";
export const PLUGIN_PATH = `/api/plugins/${PLUGIN_ID}`;

export function latestUserFloor(chat) {
  if (!Array.isArray(chat)) return "";
  for (let index = chat.length - 1; index >= 0; index--) {
    const floor = chat[index];
    if (!floor || floor.is_system === true || floor.is_user !== true) continue;
    return typeof floor.mes === "string" ? floor.mes : "";
  }
  return "";
}

// Shared by both sides: unsupported requests keep SillyTavern's original route.
export function bypassReason(body, mode) {
  if (mode === "off" || !MODES.includes(mode)) return "disabled";
  if (body?.chat_completion_source !== "vertexai") return "other-provider";
  if (body.reverse_proxy) return "reverse-proxy";
  if (!/^gemini-[\w.-]+$/.test(body.model || "") || /image|embedding/i.test(body.model)) return "model";
  if (body.tools?.length || body.functions?.length || body.tool_choice != null || body.function_call != null) return "existing-tools";
  if (body.json_schema || body.responseSchema || (body.responseMimeType && body.responseMimeType !== "text/plain") ||
      (body.response_format && body.response_format.type !== "text")) return "structured-output";
  if ((body.n != null && body.n !== 1) || (body.best_of != null && body.best_of !== 1)) return "multiple-candidates";
  if (body.enable_web_search) return "web-search";
  if (body.request_images) return "image-generation";
  if (Array.isArray(body.messages) && body.messages.some(message => message?.role === "tool" || message?.role === "function" ||
      message?.tool_calls?.length || message?.function_call || message?.tool_call_id ||
      (Array.isArray(message?.content) && message.content.some(part => part?.type === "tool_calls" || part?.type === "tool_call_id")))) return "tool-history";
  return null;
}

// ST 1.19 exposes a settings event, but not a generation-URL override. Intercept
// only its same-origin Vertex POST; preserve the original fetch for everything else.
export function createFetchInterceptor(originalFetch, { origin, getMode, getUnicodeInput = () => false, getImageInput = () => "off", getUserFloor = () => "", onStatus = () => {} }) {
  return async function vertexFetch(input, init) {
    let url;
    try { url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, origin); }
    catch { return originalFetch(input, init); }
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const mode = getMode();
    const unicodeEnabled = getUnicodeInput() === true;
    const imageMode = getImageInput();
    const imageEnabled = imageMode !== "off";
    if ((mode === "off" && !unicodeEnabled && !imageEnabled) || url.origin !== origin || url.pathname !== GENERATE_PATH || method.toUpperCase() !== "POST") {
      return originalFetch(input, init);
    }
    let body;
    try {
      body = typeof init?.body === "string" ? JSON.parse(init.body)
        : init?.body == null && input instanceof Request ? await input.clone().json() : null;
    } catch { return originalFetch(input, init); }
    if (!body || body.chat_completion_source !== "vertexai") return originalFetch(input, init);
    if (imageEnabled && unicodeEnabled) throw new Error("input_encoding_conflict");
    let unicode;
    if (unicodeEnabled) {
      try {
        const prepared = prepareUnicodeInput({ ...body, router_unicode_input: { user_floor: getUserFloor() } }, true, 8 * 1024 * 1024);
        body = prepared.payload; unicode = prepared.metadata;
      } catch (error) { onStatus({ error: error.code || "unicode_input_failed" }); throw error; }
    }
    const reason = bypassReason(body, imageEnabled && mode === "off" ? "buffered" : mode);
    if (imageEnabled) {
      if (!["current-turn", "all"].includes(imageMode) || reason) { onStatus({error:"image_input_requires_supported_request"}); throw new Error("image_input_requires_supported_request"); }
      body.vertex_image_input = imageMode;
    }
    if (reason && !unicodeEnabled) { onStatus({ bypass: reason }); return originalFetch(input, init); }
    onStatus({ mode, bypass: reason, unicode });
    const target = reason ? url.href : new URL(`${PLUGIN_PATH}/generate`, origin).href;
    const payload = JSON.stringify(reason ? body : { ...body, vertex_anti_truncation: mode });
    let response;
    try {
      if (input instanceof Request) {
        const source = new Request(input.clone(), init);
        const redirected = new Request(target, {
          method: "POST", headers: source.headers, body: payload, signal: source.signal,
          credentials: source.credentials, cache: source.cache, redirect: source.redirect,
          referrer: source.referrer, referrerPolicy: source.referrerPolicy, mode: source.mode,
        });
        response = await originalFetch(redirected);
      } else {
        response = await originalFetch(reason ? input : `${PLUGIN_PATH}/generate`, { ...init, body: payload });
      }
    } catch (error) { onStatus({ error: "network" }); throw error; }
    if (!response.ok) onStatus({ error: response.status });
    // Never resubmit to the original route after a failed plugin request.
    return response;
  };
}
