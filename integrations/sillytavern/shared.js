import { prepareUnicodeInput } from "../../src/unicode-input.mjs";
import { prepareOptimizedInput } from "./optimized-input.js";
import { vertexJsonSchema } from "../../src/vertex-schema.mjs";
import { transportToolBypassReason } from "../../src/transport-tool-name.mjs";
import { normalizeStopUsageWait, validateTagStopRule } from "../../src/tag-stop-rule.mjs";
import { createSseParser } from "../../src/wire.mjs";
export const PLUGIN_ID = "vertex-anti-truncation";
export const PLUGIN_VERSION = "0.14.0";
// The oldest server plugin that understands every request this extension may
// send (Continue arrived in 0.3.1). SillyTavern updates a Git-installed server
// plugin on start but not the extension, so a newer server is common.
export const MIN_SERVER_VERSION = "0.3.1";
// Versions change only at releases, so newer abilities are reported by name. A
// server without "client-tools" rejects client tools and tool history; those keep ST's own route.
export const TOOLS_FEATURE = "client-tools";
export const TUCAO_FEATURE = "stop-after-second-tucao";
export const TAG_STOP_FEATURE = "stop-after-tag-pairs";
export const NATURAL_STOP_USAGE_FEATURE = "tag-stop-natural-usage";
export const TRANSPORT_NAME_FEATURE = "preset-transport-tool";
export const PLUGIN_FEATURES = [TOOLS_FEATURE, TUCAO_FEATURE, TAG_STOP_FEATURE, NATURAL_STOP_USAGE_FEATURE, "image-input-convert", "tag-stop-usage", TRANSPORT_NAME_FEATURE];
export const MODES = ["off", "buffered", "streaming"];
export const GENERATE_PATH = "/api/backends/chat-completions/generate";
const PAYGO_GENERATE_PATH = "/api/plugins/vertex-paygo/native-gemini/generate";
export const PLUGIN_PATH = `/api/plugins/${PLUGIN_ID}`;
export const BODY_LIMIT = 8 * 1024 * 1024;

