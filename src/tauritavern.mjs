import { prepareAntiTruncation, wrapAntiTruncationStream } from "./anti-truncation.mjs";
import { nativeRequestBody } from "./vertex-native.mjs";
import { wrapNativeTextStream } from "./vertex-text-stream.mjs";
import { nativeSoliumbra } from "./soliumbra.mjs";
import { guardCompletionStream } from "./completion-integrity.mjs";
import { createTagStop } from "./tag-stop.mjs";
import { capGemini4Output, outputLimitHeaders } from "./gemini4.mjs";
import { completedSillyTavernResponse, toSillyTavernStream } from "./sillytavern.mjs";
import { createSseParser, googleErrorDetail, isObject, protocolError, sseData, transformSse, upstreamMessage } from "./wire.mjs";
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

export function prepareTauriTavernRequest(body, mode, tagStop, transportToolName, meowCompat = false) {
  const included = includedBody(body.custom_include_body);
  if (!included) return { bypass: "additional-parameters" };
  // The upstream request is always streamGenerateContent here, and TauriTavern's backend
  // cannot follow long-decode continuation tokens.
  const { payload, outputLimit } = capGemini4Output(body, body.model, { stream: true });
  body = payload;
  const continuation = body.type === "continue";
  const upstreamStream = mode === "streaming" && body.stream === true;
  const prepared = prepareAntiTruncation({ messages: body.messages, tools: body.tools, tool_choice: body.tool_choice, toolConfig: body.toolConfig }, true, false, { continuation, transportToolName, meowCompat });
  if (!prepared.toolName) return { bypass: prepared.reason };
  const native = nativeRequestBody({ ...prepared.payload, messages: [] }, { meowCompat });
  if (upstreamStream) native.toolConfig.functionCallingConfig.streamFunctionCallArguments = true;
  return {
    body: { ...body, messages: prepared.payload.messages, stream: true,
      custom_include_body: JSON.stringify({ ...included, tools: native.tools, toolConfig: native.toolConfig }) },
    toolName: prepared.toolName, schema: prepared.schema, meowCompat, meowAliases: prepared.meowAliases, tools: prepared.payload.tools, model: body.model, stream: body.stream === true, upstreamStream, continuation, outputLimit, tagStop,
  };
}

const only = (value, ...allowed) => isObject(value) && Object.keys(value).every(key => allowed.includes(key));
function tauriErrorText(text) {
  if (typeof text !== "string" || !text.startsWith("[")) return;
  if (text.startsWith("[API Error]")) return text;
  const label = globalThis.SillyTavern?.i18n?.translate?.("API Error", "API Error");
  if (label && text.startsWith(`[${label}]`)) return text;
}

// TT's buildErrorStreamChunk uses one text part with no Google metadata or finish reason.
function tauriErrorCandidate(parsed) {
  if (!only(parsed, "candidates") || parsed.candidates?.length !== 1) return;
  const candidate = parsed.candidates[0];
  if (!only(candidate, "index", "content") || candidate.index !== 0 ||
      !only(candidate.content, "parts") || candidate.content.parts?.length !== 1) return;
  const part = candidate.content.parts[0];
  if (only(part, "text") && tauriErrorText(part.text)) return candidate;
}

function tauriErrorStatus(text) {
  const diagnostic = text?.replace(/^\[[^\]\r\n]+\]\s*/, "");
  const match = /^(?:Too many requests:\s*)?(?:HTTP\s+|(?:Google )?Vertex AI endpoint failed with status\s+)([45]\d{2})\b/i.exec(diagnostic ?? "");
  return match ? Number(match[1]) : undefined;
}

function tauriErrorFrame(parsed, structuredReply) {
  const candidate = tauriErrorCandidate(parsed);
  if (!candidate) return;
  if (!structuredReply) return { candidates: [{ ...candidate, finishReason: "STOP" }] };
  // A synthetic STOP would make the preset validate a tool call that never
  // arrived. Some TT diagnostics name the HTTP status; others only have text.
  const message = candidate.content.parts[0].text;
  const status = tauriErrorStatus(message);
  throw Object.assign(protocolError("upstream_stream_error"), { status, upstreamBody: { error: { code: status, message } } });
}

function responseErrorStatus(data, stream) {
  if (stream) return tauriErrorStatus(tauriErrorCandidate(data)?.content.parts[0].text) ?? googleErrorDetail(data)?.code;
  if (data?.object === "chat.completion" && /^tauritavern-error-\d+$/.test(data.id) && data.choices?.length === 1)
    return tauriErrorStatus(tauriErrorText(data.choices[0]?.message?.content));
  if (data?.error === true || isObject(data?.error)) return tauriErrorStatus(data.error?.message ?? data.message);
}

