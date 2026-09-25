import { randomUUID } from "node:crypto";
import { buildNativeBody, translateUsage, mapFinishReason } from "./vertex-native.mjs";
import { protocolError } from "./completion-integrity.mjs";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const requestFields = new Set(["model", "messages", "stream", "stream_options", "max_tokens", "max_completion_tokens",
  "temperature", "top_p", "top_k", "frequency_penalty", "presence_penalty", "seed", "stop", "n", "best_of",
  "response_format", "tools", "functions", "reasoning_effort", "extra_body", "logit_bias", "logprobs", "top_logprobs", "thinking"]);
const thinkingFields = new Set(["thinking_budget", "thinkingBudget", "thinking_level", "thinkingLevel", "include_thoughts", "includeThoughts"]);
const budgets = { low: 1024, medium: 8192, high: 24576 };

// Experimental text requests only. Fall back to the original OpenAI-compatible
// transport when translation would discard fields, message metadata or media.
export function supportsNativeTextStream(payload) {
  if (Object.keys(payload).some(key => payload[key] != null && !requestFields.has(key))) return false;
  // Some SillyTavern custom connections send this Anthropic-only switch. Vertex's
  // compatible API ignores it, so keep provider defaults instead of forcing a
  // buffered fallback or interpreting it as a Gemini thinking-budget override.
  if (payload.thinking != null && (!object(payload.thinking) || payload.thinking.type !== "disabled" ||
      Object.keys(payload.thinking).some(key => key !== "type"))) return false;
  if (payload.reasoning_effort != null && !Object.hasOwn(budgets, payload.reasoning_effort)) return false;
  if (payload.logit_bias != null && (!object(payload.logit_bias) || Object.keys(payload.logit_bias).length)) return false;
  if (payload.logprobs || payload.top_logprobs) return false;
  if (payload.stream_options != null && (!object(payload.stream_options) || Object.keys(payload.stream_options).some(k => k !== "include_usage"))) return false;
  for (const message of payload.messages) {
    if (!["system", "developer", "user", "assistant"].includes(message.role)) return false;
    if (Object.keys(message).some(key => message[key] != null && key !== "role" && key !== "content")) return false;
    if (typeof message.content !== "string" && !(Array.isArray(message.content) && message.content.every(part =>
      object(part) && part.type === "text" && typeof part.text === "string" && Object.keys(part).every(k => k === "text" || k === "type")))) return false;
  }
  if (payload.extra_body == null) return true;
  if (!object(payload.extra_body) || Object.keys(payload.extra_body).some(k => k !== "google")) return false;
  const google = payload.extra_body.google;
  if (google == null) return true;
  if (!object(google) || Object.keys(google).some(k => !["thinking_config", "safety_settings", "cached_content", "media_resolution"].includes(k))) return false;
  if (google.thinking_config != null && (payload.reasoning_effort != null || !object(google.thinking_config) ||
      Object.keys(google.thinking_config).some(k => !thinkingFields.has(k)))) return false;
  if (google.safety_settings != null && (!Array.isArray(google.safety_settings) || google.safety_settings.some(s =>
      !object(s) || Object.keys(s).some(k => !["category", "threshold", "method"].includes(k))))) return false;
  return true;
}

export function buildNativeTextBody(payload) {
  const body = applyNativeOptions(buildNativeBody(payload), payload);
  body.toolConfig.functionCallingConfig.streamFunctionCallArguments = true;
  return body;
}

export function applyNativeOptions(body, payload) {
  const google = payload.extra_body?.google ?? {};
  // Match the compatible endpoint's provider defaults unless explicitly supplied.
  delete body.safetySettings;
  if (google.safety_settings != null) body.safetySettings = structuredClone(google.safety_settings);
  if (google.cached_content != null) body.cachedContent = google.cached_content;
  body.generationConfig ??= {};
  if (google.media_resolution != null) body.generationConfig.mediaResolution = google.media_resolution;
  if (google.thinking_config != null) {
    body.generationConfig.thinkingConfig = Object.fromEntries(Object.entries(google.thinking_config)
      .map(([key, value]) => [key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), value]));
  } else if (payload.reasoning_effort != null) {
    body.generationConfig.thinkingConfig = { thinkingBudget: budgets[payload.reasoning_effort] };
  }
  return body;
}

const fail = suffix => { throw protocolError("anti_truncation_native_" + suffix); };

