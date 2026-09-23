import { assertStructuredOutput } from "./vertex-schema.mjs";
// Protocol validation retains bounded SSE events and fixed metadata, never reply text for logs.
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const reasons = new Set(["stop", "length", "content_filter", "tool_calls", "function_call"]);
const outcomes = new Set(["complete", "length", "content_filter", "tool_calls", "incomplete", "empty", "error", "cancelled"]);
export const protocolError = code => Object.assign(new Error(code), { code, protocolFailure: true });

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
    hasContent: contentPresent(message?.content) || object(message?.audio),
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
  if (!object(completion) || completion.error) return invalid("error_object");
  if (!Array.isArray(completion.choices) || !completion.choices.length) return invalid("missing_choices");
  const states = [];
  for (const choice of completion.choices) {
    if (!object(choice)) return invalid("invalid_choice");
    const state = { ...flags(object(choice.message) ? choice.message : null), finishReason: choice.finish_reason };
    if (choice.message == null) return invalid(object(choice.delta) ? "unexpected_stream_chunk" : "missing_message", state);
    if (!object(choice.message)) return invalid("invalid_message", state);
    const problem = choiceProblem(state);
    if (problem) return invalid(problem, state);
    if (state.hasToolCalls) {
      const calls = choice.message.tool_calls ?? [{ function: choice.message.function_call }];
      if (!Array.isArray(calls) || calls.some(call => !object(call?.function) || typeof call.function.name !== "string" ||
          !call.function.name || typeof call.function.arguments !== "string")) return invalid("invalid_tool_call", state);
      if (!["length", "content_filter"].includes(state.finishReason)) {
        try { if (calls.some(call => !object(JSON.parse(call.function.arguments)))) return invalid("invalid_tool_arguments", state); }
        catch { return invalid("invalid_tool_arguments", state); }
      }
    }
    states.push(state);
  }
  return { valid: true, reason: null, integrity: summary(states) };
}

// SSE framing is shared by native translation and transparent completion validation.
export function createSseParser(onEvent, maxChars = 2 * 1024 * 1024) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  const parse = raw => {
    const lines = raw.split(/\r\n|\r|\n/);
    const data = lines.filter(line => line === "data" || line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, "")).join("\n");
    const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
    if (data || event === "error") onEvent(data, event);
  };
  const drain = () => {
    let boundary;
    while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
      if (boundary.index > maxChars) throw protocolError("sse_event_limit");
      parse(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index + boundary[0].length);
    }
    if (buffer.length > maxChars) throw protocolError("sse_event_limit");
  };
  return {
    push(bytes) { buffer += decoder.decode(bytes, { stream: true }); drain(); },
    finish() { buffer += decoder.decode(); drain(); if (buffer.trim()) parse(buffer); buffer = ""; },
  };
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
  const parser = createSseParser((data, event) => {
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
          try { if (!object(JSON.parse(call.arguments))) fail("invalid_tool_arguments"); }
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
    if (!object(parsed) || parsed.error) fail("upstream_stream_error");
    if (parsed.choices != null && !Array.isArray(parsed.choices)) fail("invalid_stream_choices");
    for (const [position, choice] of (parsed.choices ?? []).entries()) {
      if (!object(choice)) fail("invalid_stream_choice");
      const index = choice.index ?? position;
      if (!Number.isInteger(index) || index < 0 || index >= 128) fail("invalid_choice_index");
      const state = states.get(index) ?? { ...flags({}), finishReason: null };
      const delta = choice.delta ?? choice.message ?? {};
      if (!object(delta)) fail("invalid_stream_delta");
      const incoming = flags(delta);
      const calls = delta.tool_calls ?? (delta.function_call ? [{ index: 0, function: delta.function_call }] : []);
      if (!Array.isArray(calls)) fail("invalid_tool_call");
      for (const [position, call] of calls.entries()) {
        const toolIndex = call?.index ?? position;
        if (!object(call) || !Number.isInteger(toolIndex) || toolIndex < 0 || toolIndex >= 128) fail("invalid_tool_call");
        const buffers = toolBuffers.get(index) ?? new Map();
        const buffered = buffers.get(toolIndex) ?? { name: "", arguments: "" };
        if (call.function != null && !object(call.function)) fail("invalid_tool_call");
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