// Inspect only the first SSE data event. A reply with any upstream content has
// already started, even if the anti-truncation adapter has yet to emit text.
async function inspectRegionalReply(response, signal) {
  const type = response.headers.get("content-type") ?? "";
  const stream = response.ok && type.includes("text/event-stream");
  if (response.status === 429 || !response.body || (!stream && !type.includes("json")))
    return { response, status: response.status };
  const reader = response.body.getReader(), chunks = [];
  const limit = 64 * 1024;
  let hasData = false, status, size = 0, ended = false, readError;
  const parser = stream && createSseParser(({ data }) => {
    if (!data?.trim()) return;
    hasData = true;
    status = responseErrorStatus(JSON.parse(data), true);
    return false;
  }, limit);
  const decoder = !stream && new TextDecoder();
  let json = "";
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    while (!hasData && size < limit) {
      const { done, value } = await reader.read();
      if (done) { ended = true; break; }
      chunks.push(value);
      size += value.byteLength;
      // Inspect only the prefix even if the host batches many frames together.
      const prefix = value.subarray(0, limit - size + value.byteLength);
      if (stream) {
        try { parser.push(prefix); } catch { break; }
      } else json += decoder.decode(prefix, { stream: true });
    }
    if (ended) {
      try {
        if (stream && !hasData) parser.finish();
        else if (!stream) status = responseErrorStatus(JSON.parse(json + decoder.decode()), false);
      } catch { /* Preserve malformed or oversized replies for the normal reader. */ }
    }
  } catch (error) { readError = error; }
  finally { signal?.removeEventListener("abort", abort); }
  if (signal?.aborted) abort();
  signal?.throwIfAborted();
  const body = new ReadableStream({
    async pull(controller) {
      if (chunks.length) return controller.enqueue(chunks.shift());
      if (readError) return controller.error(readError);
      if (ended) return controller.close();
      const chunk = await reader.read();
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return { response: new Response(body, response), status: status ?? response.status };
}

function waitForRegion(headers, signal) {
  const after = headers.get("retry-after") ?? "";
  const ms = /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now();
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, Math.min(2147483647, Math.max(1000, ms || 0)));
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function sendTauriTavernWithRegions(locations, send, signal) {
  const attempts = [];
  for (const location of locations) {
    const { response, status } = await inspectRegionalReply(await send(location), signal);
    attempts.push(`${location}=${status}`);
    if (status !== 429 || attempts.length === locations.length) return { response, status, regions: attempts.join(",") };
    void response.body?.cancel().catch(() => {});
    await waitForRegion(response.headers, signal);
  }
}

function normalizeTauriStream(response, normalizeError) {
  return transformSse(response, ({ raw, data }, emit) => {
    let parsed;
    try { parsed = JSON.parse(data); } catch { return emit(raw + "\n\n"); }
    const error = normalizeError(parsed);
    emit(error ? sseData(error) : raw + "\n\n");
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

function failure(error, upstreamError = googleErrorDetail(error.upstreamBody)) {
  const code = error.code ?? "restoration_failed";
  return { error: { code, message: upstreamMessage(upstreamError, `Vertex 抗截断请求失败。 (${code})`),
    ...(upstreamError ? { upstreamError } : {}) } };
}

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
        controller.enqueue(new TextEncoder().encode(sseData(failure(error))));
        controller.close();
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

export async function restoreTauriTavernResponse(response, prepared, signal) {
  return restoreBrowserStream(response, prepared, signal, true);
}

export async function restoreBrowserStream(response, prepared, signal, tauri = false) {
  // A failed quiet request is TauriTavern's own JSON error; leave it as it is.
  if (!response.ok || !response.body) return response;
  if (response.headers.get("content-type")?.includes("application/json")) {
    const data = await response.json();
    const detail = googleErrorDetail(data);
    const code = detail?.promptBlocked ? "google_prompt_blocked" : "unexpected_stream_response";
    return new Response(JSON.stringify(failure({ code }, detail)), { status: detail?.promptBlocked ? 400 : 502, headers: { "content-type": "application/json" } });
  }
  const rule = prepared.tagStop;
  const stop = rule && createTagStop(prepared.toolName, rule.tag, rule.count, rule.exemptTag);
  let usageMetadata, textSignature;
  const getReceipt = () => stop?.marker() ? stop.receipt() : undefined;
  const fields = prepared.schema && nativeSoliumbra(prepared.schema, stop, prepared);
  const normalizeError = tauri ? frame => tauriErrorFrame(frame, prepared.schema) : undefined;
  const native = stop ? stop.stream(response, prepared.waitForStopUsage, normalizeError, fields)
    : normalizeError ? normalizeTauriStream(response, normalizeError) : response;
  const translated = wrapNativeTextStream(native, fields ? null : prepared.toolName, prepared.model,
    usage => { usageMetadata = usage; }, true, prepared.tools, tauri ? undefined : signature => { textSignature = signature; }, stop ? undefined : fields);
  const restored = guardCompletionStream(wrapAntiTruncationStream(translated, prepared.toolName, () => {}, prepared.tools, undefined, fields?.hasReply), () => {}, null, BODY_LIMIT);
  const headers = { ...(prepared.continuation ? { "x-vertex-continuation": "suffix" } : {}), ...outputLimitHeaders(prepared.outputLimit) };
  if (prepared.upstreamStream) {
    return new Response(reportStreamFailure(toSillyTavernStream(restored, () => usageMetadata, prepared.model, stop?.marker, () => textSignature, getReceipt).body, signal),
      { headers: { ...headers, "content-type": "text/event-stream; charset=utf-8" } });
  }
  let delivered;
  try {
    const completion = await collectCompletion(restored, prepared.model);
    const stopAfter = stop?.marker();
    delivered = completedSillyTavernResponse(completion, prepared, usageMetadata, stopAfter, textSignature, getReceipt);
  } catch (error) {
    signal?.throwIfAborted();
    return new Response(JSON.stringify(failure(error)), { status: error.status ?? 502, headers: { "content-type": "application/json" } });
  }
  return new Response(delivered.body, { headers: { ...headers, "content-type": delivered.headers.get("content-type") } });
}
