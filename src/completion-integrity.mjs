import { assertStructuredOutput } from "./vertex-schema.mjs";
import { createSseParser, isObject, protocolError } from "./wire.mjs";
// Protocol validation retains bounded SSE events and fixed metadata, never reply text for logs.
const reasons = new Set(["stop", "length", "content_filter", "tool_calls", "function_call"]);
const outcomes = new Set(["complete", "length", "content_filter", "tool_calls", "incomplete", "empty", "error", "cancelled"]);

export function integrityLogFields(value) {
  if (!value) return {};
  return { responseIntegrity: {
    outcome: outcomes.has(value.outcome) ? value.outcome : "incomplete",
    finishReason: reasons.has(value.finishReason) ? value.finishReason : null,
    streamDone: typeof value.streamDone === "boolean" ? value.streamDone : null,
    hasContent: value.hasContent === true,
    hasToolCalls: value.hasToolCalls === true,
    hasReasoning: value.hasReasoning === true,
    hasRefusal: value.hasRefusal === true,
  } };
}
const contentPresent = value => typeof value === "string" ? value.length > 0 :
  Array.isArray(value) && value.some(part => typeof part?.text === "string" && part.text.length > 0);
function flags(message) {
  return {
    hasContent: contentPresent(message?.content) || isObject(message?.audio),
    hasToolCalls: Boolean(message?.tool_calls?.length || message?.function_call),
    hasReasoning: contentPresent(message?.reasoning_content) || contentPresent(message?.reasoning) || Boolean(message?.reasoning_details?.length),
    hasRefusal: typeof message?.refusal === "string" && message.refusal.length > 0,
  };
}
function summary(states, streamDone = null) {
  const values = [...states];
  const merged = { outcome: "complete", finishReason: values[0]?.finishReason ?? null, streamDone,
    hasContent: false, hasToolCalls: false, hasReasoning: false, hasRefusal: false };
  for (const value of values) for (const key of ["hasContent", "hasToolCalls", "hasReasoning", "hasRefusal"]) merged[key] ||= value[key];
  if (values.some(value => value.finishReason === "length")) merged.outcome = "length";
  else if (values.some(value => value.finishReason === "content_filter") || merged.hasRefusal) merged.outcome = "content_filter";
  else if (merged.hasToolCalls) merged.outcome = "tool_calls";
  return merged;
}
function choiceProblem(state) {
  if (!reasons.has(state.finishReason)) return state.finishReason == null ? "missing_finish_reason" : "invalid_finish_reason";
  if (!state.hasContent && !state.hasToolCalls && !state.hasRefusal && !["length", "content_filter"].includes(state.finishReason)) return "empty_completion";
  if (["tool_calls", "function_call"].includes(state.finishReason) && !state.hasToolCalls) return "missing_tool_calls";
  return null;
}
export function inspectCompletion(completion) {
  // Malformed replies still carry useful terminal metadata. Keep only the failing
  // choice's flags/reason; neither a previous choice nor repair may imply success.
  const invalid = (reason, state) => ({ valid: false, reason, integrity: {
    ...(state ? summary([state]) : {}), outcome: reason === "empty_completion" ? "empty" : "error",
  } });
  if (!isObject(completion) || completion.error) return invalid("error_object");
  if (!Array.isArray(completion.choices) || !completion.choices.length) return invalid("missing_choices");
  const states = [];
  for (const choice of completion.choices) {
    if (!isObject(choice)) return invalid("invalid_choice");
    const state = { ...flags(isObject(choice.message) ? choice.message : null), finishReason: choice.finish_reason };
    if (choice.message == null) return invalid(isObject(choice.delta) ? "unexpected_stream_chunk" : "missing_message", state);
    if (!isObject(choice.message)) return invalid("invalid_message", state);
    const problem = choiceProblem(state);
    if (problem) return invalid(problem, state);
    if (state.hasToolCalls) {
      const calls = choice.message.tool_calls ?? [{ function: choice.message.function_call }];
      if (!Array.isArray(calls) || calls.some(call => !isObject(call?.function) || typeof call.function.name !== "string" ||
          !call.function.name || typeof call.function.arguments !== "string")) return invalid("invalid_tool_call", state);
      if (!["length", "content_filter"].includes(state.finishReason)) {
        try { if (calls.some(call => !isObject(JSON.parse(call.function.arguments)))) return invalid("invalid_tool_arguments", state); }
        catch { return invalid("invalid_tool_arguments", state); }
      }
    }
    states.push(state);
  }
  return { valid: true, reason: null, integrity: summary(states) };
}

