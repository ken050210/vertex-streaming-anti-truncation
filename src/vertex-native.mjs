import { responseJsonSchema, vertexJsonSchema } from "./vertex-schema.mjs";
import { isObject } from "./wire.mjs";
import { isGemini4Argon, gemini4ToolMetadata } from "./gemini4.mjs";
// OpenAI-compatible requests translated to Vertex's native generateContent format,
// with the checks that decide whether a request translates without loss.

export const SIGNATURE_ID_PREFIX = "vtx.";
const FINISH_REASONS = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  SPII: "content_filter",
  BLOCKLIST: "content_filter",
  RECITATION: "content_filter",
  IMAGE_SAFETY: "content_filter",
};
const requestFields = new Set(["model", "messages", "stream", "stream_options", "max_tokens", "max_completion_tokens",
  "temperature", "top_p", "top_k", "frequency_penalty", "presence_penalty", "seed", "stop", "n", "best_of",
  "response_format", "tools", "functions", "reasoning_effort", "extra_body", "logit_bias", "logprobs", "top_logprobs", "thinking"]);
const thinkingFields = new Set(["thinking_budget", "thinkingBudget", "thinking_level", "thinkingLevel", "include_thoughts", "includeThoughts"]);
const budgets = { low: 1024, medium: 8192, high: 24576 };
const keys = (value, allowed) => isObject(value) && Object.keys(value).every(key => allowed.includes(key));
// OpenAI's per-image detail becomes Gemini's request-wide media resolution only when
// every image asks for the same low/high level. Mixed, missing or "auto" details (a
// rendered text page has none) keep the provider default.
const imageResolutions = new Map([["low", "MEDIA_RESOLUTION_LOW"], ["high", "MEDIA_RESOLUTION_HIGH"]]);
function detailResolution(messages) {
  const levels = messages.flatMap(m => Array.isArray(m?.content) ? m.content.filter(p => p?.type === "image_url") : [])
    .map(part => imageResolutions.get(part.image_url?.detail));
  return levels.length && levels.every(level => level && level === levels[0]) ? levels[0] : undefined;
}

// Experimental text requests only. Fall back to the original OpenAI-compatible
// transport when translation would discard fields, message metadata or media.
export function supportsNativeTextStream(payload) {
  if (Object.keys(payload).some(key => payload[key] != null && !requestFields.has(key))) return false;
  // Some SillyTavern custom connections send this Anthropic-only switch. Vertex's
  // compatible API ignores it, so keep provider defaults instead of forcing a
  // buffered fallback or interpreting it as a Gemini thinking-budget override.
  if (payload.thinking != null && (!isObject(payload.thinking) || payload.thinking.type !== "disabled" ||
      Object.keys(payload.thinking).some(key => key !== "type"))) return false;
  if (payload.reasoning_effort != null && !Object.hasOwn(budgets, payload.reasoning_effort)) return false;
  if (payload.logit_bias != null && (!isObject(payload.logit_bias) || Object.keys(payload.logit_bias).length)) return false;
  if (payload.logprobs || payload.top_logprobs) return false;
  if (payload.stream_options != null && (!isObject(payload.stream_options) || Object.keys(payload.stream_options).some(k => k !== "include_usage"))) return false;
  for (const message of payload.messages) {
    if (!["system", "developer", "user", "assistant"].includes(message.role)) return false;
    if (Object.keys(message).some(key => message[key] != null && key !== "role" && key !== "content")) return false;
    if (typeof message.content !== "string" && !(Array.isArray(message.content) && message.content.every(part =>
      isObject(part) && part.type === "text" && typeof part.text === "string" && Object.keys(part).every(k => k === "text" || k === "type")))) return false;
  }
  if (payload.extra_body == null) return true;
  if (!isObject(payload.extra_body) || Object.keys(payload.extra_body).some(k => k !== "google")) return false;
  const google = payload.extra_body.google;
  if (google == null) return true;
  if (!isObject(google) || Object.keys(google).some(k => !["thinking_config", "safety_settings", "cached_content", "media_resolution"].includes(k))) return false;
  if (google.thinking_config != null && (payload.reasoning_effort != null || !isObject(google.thinking_config) ||
      Object.keys(google.thinking_config).some(k => !thinkingFields.has(k)))) return false;
  if (google.safety_settings != null && (!Array.isArray(google.safety_settings) || google.safety_settings.some(s =>
      !isObject(s) || Object.keys(s).some(k => !["category", "threshold", "method"].includes(k))))) return false;
  return true;
}

