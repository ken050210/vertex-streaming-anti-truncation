import { prepareAntiTruncation, restoreAntiTruncationCompletion, wrapAntiTruncationStream } from "./anti-truncation.mjs";
import { nativeRequestBody } from "./vertex-native.mjs";
import { translateNativeCompletion } from "./vertex-protocol.mjs";
import { wrapNativeTextStream } from "./vertex-text-stream.mjs";
import { inspectCompletion, guardCompletionStream } from "./completion-integrity.mjs";
import { completionStream } from "./completion-stream.mjs";
import { documentedUnsupported } from "./unsupported-params.mjs";
import { protocolError, sseData, transformSse } from "./wire.mjs";
import { bypassReason } from "../integrations/sillytavern/shared.js";

export const BODY_LIMIT = 8 * 1024 * 1024;
export const requestError = code => Object.assign(new Error(code), { status: 400, code });

// Reuse ST's own prompt/name/media and thinking conversion. Nothing in the
// incoming request is mutated; actual tools and Schema never enter this path.
export function prepareSillyTavernRequest(request, adapters) {
  const body = request.body;
  if (!body || !Array.isArray(body.messages) || !body.messages.length || body.messages.some(message =>
    !message || !["system", "developer", "user", "assistant"].includes(message.role)) ||
    (body.stream != null && typeof body.stream !== "boolean")) throw requestError("invalid_request");
  if (Buffer.byteLength(JSON.stringify(body)) > BODY_LIMIT) throw Object.assign(requestError("request_too_large"), { status: 413 });
  const mode = body.vertex_anti_truncation;
  if (!["buffered", "streaming"].includes(mode)) throw requestError("invalid_transport_mode");
  const bypass = bypassReason(body, mode);
  if (bypass) throw requestError("unsupported_request_" + bypass.replaceAll("-", "_"));
  let messages = structuredClone(body.messages);
  // ST's Google converter only recognizes system/user/assistant roles. Keep
  // developer instructions at the same priority instead of sending an invalid
  // native `developer` role or letting prompt post-processing demote it.
  for (const message of messages) if (message.role === "developer") message.role = "system";
  if (body.custom_prompt_post_processing) {
    messages = adapters.postProcessPrompt(messages, body.custom_prompt_post_processing, adapters.getPromptNames(request));
  }
  const prepared = prepareAntiTruncation({ messages }, true);
  const useSystemPrompt = Boolean(body.use_sysprompt);
  const prompt = adapters.convertGooglePrompt(prepared.payload.messages, body.model, useSystemPrompt, adapters.getPromptNames(request));
  const native = nativeRequestBody({ ...prepared.payload, messages: [] });
  native.contents = prompt.contents;
  if (useSystemPrompt && prompt.system_instruction?.parts?.length) native.systemInstruction = prompt.system_instruction;
  native.safetySettings = structuredClone(adapters.safetySettings);
  const config = native.generationConfig;
  const unsupported = documentedUnsupported(body.model, body);
  const sampling = { max_tokens: "maxOutputTokens", temperature: "temperature", top_p: "topP", top_k: "topK", seed: "seed" };
  for (const [key, target] of Object.entries(sampling)) {
    if (body[key] == null || unsupported.has(key) || (key === "top_k" && !body[key])) continue;
    if (typeof body[key] !== "number" || !Number.isFinite(body[key])) throw requestError("invalid_" + key);
    config[target] = body[key];
  }
  if (body.stop != null && (!Array.isArray(body.stop) || body.stop.some(value => typeof value !== "string"))) throw requestError("invalid_stop");
  if (body.stop?.length) config.stopSequences = [...body.stop];
  if (/^gemini-(2\.5|3[.\d]*)-(flash|pro)/.test(body.model)) {
    const budget = adapters.calculateGoogleBudgetTokens(body.max_tokens, String(body.reasoning_effort), body.model);
    config.thinkingConfig = { includeThoughts: Boolean(body.include_reasoning) && budget !== 0 };
    if (Number.isInteger(budget)) config.thinkingConfig.thinkingBudget = budget;
    else if (typeof budget === "string" && budget) config.thinkingConfig.thinkingLevel = budget;
  }
  const upstreamStream = mode === "streaming" && body.stream === true;
  if (upstreamStream) native.toolConfig.functionCallingConfig.streamFunctionCallArguments = true;
  return { body: native, toolName: prepared.toolName, model: body.model, stream: body.stream === true, upstreamStream, mode };
}