export function guardCompletionStream(response, onMetadata = () => {}, expectation = null, maxStructuredBytes = 32 * 1024 * 1024) {
  if (!response.ok || !response.body) return response;
  const states = new Map();
  const structured = new Map();
  const toolBuffers = new Map();
  let structuredBytes = 0;
  let done = false;
  const metadata = outcome => ({ ...summary(states.values(), done), ...(outcome ? { outcome } : {}) });
  const fail = code => {
    onMetadata(metadata(code === "empty_stream" || code === "empty_completion" ? "empty" :
      code === "incomplete_stream" || code === "missing_finish_reason" ? "incomplete" : "error"));
    throw protocolError(code);
  };
  const parser = createSseParser(({ data, event }) => {
    if (event === "error") fail("upstream_stream_error");
    if (!data) return;
    if (done) fail("data_after_done");
    if (data.trim() === "[DONE]") {
      if (!states.size) fail("empty_stream");
      for (const state of states.values()) {
        const problem = choiceProblem(state);
        if (problem) fail(problem);
      }
      for (const [index, calls] of toolBuffers) {
        if (["length", "content_filter"].includes(states.get(index).finishReason)) continue;
        for (const call of calls.values()) {
          if (!call.name) fail("invalid_tool_call");
          try { if (!isObject(JSON.parse(call.arguments))) fail("invalid_tool_arguments"); }
          catch (error) { if (error.protocolFailure) throw error; fail("invalid_tool_arguments"); }
        }
      }
      if (expectation) for (const [index, state] of states) {
        if (state.finishReason === "stop" && !state.hasRefusal && !state.hasToolCalls) {
          try { assertStructuredOutput(structured.get(index) || "", expectation); }
          catch (error) { fail(error.code); }
        }
      }
      structured.clear();
      toolBuffers.clear();
      done = true;
      onMetadata(metadata());
      return;
    }
    let parsed;
    try { parsed = JSON.parse(data); } catch { fail("invalid_sse_json"); }
    if (!isObject(parsed) || parsed.error) fail("upstream_stream_error");
    if (parsed.choices != null && !Array.isArray(parsed.choices)) fail("invalid_stream_choices");
    for (const [position, choice] of (parsed.choices ?? []).entries()) {
      if (!isObject(choice)) fail("invalid_stream_choice");
      const index = choice.index ?? position;
      if (!Number.isInteger(index) || index < 0 || index >= 128) fail("invalid_choice_index");
      const state = states.get(index) ?? { ...flags({}), finishReason: null };
      const delta = choice.delta ?? choice.message ?? {};
      if (!isObject(delta)) fail("invalid_stream_delta");
      const incoming = flags(delta);
      const calls = delta.tool_calls ?? (delta.function_call ? [{ index: 0, function: delta.function_call }] : []);
      if (!Array.isArray(calls)) fail("invalid_tool_call");
      for (const [position, call] of calls.entries()) {
        const toolIndex = call?.index ?? position;
        if (!isObject(call) || !Number.isInteger(toolIndex) || toolIndex < 0 || toolIndex >= 128) fail("invalid_tool_call");
        const buffers = toolBuffers.get(index) ?? new Map();
        const buffered = buffers.get(toolIndex) ?? { name: "", arguments: "" };
        if (call.function != null && !isObject(call.function)) fail("invalid_tool_call");
        for (const key of ["name", "arguments"]) if (call.function?.[key] != null) {
          if (typeof call.function[key] !== "string") fail("invalid_tool_call");
          structuredBytes += new TextEncoder().encode(call.function[key]).length;
          if (structuredBytes > maxStructuredBytes) fail("structured_output_limit");
          buffered[key] += call.function[key];
        }
        if (buffered.name.length > 1024) fail("invalid_tool_call");
        buffers.set(toolIndex, buffered); toolBuffers.set(index, buffers);
      }
      if (expectation && typeof delta.content === "string") {
        structuredBytes += new TextEncoder().encode(delta.content).length;
        if (structuredBytes > maxStructuredBytes) fail("structured_output_limit");
        structured.set(index, (structured.get(index) || "") + delta.content);
      }
      if (state.finishReason != null && (Object.values(incoming).some(Boolean) || choice.finish_reason != null)) fail("data_after_finish");
      for (const key of Object.keys(incoming)) state[key] ||= incoming[key];
      if (choice.finish_reason != null) {
        if (!reasons.has(choice.finish_reason)) fail("invalid_finish_reason");
        state.finishReason = choice.finish_reason;
      }
      states.set(index, state);
    }
    onMetadata(metadata("incomplete"));
  });
  return new Response(response.body.pipeThrough(new TransformStream({
    transform(bytes, controller) {
      try { parser.push(bytes); } catch (error) {
        if (!error.protocolFailure) fail("invalid_sse");
        throw error;
      }
      controller.enqueue(bytes);
    },
    flush() {
      parser.finish();
      if (!done) fail([...states.values()].some(s => s.hasContent || s.hasToolCalls || s.hasReasoning || s.hasRefusal) ? "incomplete_stream" : "empty_stream");
    },
  })), { status: response.status, statusText: response.statusText, headers: response.headers });
}