// Native-only authentication/tiering cannot fall back to chatCompletions. Reject
// unrepresentable fields before authentication or inference instead of losing them.
export function supportsNativeRequest(payload) {
  if (payload.functions?.length || payload.function_call != null || payload.parallel_tool_calls != null) return false;
  if (payload.n != null && (!Number.isInteger(payload.n) || payload.n < 1 || payload.n > 8)) return false;
  if (payload.best_of != null && payload.best_of !== 1) return false;
  if (payload.tools != null && (!Array.isArray(payload.tools) || payload.tools.some(t =>
    !keys(t, ["type", "function"]) || t.type !== "function" || !keys(t.function, ["name", "description", "parameters"]) || !t.function.name))) return false;
  const choice = payload.tool_choice;
  if (choice != null && !["auto", "none", "required"].includes(choice) &&
    !(keys(choice, ["type", "function"]) && choice.type === "function" && keys(choice.function, ["name"]) && choice.function.name)) return false;
  const format = payload.response_format;
  if (format != null && (!isObject(format) || !["text", "json_object", "json_schema"].includes(format.type))) return false;
  if (format?.type === "json_schema" && (!isObject(format.json_schema) || (format.json_schema.strict != null && typeof format.json_schema.strict !== "boolean"))) return false;
  for (const message of payload.messages) {
    if (!keys(message, ["role", "content", "tool_calls", "tool_call_id", "name", "thoughtSignature"]) || message.role === "function") return false;
    if (message.thoughtSignature != null && (message.role !== "assistant" || typeof message.thoughtSignature !== "string")) return false;
    if (message.name != null && message.role !== "tool") return false;
    if (message.tool_calls != null) {
      if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return false;
      for (const call of message.tool_calls) {
        if (!keys(call, ["id", "type", "function", "signature", "extra_content"]) || call.type !== "function" || !keys(call.function, ["name", "arguments"]) || !call.function.name) return false;
        if (call.signature != null && typeof call.signature !== "string") return false;
        if (call.extra_content != null && !(keys(call.extra_content, ["google"]) && keys(call.extra_content.google, ["thoughtSignature"]) &&
            typeof call.extra_content.google.thoughtSignature === "string")) return false;
        try { if (!isObject(JSON.parse(call.function.arguments))) return false; } catch { return false; }
      }
    }
    if (message.role === "tool" && (typeof message.content !== "string" || !message.tool_call_id)) return false;
    // Vertex systemInstruction is text-only, so instructions cannot carry images.
    const imageAllowed = message.role !== "system" && message.role !== "developer";
    if (message.content != null && typeof message.content !== "string" && !(Array.isArray(message.content) && message.content.every(part =>
      (keys(part, ["type", "text"]) && part.type === "text" && typeof part.text === "string") ||
      (imageAllowed && keys(part, ["type", "image_url"]) && part.type === "image_url" && keys(part.image_url, ["url", "detail"]) &&
        [undefined, null, "auto", "low", "high"].includes(part.image_url.detail) && /^data:[^;,]+;base64,.+$/s.test(part.image_url.url))))) return false;
  }
  // An explicit request-wide resolution cannot also keep a different level that every image asked for.
  const level = detailResolution(payload.messages), override = payload.extra_body?.google?.media_resolution;
  if (level && override != null && override !== level) return false;
  const check = { ...payload, messages: payload.messages.map(m => ({ role: m.role === "tool" ? "user" : m.role, content: "" })) };
  delete check.tool_choice;
  return supportsNativeTextStream(check);
}

export function buildNativeUrl(baseUrl, upstreamModel, stream) {
  const base = baseUrl.replace(/\/$/, "").replace(/\/endpoints\/openapi$/, "");
  const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  return `${base}/publishers/google/models/${upstreamModel.replace(/^google\//, "")}:${method}`;
}

