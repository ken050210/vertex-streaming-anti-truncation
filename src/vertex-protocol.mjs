import { protocolError } from "./completion-integrity.mjs";
import { randomUUID } from "node:crypto";
import { buildNativeBody, mapFinishReason, translateUsage } from "./vertex-native.mjs";
import { applyNativeOptions, supportsNativeTextStream } from "./vertex-text-stream.mjs";

const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v, allowed) => object(v) && Object.keys(v).every(k => allowed.includes(k));

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
  if (format != null && (!object(format) || !["text", "json_object", "json_schema"].includes(format.type))) return false;
  if (format?.type === "json_schema" && (!object(format.json_schema) || (format.json_schema.strict != null && typeof format.json_schema.strict !== "boolean"))) return false;
  for (const message of payload.messages) {
    if (!keys(message, ["role", "content", "tool_calls", "tool_call_id", "name"]) || message.role === "function") return false;
    if (message.name != null && message.role !== "tool") return false;
    if (message.tool_calls != null) {
      if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return false;
      for (const call of message.tool_calls) {
        if (!keys(call, ["id", "type", "function"]) || call.type !== "function" || !keys(call.function, ["name", "arguments"]) || !call.function.name) return false;
        try { if (!object(JSON.parse(call.function.arguments))) return false; } catch { return false; }
      }
    }
    if (message.role === "tool" && (typeof message.content !== "string" || !message.tool_call_id)) return false;
    if (message.content != null && typeof message.content !== "string" && !(Array.isArray(message.content) && message.content.every(part =>
      (keys(part, ["type", "text"]) && part.type === "text" && typeof part.text === "string") ||
      (keys(part, ["type", "image_url"]) && part.type === "image_url" && keys(part.image_url, ["url"]) && /^data:[^;,]+;base64,.+$/s.test(part.image_url.url))))) return false;
  }
  const check = { ...payload, messages: payload.messages.map(m => ({ role: m.role === "tool" ? "user" : m.role, content: "" })) };
  delete check.tool_choice;
  return supportsNativeTextStream(check);
}

export function nativeRequestBody(payload) {
  const body = applyNativeOptions(buildNativeBody(payload), payload);
  if (payload.n != null) body.generationConfig.candidateCount = payload.n;
  return body;
}

function candidateMessage(candidate) {
  const message = { role: "assistant", content: "" };
  for (const part of candidate.content?.parts ?? []) {
    if (part.text && part.thought) message.reasoning_content = (message.reasoning_content || "") + part.text;
    else if (part.text) message.content += part.text;
    if (part.functionCall) {
      const fc = part.functionCall;
      if (fc.partialArgs || typeof fc.name !== "string" || !object(fc.args)) throw protocolError("invalid_native_tool");
      (message.tool_calls ??= []).push({ id: part.thoughtSignature ? "vtx." + part.thoughtSignature : "call_" + randomUUID(),
        type: "function", function: { name: fc.name, arguments: JSON.stringify(fc.args) } });
    }
  }
  if (message.tool_calls && !message.content) message.content = null;
  return message;
}

export function translateNativeCompletion(native, model) {
  if (!object(native) || native.error) throw protocolError("invalid_native_completion");
  let candidates = native.candidates;
  if (!candidates?.length && native.promptFeedback?.blockReason) candidates = [{ finishReason: "SAFETY" }];
  if (!Array.isArray(candidates) || !candidates.length) throw protocolError("invalid_native_completion");
  return { id: "chatcmpl-" + randomUUID(), object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: candidates.map((c, i) => {
      const message = candidateMessage(c);
      if (!c.finishReason) throw protocolError("incomplete_native_completion");
      return { index: c.index ?? i, message, finish_reason: mapFinishReason(c.finishReason, Boolean(message.tool_calls)), native_finish_reason: c.finishReason };
    }), usage: translateUsage(native.usageMetadata) };
}

// Real tool requests do not enable partialArgs. Their complete function calls and
// thought signatures are preserved while normal text is forwarded immediately.
export function wrapNativeStream(response, model, onUsage = () => {}) {
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  const id = "chatcmpl-" + randomUUID(), created = Math.floor(Date.now() / 1000);
  let buffer = "", usage;
  const states = new Map();
  const emit = (c, data) => c.enqueue(encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`));
  const event = (controller, raw) => {
    const data = raw.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    const parsed = JSON.parse(data);
    if (parsed.error) throw protocolError("native_stream_error");
    if (parsed.usageMetadata) { usage = translateUsage(parsed.usageMetadata); onUsage(usage); }
    const candidates = parsed.candidates ?? (parsed.promptFeedback?.blockReason ? [{ finishReason: "SAFETY" }] : []);
    for (const candidate of candidates) {
      const index = candidate.index ?? 0;
      const state = states.get(index) || { done: false, tools: 0 };
      if (state.done) throw protocolError("native_data_after_finish");
      const message = candidateMessage(candidate);
      const delta = { ...message };
      if (message.tool_calls) delta.tool_calls = message.tool_calls.map(call => ({ ...call, index: state.tools++ }));
      const reason = candidate.finishReason ? mapFinishReason(candidate.finishReason, state.tools > 0) : null;
      emit(controller, { id, object: "chat.completion.chunk", created, model, choices: [{ index, delta, finish_reason: reason }] });
      state.done = Boolean(reason); states.set(index, state);
    }
  };
  const drain = controller => {
    for (;;) {
      const match = /\r\n\r\n|\n\n/.exec(buffer);
      if (!match) break;
      if (match.index > 2 * 1024 * 1024) throw protocolError("native_event_limit");
      const raw = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length); event(controller, raw);
    }
    if (buffer.length > 2 * 1024 * 1024) throw protocolError("native_event_limit");
  };
  const body = response.body.pipeThrough(new TransformStream({
    transform(bytes, c) { buffer += decoder.decode(bytes, { stream: true }); drain(c); },
    flush(c) {
      buffer += decoder.decode(); drain(c); if (buffer.trim()) event(c, buffer);
      if (!states.size || [...states.values()].some(s => !s.done)) throw protocolError("native_stream_interrupted");
      if (usage) emit(c, { id, object: "chat.completion.chunk", created, model, choices: [], usage });
      emit(c, "[DONE]");
    },
  }));
  return new Response(body, { status: response.status, headers: { "content-type": "text/event-stream" } });
}