// ST displays error.message in its toast. Keep the same message in the panel,
// including errors received after the first SSE byte, without teeing the reply.
async function reportResponse(response, onStatus) {
  const report = (data, status) => {
    const detail = data?.error;
    const message = typeof detail === "string" ? detail : detail?.message ?? data?.message;
    onStatus({ error: detail?.code ?? status ?? "upstream_stream_error", ...(status ? { status } : {}),
      ...(typeof message === "string" && message ? { message } : {}),
      ...(detail?.character && detail.param ? { character: detail.character, param: detail.param } : {}) });
  };
  if (!response.ok) {
    report(await response.clone().json().catch(() => null), response.status);
  } else if (response.body && response.headers.get("content-type")?.includes("text/event-stream")) {
    let parser = createSseParser(({ data }) => {
      if (!data?.includes('"error"')) return;
      let value;
      try { value = JSON.parse(data); } catch { return; }
      if (value?.error) report(value);
    });
    return new Response(response.body.pipeThrough(new TransformStream({
      transform(bytes, controller) {
        controller.enqueue(bytes);
        // An oversized third-party event must not interrupt the user's stream.
        try { parser?.push(bytes); } catch { parser = null; }
      },
      flush() { parser?.finish(); },
    })), { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  return response;
}

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
export function bypassReason(body, mode, payGo = false, transportToolName = "") {
  if (mode === "off" || !MODES.includes(mode)) return "disabled";
  if (body?.chat_completion_source !== "vertexai") return "other-provider";
  if (body.reverse_proxy && !payGo) return "reverse-proxy";
  if (!/^gemini-[\w.-]+$/.test(body.model || "") || /image|embedding/i.test(body.model)) return "model";
  if (body.functions?.length || body.function_call != null) return "existing-tools";
  if (body.tools != null && (!Array.isArray(body.tools) || !body.tools.every(nativeTool))) return "tool-schema";
  if (body.json_schema || body.responseSchema || (body.responseMimeType && body.responseMimeType !== "text/plain") ||
      (body.response_format && body.response_format.type !== "text")) return "structured-output";
  if ((body.n != null && body.n !== 1) || (body.best_of != null && body.best_of !== 1)) return "multiple-candidates";
  if (body.enable_web_search) return "web-search";
  if (body.request_images) return "image-generation";
  if (Array.isArray(body.messages) && body.messages.some(message => message?.role === "function" || message?.function_call)) return "tool-history";
  return transportToolBypassReason(body, transportToolName);
}

// ST 1.19 exposes a settings event, but not a generation-URL override. Intercept
// only its same-origin Vertex POST; preserve the original fetch for everything else.
export function createFetchInterceptor(originalFetch, { origin, getMode, getUnicodeInput = () => false, getImageInput = () => "off", getLongDecode = () => false, getTransportToolName = () => "", getTagStop = () => null, getWaitForStopUsage = () => false, getUserFloor = () => "", ensureBackend = async () => true, onStatus = () => {}, direct, payGoInstalled = false, getRequestHeaders = () => ({ "Content-Type": "application/json" }) }) {
  return async function vertexFetch(input, init) {
    let url;
    try { url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, origin); }
    catch { return originalFetch(input, init); }
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const mode = getMode();
    const unicodeMode = getUnicodeInput();
    const optimized = unicodeMode === "optimized" || unicodeMode === "optimized-all";
    const unicodeEnabled = optimized || unicodeMode === true || unicodeMode === "all";
    const imageMode = getImageInput();
    const imageEnabled = imageMode !== "off";
    if ((mode === "off" && !unicodeEnabled && !imageEnabled) || url.origin !== origin || ![GENERATE_PATH, PAYGO_GENERATE_PATH].includes(url.pathname) || method.toUpperCase() !== "POST") {
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
        const scope = unicodeMode === "all" || unicodeMode === "optimized-all" ? "all" : true;
        const source = scope === "all" ? body : { ...body, router_unicode_input: { user_floor: getUserFloor() } };
        const prepared = optimized
          ? await prepareOptimizedInput(source, scope, BODY_LIMIT, { originalFetch, headers: getRequestHeaders(),
            signal: init?.signal ?? (input instanceof Request ? input.signal : undefined) })
          : prepareUnicodeInput(source, scope, BODY_LIMIT);
        body = prepared.payload; unicode = prepared.metadata;
      } catch (error) { onStatus({ error: error.code || "unicode_input_failed" }); throw error; }
    }
    // PayGo can be on either side of this wrapper. Before prepare it marks the
    // request; afterwards it leaves a local ticket and may change the ST route.
    const ticket = /^http:\/\/127\.0\.0\.1:\d+\/proxy\/[\w-]+$/.test(body.reverse_proxy ?? "") && Boolean(body.proxy_password);
    const marked = body.__vertexPayGoRequestState;
    const payGo = !direct && (payGoInstalled || marked || url.pathname === PAYGO_GENERATE_PATH
      || (ticket && typeof globalThis.vertexPayGoGemini4GenerateInterceptor === "function"));
    const ownPayGoProxy = payGo && (ticket || (marked?.sink === body.reverse_proxy && body.reverse_proxy === "vertex-paygo-blocked://request"));
    const transportToolName = mode !== "off" ? getTransportToolName() : "";
    let reason = bypassReason(body, imageEnabled && mode === "off" ? "buffered" : mode, ownPayGoProxy, transportToolName);
    // Image conversion still needs its normal backend when only the text tool is skipped.
    const imageOnlyBypass = imageEnabled && reason?.startsWith("target-tool-") ? reason : null;
    if (imageOnlyBypass) reason = null;
    if (!reason && !direct && !payGo && usesTools(body) && !await ensureBackend(TOOLS_FEATURE)) reason = "server-tools";
    const tagStop = !reason && !imageOnlyBypass && mode !== "off" ? getTagStop() : null;
    const waitForStopUsage = normalizeStopUsageWait(tagStop && getWaitForStopUsage());
    delete body.vertex_long_decode;
    delete body.vertex_transport_tool_name;
    delete body.vertex_wait_for_stop_usage;
    delete body.vertex_tucao_stop;
    delete body.vertex_tag_stop;
    // Without a server plugin (TauriTavern), `direct` adds the transport to ST's
    // own request here and restores the reply below.
    let prepared;
    if (direct && !reason) {
      try { prepared = direct.prepare(body, mode, tagStop, transportToolName); }
      catch (error) { onStatus({ error: error.code || "invalid_request", message: error.message }); throw error; }
      prepared.waitForStopUsage = waitForStopUsage;
      reason = prepared.bypass ?? null;
    }
    if (!reason && tagStop) {
      try { validateTagStopRule(tagStop); }
      catch (error) { onStatus({ error: error.code }); throw error; }
      if (!direct && !payGo && !await ensureBackend(TAG_STOP_FEATURE)) {
        onStatus({ error: "tag_stop_not_supported" }); throw new Error("tag_stop_not_supported");
      }
      if (!direct && !payGo && mode === "streaming" && body.stream === true && waitForStopUsage === "natural" && !await ensureBackend(NATURAL_STOP_USAGE_FEATURE)) {
        onStatus({ error: "natural_stop_usage_not_supported" }); throw new Error("natural_stop_usage_not_supported");
      }
    }
    if (imageEnabled) {
      if (!["current-turn", "all"].includes(imageMode) || reason) { onStatus({ error: "image_input_requires_supported_request", bypass: reason }); throw new Error("image_input_requires_supported_request"); }
      body.vertex_image_input = imageMode;
    }
    if (payGo && !reason) {
      const { sendPayGoRequest } = await import("./paygo.js");
      try {
        const reply = await sendPayGoRequest({ originalFetch, input, init, body, mode, imageMode, tagStop, waitForStopUsage, unicode, transportToolName, longDecode: getLongDecode() === true,
          ensureBackend, getRequestHeaders, onStatus });
        return await reportResponse(reply, onStatus);
      } catch (error) {
        onStatus({ error: error.code ?? error.message, ...(error.message && error.message !== error.code ? { message: error.message } : {}),
          character: error.character, param: error.param });
        throw error;
      }
    }
    let payload = reason ? null : JSON.stringify(prepared?.body ??
      { ...body, vertex_anti_truncation: mode, ...(transportToolName ? { vertex_transport_tool_name: transportToolName } : {}),
        ...(tagStop ? { vertex_tag_stop: tagStop } : {}), ...(waitForStopUsage ? { vertex_wait_for_stop_usage: waitForStopUsage } : {}), ...(getLongDecode() === true ? { vertex_long_decode: true } : {}) });
    // The plugin rejects bodies over its limit; keep ST's own route for plain
    // anti-truncation. Image input never falls back to plaintext.
    if (payload && !imageEnabled && new TextEncoder().encode(payload).length > BODY_LIMIT) reason = "too-large";
    if (reason && !unicodeEnabled) { onStatus({ bypass: reason }); return originalFetch(input, init); }
    if (!reason && !direct && transportToolName && !await ensureBackend(TRANSPORT_NAME_FEATURE)) {
      onStatus({ error: "transport_tool_name_not_supported" }); throw new Error("transport_tool_name_not_supported");
    }
    // Old plugins ignore image settings and Continue semantics. Check only
    // eligible plugin requests; disabled/bypass routes retain ST's behavior.
    if (!reason && !direct && (imageEnabled || body.type === "continue") && !await ensureBackend()) {
      onStatus({ error: "plugin_not_ready" }); throw new Error("plugin_not_ready");
    }
    onStatus({ mode, bypass: reason ?? imageOnlyBypass, unicode });
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
    if (response.ok && !reason && (imageEnabled || body.type === "continue" || outputLimit)) {
      // The plugin reports whether any text was converted; "no-text" was sent as plain text.
      onStatus({ mode,
        ...(imageOnlyBypass ? { bypass: imageOnlyBypass } : {}),
        ...(unicode ? { unicode } : {}),
        ...(outputLimit ? { outputLimit } : {}),
        ...(response.headers.get("x-vertex-continuation") === "suffix" ? { continuation: true } : {}),
        ...(imageEnabled ? { image: { mode: imageMode, reason: response.headers.get("x-image-input"),
          pages: Number(response.headers.get("x-image-input-pages")) || 0, transport: response.headers.get("x-anti-truncation-transport") } } : {}) });
    }
    // Never resubmit to the original route after a failed plugin request.
    return reportResponse(response, onStatus);
  };
}
