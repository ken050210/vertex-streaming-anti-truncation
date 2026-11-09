import { SIGNATURE_ID_PREFIX, mapFinishReason, translateUsage } from "./vertex-native.mjs";
import { checkPromptFeedback, checkSseError, isObject, protocolError, sseData, transformSse } from "./wire.mjs";
import { isGemini4Argon, encodeGemini4ToolId } from "./gemini4.mjs";
// Native replies for requests without the synthetic transport: complete replies,
// and streams whose function calls arrive whole.

function candidateMessage(candidate, model) {
  const message = { role: "assistant", content: "" };
  for (const part of candidate.content?.parts ?? []) {
    if (part.text && part.thought) message.reasoning_content = (message.reasoning_content || "") + part.text;
    else if (part.text) message.content += part.text;
    if (part.functionCall) {
      const fc = part.functionCall;
      // FunctionCall.args is optional: a call to a parameterless function may omit it.
      const args = fc.args ?? {};
      if (fc.partialArgs || typeof fc.name !== "string" || !isObject(args)) throw protocolError("invalid_native_tool");
      (message.tool_calls ??= []).push({ id: isGemini4Argon(model) && fc.id ? encodeGemini4ToolId(part) : part.thoughtSignature ? SIGNATURE_ID_PREFIX + part.thoughtSignature : "call_" + crypto.randomUUID(),
        type: "function", function: { name: fc.name, arguments: JSON.stringify(args) } });
    }
  }
  if (message.tool_calls && !message.content) message.content = null;
  return message;
}

export function translateNativeCompletion(native, model) {
  if ((Array.isArray(native) ? native[0] : native)?.error) throw Object.assign(protocolError("upstream_error_object"), { upstreamBody: native });
  if (!isObject(native)) throw protocolError("invalid_native_completion");
  checkPromptFeedback(native);
  const candidates = native.candidates;
  if (!Array.isArray(candidates) || !candidates.length) throw protocolError("invalid_native_completion");
  return { id: "chatcmpl-" + crypto.randomUUID(), object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: candidates.map((c, i) => {
      const message = candidateMessage(c, model);
      if (!c.finishReason) throw protocolError("incomplete_native_completion");
      return { index: c.index ?? i, message, finish_reason: mapFinishReason(c.finishReason, Boolean(message.tool_calls)), native_finish_reason: c.finishReason };
    }), usage: translateUsage(native.usageMetadata) };
}

// Real tool requests do not enable partialArgs. Their complete function calls and
// thought signatures are preserved while normal text is forwarded immediately.
// The empty-choices usage chunk follows OpenAI's stream_options.include_usage.
export function wrapNativeStream(response, model, onUsage = () => {}, includeUsage = true) {
  const id = "chatcmpl-" + crypto.randomUUID(), created = Math.floor(Date.now() / 1000);
  const states = new Map();
  let usage;
  return transformSse(response, ({ data, event }, emit) => {
    checkSseError(event, data, "native_stream_error");
    if (!data || data.trim() === "[DONE]") return;
    const parsed = JSON.parse(data);
    if ((Array.isArray(parsed) ? parsed[0] : parsed)?.error) throw Object.assign(protocolError("native_stream_error"), { upstreamBody: parsed });
    checkPromptFeedback(parsed);
    if (parsed.usageMetadata) { usage = translateUsage(parsed.usageMetadata); onUsage(usage); }
    const candidates = parsed.candidates ?? [];
    for (const candidate of candidates) {
      const index = candidate.index ?? 0;
      const state = states.get(index) || { done: false, tools: 0 };
      if (state.done) throw protocolError("native_data_after_finish");
      const message = candidateMessage(candidate, model);
      const delta = { ...message };
      if (message.tool_calls) delta.tool_calls = message.tool_calls.map(call => ({ ...call, index: state.tools++ }));
      const reason = candidate.finishReason ? mapFinishReason(candidate.finishReason, state.tools > 0) : null;
      emit(sseData({ id, object: "chat.completion.chunk", created, model, choices: [{ index, delta, finish_reason: reason,
        ...(candidate.finishReason ? { native_finish_reason: candidate.finishReason } : {}) }] }));
      state.done = Boolean(reason); states.set(index, state);
    }
  }, emit => {
    if (!states.size || [...states.values()].some(s => !s.done)) throw protocolError("native_stream_interrupted");
    if (includeUsage && usage) emit(sseData({ id, object: "chat.completion.chunk", created, model, choices: [], usage }));
    emit(sseData("[DONE]"));
  });
}
