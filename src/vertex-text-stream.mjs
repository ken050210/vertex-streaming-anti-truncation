import { mapFinishReason, translateUsage, SIGNATURE_ID_PREFIX } from "./vertex-native.mjs";
import { encodeGemini4ToolId, isGemini4Argon } from "./gemini4.mjs";
import { NativePartialArgs } from "./vertex-partial-args.mjs";
import { checkPromptFeedback, checkSseError, isObject, protocolError, sseData, transformSse } from "./wire.mjs";

const fail = suffix => { throw protocolError("anti_truncation_native_" + suffix); };

// Stream our owned content string immediately. Client calls are assembled and
// emitted whole, including their final thought signature, for ST's tool reader.
// Google serializes even parallel calls one after another using willContinue.
// The empty-choices usage chunk follows OpenAI's stream_options.include_usage.
export function wrapNativeTextStream(response, toolName, model, onNativeUsage = () => {}, includeUsage = true, tools = [], onTextSignature, transformFields) {
  if (!response.ok || !response.body) return response;
  const id = "chatcmpl-" + crypto.randomUUID(), created = Math.floor(Date.now() / 1000);
  const allowed = new Set(tools.map(tool => tool.function?.name));
  let current, calls = 0, realCalls = 0, textCall = false, removedSignature = false, terminal = false, usage;
  const chunk = (emit, delta, finish_reason = null, nativeReason) => emit(sseData({
    id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason,
      ...(nativeReason ? { native_finish_reason: nativeReason } : {}) }],
  }));
  const args = (emit, value) => chunk(emit, { tool_calls: [{ index: current.index, function: { arguments: value } }] });
  const call = (emit, part) => {
    const fc = part.functionCall;
    if (!current) {
      if (typeof fc.name !== "string" || !fc.name) fail("missing_name");
      const synthetic = fc.name === toolName;
      if ((synthetic && textCall) || (!synthetic && !allowed.has(fc.name))) fail("unexpected_call");
      if (calls >= 16) fail("too_many_calls");
      current = { name: fc.name, index: calls++, synthetic, partial: synthetic ? null : new NativePartialArgs() };
      if (synthetic) {
        textCall = true;
        chunk(emit, { role: "assistant", tool_calls: [{ index: current.index, id: "call_" + crypto.randomUUID(), type: "function", function: { name: toolName, arguments: "" } }] });
      }
    }
    if ((fc.name != null && fc.name !== current.name) || (fc.id != null && current.id != null && fc.id !== current.id)) fail("unexpected_call");
    if (fc.id != null) current.id = fc.id;
    if (part.thoughtSignature) current.signature = part.thoughtSignature;
    if (fc.partialArgs != null && !Array.isArray(fc.partialArgs)) fail("invalid_partial_args");
    if (!current.synthetic) {
      if (fc.args != null) {
        if (current.fullArgs || current.partial.leaves.size || !isObject(fc.args)) fail("invalid_args");
        current.fullArgs = fc.args;
      }
      for (const arg of fc.partialArgs ?? []) {
        if (current.fullArgs) fail("invalid_args");
        current.partial.add(arg);
      }
      if (fc.willContinue === true) return;
      if (!current.partial.complete) fail("incomplete_args");
      // Parallel calls may sign only the first part. If that was our removed
      // text call, its signature cannot be moved onto another call. Use Google's
      // documented marker for rewritten history, preserving real signatures.
      if (!realCalls && removedSignature && !current.signature) current.signature = "skip_thought_signature_validator";
      realCalls++;
      const nativePart = { functionCall: { id: current.id ?? "call_" + crypto.randomUUID() }, thoughtSignature: current.signature };
      const callId = isGemini4Argon(model) ? encodeGemini4ToolId(nativePart)
        : current.signature ? SIGNATURE_ID_PREFIX + current.signature : nativePart.functionCall.id;
      chunk(emit, { role: "assistant", tool_calls: [{ index: current.index, id: callId, type: "function",
        function: { name: current.name, arguments: JSON.stringify(current.fullArgs ?? current.partial.value) } }] });
      current = null;
      return;
    }
    if (fc.args != null) {
      if (current.stringStarted || current.fullArgs || !isObject(fc.args) || typeof fc.args.content !== "string") fail("invalid_args");
      current.fullArgs = true; current.stringClosed = true;
      args(emit, JSON.stringify(fc.args));
    }
    for (const part of fc.partialArgs ?? []) {
      if (!isObject(part) || current.fullArgs || current.stringClosed || part.jsonPath !== "$.content" ||
        ["numberValue", "boolValue", "nullValue"].some(key => Object.hasOwn(part, key))) fail("invalid_partial_args");
      // Google can close a streamed string with only its jsonPath. Accept that
      // marker only after a string fragment, so missing values cannot start one.
      const closesString = current.stringStarted && !Object.hasOwn(part, "stringValue") && part.willContinue !== true;
      if (typeof part.stringValue !== "string" && !closesString) fail("invalid_partial_args");
      if (!current.stringStarted) { args(emit, '{"content":"'); current.stringStarted = true; }
      if (part.stringValue) args(emit, JSON.stringify(part.stringValue).slice(1, -1));
      if (part.willContinue !== true) { args(emit, '"'); current.stringClosed = true; }
    }
    if (fc.willContinue !== true) {
      if (!current.stringClosed) fail("incomplete_args");
      if (!current.fullArgs) args(emit, "}");
      removedSignature = Boolean(current.signature);
      current = null;
    }
  };
  return transformSse(response, ({ data, event }, emit) => {
    checkSseError(event, data, "upstream_stream_error");
    if (!data || data.trim() === "[DONE]") return;
    let parsed;
    try { parsed = JSON.parse(data); } catch { fail("invalid_sse"); }
    if ((Array.isArray(parsed) ? parsed[0] : parsed)?.error) throw Object.assign(protocolError("upstream_stream_error"), { upstreamBody: parsed });
    checkPromptFeedback(parsed);
    transformFields?.(parsed);
    if (parsed.usageMetadata) {
      onNativeUsage(parsed.usageMetadata);
      usage = translateUsage(parsed.usageMetadata);
    }
    if (parsed.candidates?.length > 1) fail("multiple_candidates");
    const candidate = parsed.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (terminal && (part.functionCall || part.text)) fail("data_after_finish");
      if (part.functionCall) call(emit, part);
      if (!part.thought && typeof part.text === "string" && part.thoughtSignature) onTextSignature?.(part.thoughtSignature);
      if (part.text) chunk(emit, part.thought === true ? { reasoning_content: part.text } : { content: part.text });
    }
    const reason = candidate?.finishReason;
    if (reason) {
      if (terminal) fail("duplicate_finish");
      if (reason === "STOP" && current) fail("incomplete_args");
      terminal = true;
      chunk(emit, {}, mapFinishReason(reason, calls > 0), reason);
    }
  }, emit => {
    if (!terminal) fail("stream_interrupted");
    if (includeUsage && usage) emit(sseData({ id, object: "chat.completion.chunk", created, model, choices: [], usage }));
    emit(sseData("[DONE]"));
  });
}
