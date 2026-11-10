// Vertex Gemini 4 Argon: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon
// Keep these rules model-specific; earlier Gemini versions retain their budget semantics.
export const isGemini4Argon = model => /^(?:google\/|publishers\/google\/models\/)?gemini-4-argon(?:@[a-z0-9-]+)?$/i.test(model || "");
export const isGemini4Carbon = model => /^(?:google\/|publishers\/google\/models\/)?gemini-4-carbon(?:@[a-z0-9-]+)?$/i.test(model || "");
const invalid = (code, message) => Object.assign(new Error(message), { status: 400, code });

export function validateGemini4Connection(config, model) {
  if (config.authMode === "express" && !config.projectId && (isGemini4Argon(model) || isGemini4Carbon(model))) {
    throw invalid("express_project_required", "Enter the API key's Google Cloud project ID to use this Gemini 4 model with Express at locations/global.");
  }
}

export function gemini4ThinkingLevel(effort) {
  if (effort == null || effort === "") return undefined;
  const value = String(effort).toLowerCase();
  if (value === "auto") return undefined;
  const level = { none: "LOW", min: "LOW", minimal: "LOW", low: "LOW", medium: "MEDIUM", high: "HIGH", max: "HIGH", xhigh: "HIGH" }[value];
  if (!level) throw invalid("invalid_gemini4_thinking_level", "Gemini 4 Argon supports LOW, MEDIUM or HIGH thinking; thinking cannot be disabled.");
  return level;
}

export function prepareGemini4Request(payload, model) {
  if (!isGemini4Argon(model)) return payload;
  const google = payload.extra_body?.google;
  const thinking = google?.thinking_config;
  if (google?.cached_content != null) throw invalid("unsupported_gemini4_cached_content", "Gemini 4 Argon does not support explicit cached_content; use a shared prompt prefix for implicit caching.");
  if (thinking?.thinking_budget != null || thinking?.thinkingBudget != null) {
    throw invalid("unsupported_gemini4_thinking_budget", "Gemini 4 Argon does not support a numeric thinking budget; use thinking_level LOW, MEDIUM or HIGH.");
  }
  if (thinking != null && (typeof thinking !== "object" || Array.isArray(thinking))) {
    throw invalid("invalid_gemini4_thinking_level", "thinking_config must be an object.");
  }
  // An explicit provider config wins, including an include-thoughts-only config.
  const level = gemini4ThinkingLevel(thinking != null ? thinking.thinking_level ?? thinking.thinkingLevel : payload.reasoning_effort);
  if (thinking == null && level == null) {
    if (payload.reasoning_effort == null) return payload;
    const { reasoning_effort, ...result } = payload;
    return result;
  }
  const config = { ...thinking };
  delete config.thinkingLevel;
  delete config.thinking_level;
  if (level != null) config.thinking_level = level;
  const result = { ...payload, extra_body: { ...payload.extra_body, google: { ...google, thinking_config: config } } };
  delete result.reasoning_effort;
  return result;
}

// One Argon request returns at most 65,536 output tokens when streamed and 32,768 when
// not, thinking included; long decode continues a reply in further requests up to
// 1,048,576 minus the input. A larger ceiling is sent as the request's limit, or with
// long decode as the requested total, instead of failing: a high ceiling alone does not
// mean the reply needs it, and even SillyTavern's "Hi" connection test carries the preset's.
export function gemini4OutputLimit(requested, model, { stream = false, limit = stream ? 65536 : 32768, longDecode = false } = {}) {
  if (!isGemini4Argon(model) || !Number.isFinite(requested) || requested <= limit) return null;
  return { requested, applied: longDecode ? Math.min(requested, 1048576) : limit, longDecode };
}

// The same for an OpenAI-format request, which may carry either ceiling field.
export function capGemini4Output(payload, model, options) {
  const outputLimit = gemini4OutputLimit(payload.max_tokens ?? payload.max_completion_tokens, model, options);
  if (!outputLimit) return { payload, outputLimit };
  const capped = { ...payload };
  for (const key of ["max_tokens", "max_completion_tokens"]) if (Number.isFinite(capped[key])) capped[key] = Math.min(capped[key], outputLimit.applied);
  return { payload: capped, outputLimit };
}

// Tells the client the ceiling it asked for, the one sent, and whether long decode may continue past one request.
export const outputLimitHeaders = limit => limit ? { "x-gemini-output-tokens-requested": String(limit.requested),
  "x-gemini-output-tokens-applied": String(limit.applied), "x-gemini-long-decode": String(limit.longDecode) } : {};

// Preserve both the native function-call ID and thought signature inside the
// opaque OpenAI tool-call ID; tool results must echo the native ID on Gemini 4.
export function encodeGemini4ToolId(part) {
  const bytes = new TextEncoder().encode(JSON.stringify({ id: part.functionCall.id,
    ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}) }));
  return "vtx4." + btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function gemini4ToolMetadata(id) {
  // The TauriTavern extension loads this module in a WebView, so node:crypto is
  // resolved here, on the gateway-only tool-history path, not imported at the top.
  if (typeof id === "string" && id.startsWith("vtx.")) return {
    id: "call_" + process.getBuiltinModule("node:crypto").createHash("sha256").update(id).digest("hex").slice(0, 24), signature: id.slice(4),
  };
  if (typeof id !== "string" || !id.startsWith("vtx4.")) return { id };
  try {
    const value = JSON.parse(new TextDecoder().decode(Uint8Array.from(
      atob(id.slice(5).replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0))));
    if (!value || typeof value.id !== "string" || !value.id || (value.signature != null && typeof value.signature !== "string")) throw new Error();
    return value;
  } catch {
    throw invalid("invalid_tool_history", "Invalid Gemini 4 tool-call ID.");
  }
}