// Convert the native partialArgs for our one owned string into valid, incremental
// OpenAI tool JSON. The existing restorer then handles it just like a stable call.
export function wrapNativeTextStream(response, toolName, model) {
  if (!response.ok || !response.body) return response;
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  const id = "chatcmpl-" + randomUUID(), created = Math.floor(Date.now() / 1000);
  let buffer = "", started = false, stringStarted = false, stringClosed = false, callClosed = false;
  let fullArgs = false, terminal = false, failed = false, usage;
  const emit = (controller, data) => controller.enqueue(encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`));
  const chunk = (controller, delta, finish_reason = null, nativeReason) => emit(controller, {
    id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason,
      ...(nativeReason ? { native_finish_reason: nativeReason } : {}) }],
  });
  const args = (controller, value) => chunk(controller, { tool_calls: [{ index: 0, function: { arguments: value } }] });
  const call = (controller, fc) => {
    if (callClosed || (fc.name != null && fc.name !== toolName)) fail("unexpected_call");
    if (!started) {
      if (fc.name !== toolName) fail("missing_name");
      started = true;
      chunk(controller, { role: "assistant", tool_calls: [{ index: 0, id: "call_" + randomUUID(), type: "function", function: { name: toolName, arguments: "" } }] });
    }
    if (fc.args != null) {
      if (stringStarted || fullArgs || !object(fc.args) || typeof fc.args.content !== "string") fail("invalid_args");
      fullArgs = true; stringClosed = true;
      args(controller, JSON.stringify(fc.args));
    }
    if (fc.partialArgs != null && !Array.isArray(fc.partialArgs)) fail("invalid_partial_args");
    for (const part of fc.partialArgs ?? []) {
      if (fullArgs || stringClosed || part.jsonPath !== "$.content" || typeof part.stringValue !== "string") fail("invalid_partial_args");
      if (!stringStarted) { args(controller, '{"content":"'); stringStarted = true; }
      if (part.stringValue) args(controller, JSON.stringify(part.stringValue).slice(1, -1));
      if (part.willContinue !== true) { args(controller, '"'); stringClosed = true; }
    }
    if (fc.willContinue !== true) {
      if (!stringClosed) fail("incomplete_args");
      if (!fullArgs) args(controller, "}");
      callClosed = true;
    }
  };
  const event = (controller, raw) => {
    const data = raw.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    let parsed;
    try { parsed = JSON.parse(data); } catch { fail("invalid_sse"); }
    if (parsed.error) { failed = true; emit(controller, parsed); return; }
    if (failed) return;
    if (parsed.usageMetadata) usage = translateUsage(parsed.usageMetadata);
    if (parsed.candidates?.length > 1) fail("multiple_candidates");
    const candidate = parsed.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (terminal && (part.functionCall || part.text)) fail("data_after_finish");
      if (part.functionCall) call(controller, part.functionCall);
      if (part.text) chunk(controller, part.thought === true ? { reasoning_content: part.text } : { content: part.text });
    }
    const reason = candidate?.finishReason ?? parsed.promptFeedback?.blockReason;
    if (reason) {
      if (terminal) fail("duplicate_finish");
      if (reason === "STOP" && started && !callClosed) fail("incomplete_args");
      terminal = true;
      chunk(controller, {}, mapFinishReason(reason, started), reason);
    }
  };
  const drain = controller => {
    for (;;) {
      const match = /\r\n\r\n|\n\n/.exec(buffer);
      if (!match) break;
      if (match.index > 2 * 1024 * 1024) fail("event_limit");
      const raw = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
      event(controller, raw);
    }
    if (buffer.length > 2 * 1024 * 1024) fail("event_limit");
  };
  const body = response.body.pipeThrough(new TransformStream({
    transform(bytes, controller) { buffer += decoder.decode(bytes, { stream: true }); drain(controller); },
    flush(controller) {
      buffer += decoder.decode(); drain(controller);
      if (buffer.trim()) event(controller, buffer);
      if (failed) return;
      if (!terminal) fail("stream_interrupted");
      if (usage) emit(controller, { id, object: "chat.completion.chunk", created, model, choices: [], usage });
      emit(controller, "[DONE]");
    },
  }));
  const headers = new Headers(response.headers);
  headers.delete("content-length"); headers.delete("content-encoding");
  headers.set("content-type", "text/event-stream; charset=utf-8");
  return new Response(body, { status: response.status, headers });
}
