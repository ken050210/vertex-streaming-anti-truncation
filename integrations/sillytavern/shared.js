import { prepareUnicodeInput } from "../../src/unicode-input.mjs";
import { vertexJsonSchema } from "../../src/vertex-schema.mjs";
export const PLUGIN_ID = "vertex-anti-truncation";
export const PLUGIN_VERSION = "0.6.2";
// The oldest server plugin that understands every request this extension may
// send (Continue arrived in 0.3.1). SillyTavern updates a Git-installed server
// plugin on start but not the extension, so a newer server is common.
export const MIN_SERVER_VERSION = "0.3.1";
// Versions change only at releases, so newer abilities are reported by name. A
// server without "client-tools" rejects client tools and tool history; those keep ST's own route.
export const TOOLS_FEATURE = "client-tools";
export const PLUGIN_FEATURES = [TOOLS_FEATURE];
export const MODES = ["off", "buffered", "streaming"];
export const GENERATE_PATH = "/api/backends/chat-completions/generate";
export const PLUGIN_PATH = `/api/plugins/${PLUGIN_ID}`;
export const BODY_LIMIT = 8 * 1024 * 1024;

export function compareVersions(a, b) {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) - (right[index] || 0);
  }
  return 0;
}

export function latestUserFloor(chat) {
  if (!Array.isArray(chat)) return "";
  for (let index = chat.length - 1; index >= 0; index--) {
    const floor = chat[index];
    if (!floor || floor.is_system === true || floor.is_user !== true) continue;
    return typeof floor.mes === "string" ? floor.mes : "";
  }
  return "";
}

// Single-floor game cards post no user floor: their front end keeps this turn's
// input in the chat variable 我的行动 and the preset reads it back with getvar.
export const ACTION_VARIABLE = "我的行动";

export function latestUserInput(chat, variables) {
  const floor = latestUserFloor(chat);
  if (floor) return floor;
  const action = variables?.[ACTION_VARIABLE];
  return typeof action === "string" ? action : "";
}

export const usesTools = body => Boolean(body.tools?.length || body.tool_choice != null ||
  (Array.isArray(body.messages) && body.messages.some(message => message?.role === "tool" || message?.tool_calls?.length || message?.tool_call_id ||
    (Array.isArray(message?.content) && message.content.some(part => part?.type === "tool_calls" || part?.type === "tool_call_id")))));

// ST registers its tools on every request while function calling is on, so a tool
// that native declarations cannot hold would otherwise fail every reply.
function nativeTool(tool) {
  if (tool?.type !== "function" || typeof tool.function?.name !== "string" || !tool.function.name) return false;
  try { vertexJsonSchema(tool.function.parameters ?? { type: "object", properties: {} }); return true; }
  catch { return false; }
}

// Shared by both sides: unsupported requests keep SillyTavern's original route.
export function bypassReason(body, mode) {
  if (mode === "off" || !MODES.includes(mode)) return "disabled";
  if (body?.chat_completion_source !== "vertexai") return "other-provider";
  if (body.reverse_proxy) return "reverse-proxy";
  if (!/^gemini-[\w.-]+$/.test(body.model || "") || /image|embedding/i.test(body.model)) return "model";
  if (body.functions?.length || body.function_call != null) return "existing-tools";
  // Client tools stay callable next to the transport tool; a forced choice asks for a call, not text.
  if (body.tool_choice != null && body.tool_choice !== "auto" && body.tool_choice !== "none") return "tool-choice";
  if (body.tools != null && (!Array.isArray(body.tools) || !body.tools.every(nativeTool))) return "tool-schema";
  if (body.json_schema || body.responseSchema || (body.responseMimeType && body.responseMimeType !== "text/plain") ||
      (body.response_format && body.response_format.type !== "text")) return "structured-output";
  if ((body.n != null && body.n !== 1) || (body.best_of != null && body.best_of !== 1)) return "multiple-candidates";
  if (body.enable_web_search) return "web-search";
  if (body.request_images) return "image-generation";
  if (Array.isArray(body.messages) && body.messages.some(message => message?.role === "function" || message?.function_call)) return "tool-history";
  return null;
}