function contentParts(content) {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const item of content) {
    if (item?.type === "text" && typeof item.text === "string") {
      parts.push({ text: item.text });
    } else if (item?.type === "image_url") {
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(item.image_url?.url || "");
      if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
  }
  return parts;
}

function functionResponsePart(message, callNames, model) {
  const name = callNames.get(message.tool_call_id) || message.name || "tool";
  let response;
  try {
    const parsed = JSON.parse(typeof message.content === "string" ? message.content : "");
    response = isObject(parsed) ? parsed : { result: parsed };
  } catch {
    response = { result: typeof message.content === "string" ? message.content : "" };
  }
  return { functionResponse: { name, response, ...(isGemini4Argon(model) ? { id: gemini4ToolMetadata(message.tool_call_id).id } : {}) } };
}

function assistantParts(message, model) {
  const parts = contentParts(message.content);
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    let args;
    try {
      args = JSON.parse(call.function?.arguments);
      if (!isObject(args)) throw new Error();
    } catch {
      throw Object.assign(new Error("invalid_tool_history"), { status: 400, code: "invalid_tool_history" });
    }
    const part = { functionCall: { name: call.function?.name || "tool", args } };
    if (isGemini4Argon(model)) {
      const metadata = gemini4ToolMetadata(call.id);
      part.functionCall.id = metadata.id;
      if (metadata.signature) part.thoughtSignature = metadata.signature;
    }
    if (typeof call.id === "string" && call.id.startsWith(SIGNATURE_ID_PREFIX)) {
      part.thoughtSignature = call.id.slice(SIGNATURE_ID_PREFIX.length);
    }
    const signature = call.extra_content?.google?.thoughtSignature ?? call.signature;
    if (signature) part.thoughtSignature ??= signature;
    parts.push(part);
  }
  if (message.thoughtSignature && parts.length) parts[0].thoughtSignature ??= message.thoughtSignature;
  return parts;
}

function toolConfig(payload) {
  const choice = payload.tool_choice;
  if (choice === undefined) return undefined;
  if (choice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (choice === "required") return { functionCallingConfig: { mode: "ANY" } };
  if (choice?.type === "function" && choice.function?.name) {
    return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.function.name] } };
  }
  return { functionCallingConfig: { mode: "AUTO" } };
}

