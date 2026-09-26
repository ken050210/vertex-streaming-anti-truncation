import { randomUUID } from "node:crypto";
import { mapFinishReason, translateUsage } from "./vertex-native.mjs";
import { isObject, protocolError, sseData, transformSse } from "./wire.mjs";

const fail = suffix => { throw protocolError("anti_truncation_native_" + suffix); };

// Convert the native partialArgs for our one owned string into valid, incremental
// OpenAI tool JSON. The existing restorer then handles it just like a stable call.
export function wrapNativeTextStream(response, toolName, model) {
  if (!response.ok || !response.body) return response;
  const id = "chatcmpl-" + randomUUID(), created = Math.floor(Date.now() / 1000);
  let started = false, stringStarted = false, stringClosed = false, callClosed = false;
  let fullArgs = false, terminal = false, failed = false, usage;
  const chunk = (emit, delta, finish_reason = null, nativeReason) => emit(sseData({
    id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason,
      ...(nativeReason ? { native_finish_reason: nativeReason } : {}) }],
  }));
  const args = (emit, value) => chunk(emit, { tool_calls: [{ index: 0, function: { arguments: value } }] });
  const call = (emit, fc) => {
    if (callClosed || (fc.name != null && fc.name !== toolName)) fail("unexpected_call");
    if (!started) {
      if (fc.name !== toolName) fail("missing_name");
      started = true;
      chunk(emit, { role: "assistant", tool_calls: [{ index: 0, id: "call_" + randomUUID(), type: "function", function: { name: toolName, arguments: "" } }] });
    }
    if (fc.args != null) {
      if (stringStarted || fullArgs || !isObject(fc.args) || typeof fc.args.content !== "string") fail("invalid_args");
      fullArgs = true; stringClosed = true;
      args(emit, JSON.stringify(fc.args));
    }
    if (fc.partialArgs != null && !Array.isArray(fc.partialArgs)) fail("invalid_partial_args");
    for (const part of fc.partialArgs ?? []) {
      if (fullArgs || stringClosed || part.jsonPath !== "$.content" || typeof part.stringValue !== "string") fail("invalid_partial_args");
      if (!stringStarted) { args(emit, '{"content":"'); stringStarted = true; }
      if (part.stringValue) args(emit, JSON.stringify(part.stringValue).slice(1, -1));
      if (part.willContinue !== true) { args(emit, '"'); stringClosed = true; }
    }
    if (fc.willContinue !== true) {
      if (!stringClosed) fail("incomplete_args");
      if (!fullArgs) args(emit, "}");
      callClosed = true;
    }
  };
  return transformSse(response, ({ data }, emit) => {
    if (!data || data.trim() === "[DONE]") return;
    let parsed;
    try { parsed = JSON.parse(data); } catch { fail("invalid_sse"); }
    if (parsed.error) { failed = true; emit(sseData(parsed)); return; }
    if (failed) return;
    if (parsed.usageMetadata) usage = translateUsage(parsed.usageMetadata);
    if (parsed.candidates?.length > 1) fail("multiple_candidates");
    const candidate = parsed.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (terminal && (part.functionCall || part.text)) fail("data_after_finish");
      if (part.functionCall) call(emit, part.functionCall);
      if (part.text) chunk(emit, part.thought === true ? { reasoning_content: part.text } : { content: part.text });
    }
    const reason = candidate?.finishReason ?? parsed.promptFeedback?.blockReason;
    if (reason) {
      if (terminal) fail("duplicate_finish");
      if (reason === "STOP" && started && !callClosed) fail("incomplete_args");
      terminal = true;
      chunk(emit, {}, mapFinishReason(reason, started), reason);
    }
  }, emit => {
    if (failed) return;
    if (!terminal) fail("stream_interrupted");
    if (usage) emit(sseData({ id, object: "chat.completion.chunk", created, model, choices: [], usage }));
    emit(sseData("[DONE]"));
  });
}
