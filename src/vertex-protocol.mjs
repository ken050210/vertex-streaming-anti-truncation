import { randomUUID } from "node:crypto";
import { SIGNATURE_ID_PREFIX, mapFinishReason, translateUsage } from "./vertex-native.mjs";
import { isObject, protocolError, sseData, transformSse } from "./wire.mjs";
// Native replies for requests without the synthetic transport: complete replies,
// and streams whose function calls arrive whole.

function candidateMessage(candidate) {
  const message = { role: "assistant", content: "" };
  for (const part of candidate.content?.parts ?? []) {
    if (part.text && part.thought) message.reasoning_content = (message.reasoning_content || "") + part.text;
    else if (part.text) message.content += part.text;
    if (part.functionCall) {
      const fc = part.functionCall;
      if (fc.partialArgs || typeof fc.name !== "string" || !isObject(fc.args)) throw protocolError("invalid_native_tool");
      (message.tool_calls ??= []).push({ id: part.thoughtSignature ? SIGNATURE_ID_PREFIX + part.thoughtSignature : "call_" + randomUUID(),
        type: "function", function: { name: fc.name, arguments: JSON.stringify(fc.args) } });
    }
  }
  if (message.tool_calls && !message.content) message.content = null;
  return message;
}

export function translateNativeCompletion(native, model) {
  if (!isObject(native) || native.error) throw protocolError("invalid_native_completion");
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
  const id = "chatcmpl-" + randomUUID(), created = Math.floor(Date.now() / 1000);
  const states = new Map();
  let usage;
  return transformSse(response, ({ data }, emit) => {
    if (!data || data.trim() === "[DONE]") return;
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
      emit(sseData({ id, object: "chat.completion.chunk", created, model, choices: [{ index, delta, finish_reason: reason }] }));
      state.done = Boolean(reason); states.set(index, state);
    }
  }, emit => {
    if (!states.size || [...states.values()].some(s => !s.done)) throw protocolError("native_stream_interrupted");
    if (usage) emit(sseData({ id, object: "chat.completion.chunk", created, model, choices: [], usage }));
    emit(sseData("[DONE]"));
  });
}