function buildNativeBody(payload, meowCompat = false) {
  const systemParts = [];
  const contents = [];
  const callNames = new Map();
  for (const message of payload.messages) {
    for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
      if (typeof call?.id === "string" && call.function?.name) callNames.set(call.id, call.function.name);
    }
  }
  let leading = true;
  for (const message of payload.messages) {
    if (!message || typeof message !== "object") continue;
    // Only the leading instructions become systemInstruction. Like SillyTavern's own
    // Google converter, later ones (post-history, depth prompts) stay in place as user text.
    if (leading && (message.role === "system" || message.role === "developer")) {
      systemParts.push(...contentParts(message.content));
      continue;
    }
    leading = false;
    const role = message.role === "assistant" ? "model" : "user";
    const parts =
      message.role === "assistant"
        ? assistantParts(message, payload.model)
        : message.role === "tool"
          ? [functionResponsePart(message, callNames, payload.model)]
          : contentParts(message.content);
    if (parts.length === 0) continue;
    const previous = contents.at(-1);
    // Text sharing a turn with function responses is rejected (Gemini 3.7: "Requests ending
    // with a model turn are not supported"), so later user text starts its own turn.
    const afterResults = message.role !== "tool" && previous?.parts.some(part => part.functionResponse);
    if (previous?.role === role && !afterResults) previous.parts.push(...parts);
    else contents.push({ role, parts });
  }
  if (contents.length === 0) contents.push({ role: "user", parts: [{ text: " " }] });

  const google = payload.extra_body?.google ?? {};
  const generationConfig = {};
  const maxTokens = payload.max_tokens ?? payload.max_completion_tokens;
  if (Number.isFinite(maxTokens)) generationConfig.maxOutputTokens = maxTokens;
  if (Number.isFinite(payload.temperature)) generationConfig.temperature = payload.temperature;
  if (Number.isFinite(payload.top_p)) generationConfig.topP = payload.top_p;
  if (Number.isFinite(payload.top_k)) generationConfig.topK = payload.top_k;
  if (Number.isFinite(payload.presence_penalty)) generationConfig.presencePenalty = payload.presence_penalty;
  if (Number.isFinite(payload.frequency_penalty)) generationConfig.frequencyPenalty = payload.frequency_penalty;
  if (Number.isFinite(payload.seed)) generationConfig.seed = payload.seed;
  if (payload.stop !== undefined) {
    generationConfig.stopSequences = Array.isArray(payload.stop) ? payload.stop : [payload.stop];
  }
  const responseFormat = payload.response_format;
  if (responseFormat?.type === "json_object") {
    generationConfig.responseMimeType = "application/json";
  } else if (responseFormat?.type === "json_schema") {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseJsonSchema = responseJsonSchema(responseFormat.json_schema);
  }
  const mediaResolution = google.media_resolution ?? detailResolution(payload.messages);
  if (mediaResolution != null) generationConfig.mediaResolution = mediaResolution;
  if (google.thinking_config != null) {
    generationConfig.thinkingConfig = Object.fromEntries(Object.entries(google.thinking_config)
      .map(([key, value]) => [key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), value]));
  } else if (payload.reasoning_effort != null) {
    generationConfig.thinkingConfig = { thinkingBudget: budgets[payload.reasoning_effort] };
  }

  const body = { contents, generationConfig };
  if (systemParts.length > 0) body.systemInstruction = { parts: systemParts };
  // Like the compatible endpoint, keep provider safety defaults unless the client supplies settings.
  if (google.safety_settings != null) body.safetySettings = structuredClone(google.safety_settings);
  if (google.cached_content != null) body.cachedContent = google.cached_content;
  // The index comes from the request's own tools array, so a schema error names the right tool.
  const declarations = (Array.isArray(payload.tools) ? payload.tools : []).flatMap((tool, index) =>
    tool?.type === "function" && tool.function?.name ? [{
      name: tool.function.name,
      description: tool.function.description || "",
      [meowCompat && tool.function.name === "soliumbra_reply" && tool.function.parameters?.propertyOrdering &&
        Object.keys(tool.function.parameters).every(key => ["type", "description", "properties", "required", "propertyOrdering"].includes(key)) &&
        Object.values(tool.function.parameters.properties ?? {}).every(field => field?.type === "string" && Object.keys(field).every(key => ["type", "description", "enum"].includes(key)))
        ? "parameters" : "parametersJsonSchema"]: vertexJsonSchema(tool.function.parameters ?? { type: "object", properties: {} }, `/tools/${index}/function/parameters`),
    }] : []);
  if (declarations.length > 0) {
    body.tools = [{ functionDeclarations: declarations }];
    const config = toolConfig(payload);
    if (config) body.toolConfig = config;
  }
  return body;
}

export function buildNativeTextBody(payload) {
  const body = buildNativeBody(payload);
  body.toolConfig.functionCallingConfig.streamFunctionCallArguments = true;
  return body;
}

export function nativeRequestBody(payload, { meowCompat = false } = {}) {
  const body = buildNativeBody(payload, meowCompat);
  if (payload.n != null) body.generationConfig.candidateCount = payload.n;
  return body;
}

export function translateUsage(usageMetadata) {
  if (!usageMetadata || typeof usageMetadata !== "object") return undefined;
  const promptTokens = usageMetadata.promptTokenCount ?? 0;
  const completionTokens = (usageMetadata.candidatesTokenCount ?? 0) + (usageMetadata.thoughtsTokenCount ?? 0);
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usageMetadata.totalTokenCount ?? promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: usageMetadata.cachedContentTokenCount ?? 0 },
  };
  if (usageMetadata.trafficType) usage.traffic_type = usageMetadata.trafficType;
  return usage;
}

export function mapFinishReason(finishReason, hasToolCalls) {
  // A tool call does not make a truncated or blocked candidate complete.
  if (finishReason === "STOP") return hasToolCalls ? "tool_calls" : "stop";
  return FINISH_REASONS[finishReason] || "error";
}
