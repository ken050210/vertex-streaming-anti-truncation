import { prepareAntiTruncation, wrapAntiTruncationStream } from "./anti-truncation.mjs";
import { nativeRequestBody } from "./vertex-native.mjs";
import { wrapNativeTextStream } from "./vertex-text-stream.mjs";
import { guardCompletionStream } from "./completion-integrity.mjs";
import { capGemini4Output, outputLimitHeaders } from "./gemini4.mjs";
import { completedSillyTavernResponse, toSillyTavernStream } from "./sillytavern.mjs";
import { createSseParser, isObject, sseData, transformSse } from "./wire.mjs";
import { BODY_LIMIT } from "../integrations/sillytavern/shared.js";

// TauriTavern replaces SillyTavern's Node server with a Rust backend, so no
// server plugin can run there. The UI extension does the whole job in the
// WebView instead: TauriTavern still converts the prompt, keeps the credentials
// and calls Vertex, while its final body overrides (custom_include_body) carry
// the native tool fields. Its streaming route forwards Google's events
// unchanged, finish codes included, so both transport modes read that route.

// TauriTavern sends the user's own Additional Parameters as YAML/JSON text. Only
// an empty value or a JSON object can be merged here without a YAML parser.
function includedBody(value) {
  if (isObject(value)) return value;
  if (value == null || (typeof value === "string" && !value.trim())) return {};
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch { return null; }
}

export function prepareTauriTavernRequest(body, mode) {
  const included = includedBody(body.custom_include_body);
  if (!included) return { bypass: "additional-parameters" };
  // The upstream request is always streamGenerateContent here, and TauriTavern's backend
  // cannot follow long-decode continuation tokens.
  const { payload, outputLimit } = capGemini4Output(body, body.model, { stream: true });
  body = payload;
  const continuation = body.type === "continue";
  const upstreamStream = mode === "streaming" && body.stream === true;
  const prepared = prepareAntiTruncation({ messages: body.messages, tools: body.tools, tool_choice: body.tool_choice }, true, false, { continuation });
  const native = nativeRequestBody({ ...prepared.payload, messages: [] });
  if (upstreamStream) native.toolConfig.functionCallingConfig.streamFunctionCallArguments = true;
  return {
    body: { ...body, messages: prepared.payload.messages, stream: true,
      custom_include_body: JSON.stringify({ ...included, tools: native.tools, toolConfig: native.toolConfig }) },
    toolName: prepared.toolName, tools: prepared.payload.tools, model: body.model, stream: body.stream === true, upstreamStream, continuation, outputLimit,
  };
}

// TauriTavern reports a failed request as assistant text in exactly this chunk:
// {candidates:[{index, content:{parts:[{text}]}}]}, with none of Google's role,
// ids, usage or finishReason. Give it an ending so its text arrives as written
// instead of as an interrupted reply.
const only = (value, ...allowed) => isObject(value) && Object.keys(value).every(key => allowed.includes(key));
function endHostError(response) {
  return transformSse(response, ({ raw, data }, emit) => {
    let parsed;
    try { parsed = JSON.parse(data); } catch { return emit(raw + "\n\n"); }
    const candidate = only(parsed, "candidates") && parsed.candidates?.length === 1 ? parsed.candidates[0] : null;
    const part = only(candidate, "index", "content") && only(candidate.content, "parts") && candidate.content.parts?.length === 1 ? candidate.content.parts[0] : null;
    if (!only(part, "text") || typeof part.text !== "string") return emit(raw + "\n\n");
    emit(sseData({ candidates: [{ ...candidate, finishReason: "STOP" }] }));
  });
}

// Reads the restored chunks to their end. The integrity guard in front of this
// has already rejected an incomplete or malformed reply.
async function collectCompletion(response, model) {
  const message = { role: "assistant", content: "" };
  const choice = { index: 0, message, finish_reason: null };
  const completion = { object: "chat.completion", model, choices: [choice] };
  const parser = createSseParser(({ data }) => {
    if (!data || data.trim() === "[DONE]") return;
    const chunk = JSON.parse(data);
    completion.id ??= chunk.id;
    completion.created ??= chunk.created;
    for (const { delta, finish_reason, native_finish_reason } of chunk.choices ?? []) {
      if (delta?.content) message.content += delta.content;
      if (delta?.reasoning_content) message.reasoning_content = (message.reasoning_content ?? "") + delta.reasoning_content;
      // The native adapter emits client calls only after all arguments arrive.
      for (const { index, ...call } of delta?.tool_calls ?? []) (message.tool_calls ??= []).push(call);
      if (finish_reason != null) Object.assign(choice, { finish_reason, native_finish_reason });
    }
    if (chunk.usage) completion.usage = chunk.usage;
    if (chunk.router_anti_truncation) completion.router_anti_truncation = chunk.router_anti_truncation;
  });
  // Older WebKit cannot iterate a ReadableStream with for await.
  const reader = response.body.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) parser.push(read.value);
  parser.finish();
  return completion;
}

const failure = code => ({ error: { code, message: `Vertex 抗截断请求失败。 (${code})` } });

// A reply that fails restoration ends with the error event ST's stream reader
// reports, as the server plugin does. A cancelled request just stops.
function reportStreamFailure(body, signal) {
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        if (signal?.aborted) return controller.error(error);
        controller.enqueue(new TextEncoder().encode(sseData(failure(error.code ?? "restoration_failed"))));
        controller.close();
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

export async function restoreTauriTavernResponse(response, prepared, signal) {
  // A failed quiet request is TauriTavern's own JSON error; leave it as it is.
  if (!response.ok || !response.body) return response;
  let usageMetadata;
  const restored = guardCompletionStream(wrapAntiTruncationStream(wrapNativeTextStream(endHostError(response), prepared.toolName,
    prepared.model, usage => { usageMetadata = usage; }, true, prepared.tools), prepared.toolName, () => {}, prepared.tools), () => {}, null, BODY_LIMIT);
  const headers = { ...(prepared.continuation ? { "x-vertex-continuation": "suffix" } : {}), ...outputLimitHeaders(prepared.outputLimit) };
  if (prepared.upstreamStream) {
    return new Response(reportStreamFailure(toSillyTavernStream(restored, () => usageMetadata, prepared.model).body, signal),
      { headers: { ...headers, "content-type": "text/event-stream; charset=utf-8" } });
  }
  let delivered;
  try {
    delivered = completedSillyTavernResponse(await collectCompletion(restored, prepared.model), prepared, usageMetadata);
  } catch (error) {
    signal?.throwIfAborted();
    return new Response(JSON.stringify(failure(error.code ?? "restoration_failed")), { status: 502, headers: { "content-type": "application/json" } });
  }
  return new Response(delivered.body, { headers: { ...headers, "content-type": delivered.headers.get("content-type") } });
}
