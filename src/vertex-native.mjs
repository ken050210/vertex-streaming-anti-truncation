import { vertexJsonSchema } from "./vertex-schema.mjs";
// Shared Vertex request/usage helpers. Native text streaming validates the
// supported request fields before invoking these helpers.

const SIGNATURE_ID_PREFIX = "vtx.";
const SAFETY_CATEGORIES = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
];
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

export function nativeModelId(upstreamModel) {
  return upstreamModel.replace(/^google\//, "");
}

export function buildNativeUrl(baseUrl, upstreamModel, stream) {
  const base = baseUrl.replace(/\/$/, "").replace(/\/endpoints\/openapi$/, "");
  const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  return `${base}/publishers/google/models/${nativeModelId(upstreamModel)}:${method}`;
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

function functionResponsePart(message, callNames) {
  const name = callNames.get(message.tool_call_id) || message.name || "tool";
  let response;
  try {
    const parsed = JSON.parse(typeof message.content === "string" ? message.content : "");
    response = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { result: parsed };
  } catch {
    response = { result: typeof message.content === "string" ? message.content : "" };
  }
  return { functionResponse: { name, response } };
}

function assistantParts(message) {
  const parts = contentParts(message.content);
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    let args;
    try {
      args = JSON.parse(call.function?.arguments);
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error();
    } catch {
      throw Object.assign(new Error("invalid_tool_history"), { status: 400, code: "invalid_tool_history" });
    }
    const part = { functionCall: { name: call.function?.name || "tool", args } };
    if (typeof call.id === "string" && call.id.startsWith(SIGNATURE_ID_PREFIX)) {
      part.thoughtSignature = call.id.slice(SIGNATURE_ID_PREFIX.length);
    }
    parts.push(part);
  }
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

export function buildNativeBody(payload) {
  const systemParts = [];
  const contents = [];
  const callNames = new Map();
  for (const message of payload.messages) {
    for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
      if (typeof call?.id === "string" && call.function?.name) callNames.set(call.id, call.function.name);
    }
  }
  for (const message of payload.messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "system" || message.role === "developer") {
      systemParts.push(...contentParts(message.content));
      continue;
    }
    const role = message.role === "assistant" ? "model" : "user";
    const parts =
      message.role === "assistant"
        ? assistantParts(message)
        : message.role === "tool"
          ? [functionResponsePart(message, callNames)]
          : contentParts(message.content);
    if (parts.length === 0) continue;
    const previous = contents.at(-1);
    if (previous?.role === role) previous.parts.push(...parts);
    else contents.push({ role, parts });
  }
  if (contents.length === 0) contents.push({ role: "user", parts: [{ text: " " }] });

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
    const schema = responseFormat.json_schema?.schema ?? responseFormat.json_schema;
    generationConfig.responseJsonSchema = vertexJsonSchema(schema);
  }

  const body = {
    contents,
    safetySettings: SAFETY_CATEGORIES.map((category) => ({ category, threshold: "BLOCK_NONE" })),
  };
  if (systemParts.length > 0) body.systemInstruction = { parts: systemParts };
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
  const declarations = (Array.isArray(payload.tools) ? payload.tools : [])
    .filter((tool) => tool?.type === "function" && tool.function?.name)
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description || "",
      parametersJsonSchema: vertexJsonSchema(tool.function.parameters ?? { type: "object", properties: {} }, "/tools/function/parameters"),
    }));
  if (declarations.length > 0) {
    body.tools = [{ functionDeclarations: declarations }];
    const config = toolConfig(payload);
    if (config) body.toolConfig = config;
  }
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