// ST 1.19 exposes a settings event, but not a generation-URL override. Intercept
// only its same-origin Vertex POST; preserve the original fetch for everything else.
export function createFetchInterceptor(originalFetch, { origin, getMode, getUnicodeInput = () => false, getImageInput = () => "off", getLongDecode = () => false, getUserFloor = () => "", ensureBackend = async () => true, onStatus = () => {}, direct }) {
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
        const prepared = prepareUnicodeInput({ ...body, router_unicode_input: { user_floor: getUserFloor() } }, true, BODY_LIMIT);
        body = prepared.payload; unicode = prepared.metadata;
      } catch (error) { onStatus({ error: error.code || "unicode_input_failed" }); throw error; }
    }
    let reason = bypassReason(body, imageEnabled && mode === "off" ? "buffered" : mode);
    if (!reason && !direct && usesTools(body) && !await ensureBackend(TOOLS_FEATURE)) reason = "server-tools";
    if (imageEnabled) {
      if (!["current-turn", "all"].includes(imageMode) || reason) { onStatus({ error: "image_input_requires_supported_request", bypass: reason }); throw new Error("image_input_requires_supported_request"); }
      body.vertex_image_input = imageMode;
    }
    // Without a server plugin (TauriTavern), `direct` adds the transport to ST's
    // own request here and restores the reply below.
    let prepared;
    if (direct && !reason) {
      try { prepared = direct.prepare(body, mode); }
      catch (error) { onStatus({ error: error.code || "invalid_request" }); throw error; }
      reason = prepared.bypass ?? null;
    }
    let payload = reason ? null : JSON.stringify(prepared?.body ??
      { ...body, vertex_anti_truncation: mode, ...(getLongDecode() === true ? { vertex_long_decode: true } : {}) });
    // The plugin rejects bodies over its limit; keep ST's own route for plain
    // anti-truncation. Image input never falls back to plaintext.
    if (payload && !imageEnabled && new TextEncoder().encode(payload).length > BODY_LIMIT) reason = "too-large";
    if (reason && !unicodeEnabled) { onStatus({ bypass: reason }); return originalFetch(input, init); }
    // Old plugins ignore image settings and Continue semantics. Check only
    // eligible plugin requests; disabled/bypass routes retain ST's behavior.
    if (!reason && (imageEnabled || body.type === "continue") && !await ensureBackend()) {
      onStatus({ error: "plugin_not_ready" }); throw new Error("plugin_not_ready");
    }
    onStatus({ mode, bypass: reason, unicode });
    if (reason) payload = JSON.stringify(body);
    const target = reason || direct ? url.href : new URL(`${PLUGIN_PATH}/generate`, origin).href;
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
        response = await originalFetch(reason || direct ? input : `${PLUGIN_PATH}/generate`, { ...init, body: payload });
      }
    } catch (error) { onStatus({ error: "network" }); throw error; }
    if (direct && !reason) response = await direct.restore(response, prepared, init?.signal ?? (input instanceof Request ? input.signal : undefined));
    const applied = Number(response.headers.get("x-gemini-output-tokens-applied"));
    const outputLimit = !reason && applied > 0 ? { requested: Number(response.headers.get("x-gemini-output-tokens-requested")), applied,
      longDecode: response.headers.get("x-gemini-long-decode") === "true" } : null;
    if (!response.ok) {
      // Plugin errors carry a fixed code; ST's own route keeps the HTTP status.
      const code = reason ? undefined : await response.clone().json().then(data => data?.error?.code, () => undefined);
      onStatus(typeof code === "string" && code ? { error: code, status: response.status } : { error: response.status });
    } else if (!reason && (imageEnabled || body.type === "continue" || outputLimit)) {
      // The plugin reports whether any text was converted; "no-text" was sent as plain text.
      // stream says whether ST asked to stream, since the plugin buffers every image request.
      onStatus({ mode,
        ...(unicode ? { unicode } : {}),
        ...(outputLimit ? { outputLimit } : {}),
        ...(response.headers.get("x-vertex-continuation") === "suffix" ? { continuation: true } : {}),
        ...(imageEnabled ? { image: { mode: imageMode, reason: response.headers.get("x-image-input"),
          pages: Number(response.headers.get("x-image-input-pages")) || 0, stream: body.stream === true } } : {}) });
    }
    // Never resubmit to the original route after a failed plugin request.
    return response;
  };
}