const finishReasons = { stop: "STOP", length: "MAX_TOKENS", content_filter: "SAFETY" };
function nativeUsage(usage) {
  return usage ? {
    promptTokenCount: usage.prompt_tokens, candidatesTokenCount: usage.completion_tokens,
    totalTokenCount: usage.total_tokens, cachedContentTokenCount: usage.prompt_tokens_details?.cached_tokens,
    trafficType: usage.traffic_type,
  } : undefined;
}

// Vertex's ST streaming reader expects native candidates[].content.parts, while
// its non-streaming reader expects choices[] plus responseContent. Match both.
export function toSillyTavernStream(response, getNativeUsage = () => undefined) {
  return transformSse(response, ({ data }, emit) => {
    if (!data) return;
    if (data.trim() === "[DONE]") return emit(sseData("[DONE]"));
    const parsed = JSON.parse(data);
    if (parsed.error) return emit(sseData(parsed));
    const output = { candidates: [] };
    for (const choice of parsed.choices ?? []) {
      const delta = choice.delta ?? {};
      if (delta.tool_calls?.length) throw protocolError("unexpected_restored_tool");
      const parts = [];
      if (delta.reasoning_content) parts.push({ thought: true, text: delta.reasoning_content });
      if (delta.content) parts.push({ text: delta.content });
      const candidate = { index: choice.index ?? 0, content: { role: "model", parts } };
      if (choice.finish_reason != null) candidate.finishReason = choice.native_finish_reason ?? finishReasons[choice.finish_reason] ?? "OTHER";
      output.candidates.push(candidate);
    }
    if (parsed.usage) { output.usage = parsed.usage; output.usageMetadata = getNativeUsage() ?? nativeUsage(parsed.usage); }
    if (parsed.router_anti_truncation) output.vertexAntiTruncation = parsed.router_anti_truncation;
    emit(sseData(output));
  });
}

async function readJson(response) {
  const chunks = [];
  let size = 0;
  for await (const bytes of response.body ?? []) {
    size += bytes.length;
    if (size > BODY_LIMIT) throw protocolError("upstream_body_limit");
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw protocolError("invalid_upstream_json"); }
}

export async function restoreSillyTavernResponse(upstream, prepared) {
  if (!upstream.ok) {
    await upstream.body?.cancel();
    throw Object.assign(new Error("vertex_upstream_http_error"), { status: upstream.status, code: "vertex_upstream_http_error" });
  }
  if (prepared.upstreamStream) {
    if (!upstream.body) throw protocolError("empty_upstream_stream");
    let usageMetadata;
    const translated = wrapNativeTextStream(upstream, prepared.toolName, prepared.model, usage => { usageMetadata = usage; });
    const restored = wrapAntiTruncationStream(translated, prepared.toolName);
    return toSillyTavernStream(guardCompletionStream(restored, () => {}, null, BODY_LIMIT), () => usageMetadata);
  }
  const raw = await readJson(upstream);
  if (raw.candidates?.length > 1) throw protocolError("unexpected_candidates");
  const translated = translateNativeCompletion(raw, prepared.model);
  const inspected = inspectCompletion(translated);
  if (!inspected.valid) throw protocolError(inspected.reason);
  const completion = restoreAntiTruncationCompletion(translated, prepared.toolName);
  const restored = inspectCompletion(completion);
  if (!restored.valid) throw protocolError(restored.reason);
  const message = completion.choices[0].message;
  if (message.tool_calls?.length) throw protocolError("unexpected_restored_tool");
  if (prepared.stream) return toSillyTavernStream(guardCompletionStream(completionStream(completion, true), () => {}, null, BODY_LIMIT), () => raw.usageMetadata);
  const parts = [];
  if (message.reasoning_content) parts.push({ thought: true, text: message.reasoning_content });
  if (message.content) parts.push({ text: message.content });
  return Response.json({ ...completion, responseContent: { role: "model", parts }, usageMetadata: raw.usageMetadata,
    vertexAntiTruncation: completion.router_anti_truncation });
}
