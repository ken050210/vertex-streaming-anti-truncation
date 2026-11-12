import { CONTINUATION_INSTRUCTION, prepareAntiTruncation, restoreAntiTruncationCompletion, wrapAntiTruncationStream } from "./anti-truncation.mjs";
import { SIGNATURE_ID_PREFIX, nativeRequestBody, translateUsage } from "./vertex-native.mjs";
import { translateNativeCompletion } from "./vertex-protocol.mjs";
import { wrapNativeTextStream } from "./vertex-text-stream.mjs";
import { inspectCompletion, guardCompletionStream } from "./completion-integrity.mjs";
import { completionStream } from "./completion-stream.mjs";
import { documentedUnsupported } from "./unsupported-params.mjs";
import { isObject, protocolError, readUpstreamError, sseData, transformSse } from "./wire.mjs";
import { bypassReason, BODY_LIMIT } from "../integrations/sillytavern/shared.js";
import { isGemini4Argon, gemini4OutputLimit, minimumThinkingLevel, geminiThinkingLevel, gemini4ToolMetadata } from "./gemini4.mjs";
import { createTagStop, hasUsageTotals } from "./tag-stop.mjs";
import { normalizeStopUsageWait, validateTagStopRule } from "./tag-stop-rule.mjs";

export const requestError = code => Object.assign(new Error(code), { status: 400, code });

// Reuse ST's own prompt/name/media/tool-history and thinking conversion. Nothing in
// the incoming request is mutated; client tools ride next to the transport tool, and
// Schema output never enters this path.
export function prepareSillyTavernRequest(request, adapters) {
  const body = request.body;
  if (!body || !Array.isArray(body.messages) || !body.messages.length || body.messages.some(message =>
    !message || !["system", "developer", "user", "assistant", "tool"].includes(message.role)) ||
    (body.stream != null && typeof body.stream !== "boolean")) throw requestError("invalid_request");
  if (Buffer.byteLength(JSON.stringify(body)) > BODY_LIMIT) throw Object.assign(requestError("request_too_large"), { status: 413 });
  const mode = body.vertex_anti_truncation;
  const imageEnabled = ["current-turn", "all"].includes(body.vertex_image_input);
  if (body.vertex_image_input != null && !["off", "current-turn", "all"].includes(body.vertex_image_input)) throw requestError("invalid_image_input_mode");
  if (!["buffered", "streaming"].includes(mode) && !(mode === "off" && imageEnabled)) throw requestError("invalid_transport_mode");
  const bypass = bypassReason(body, mode === "off" && imageEnabled ? "buffered" : mode, false,
    mode === "off" ? "" : body.vertex_transport_tool_name);
  if (bypass && !bypass.startsWith("target-tool-")) throw requestError("unsupported_request_" + bypass.replaceAll("-", "_"));
  let messages = structuredClone(body.messages);
  // ST's Google converter only recognizes system/user/assistant roles. Keep
  // developer instructions at the same priority instead of sending an invalid
  // native `developer` role or letting prompt post-processing demote it.
  for (const message of messages) if (message.role === "developer") message.role = "system";
  if (body.custom_prompt_post_processing) {
    messages = adapters.postProcessPrompt(messages, body.custom_prompt_post_processing, adapters.getPromptNames(request));
  }
  // ST identifies Continue explicitly, with either a final assistant prefill or
  // its own continuation nudge. Do not infer it from an assistant-role preset.
  // Add this after prompt processing and image conversion so the instruction
  // stays readable and the existing message remains unchanged in its context.
  const continuation = body.type === "continue";
  const clientTools = Boolean(body.tools?.length);
  const prepared = prepareAntiTruncation({ messages, tools: body.tools, tool_choice: body.tool_choice }, mode !== "off", false,
    { continuation, transportToolName: body.vertex_transport_tool_name });
  if (continuation && !prepared.toolName) {
    prepared.payload = { ...prepared.payload, messages: [...messages, { role: "user", content: CONTINUATION_INSTRUCTION }] };
  }
  const useSystemPrompt = Boolean(body.use_sysprompt);
  const prompt = adapters.convertGooglePrompt(prepared.payload.messages, body.model, useSystemPrompt, adapters.getPromptNames(request));
  // ST's converter merges the closing instruction into the tool-result turn, which Vertex rejects
  // ("Requests ending with a model turn are not supported"); give what follows the results its own turn.
  const last = prompt.contents.at(-1);
  const results = last?.parts.findLastIndex(part => part.functionResponse) ?? -1;
  if (results >= 0 && results < last.parts.length - 1) prompt.contents.push({ role: last.role, parts: last.parts.splice(results + 1) });
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
  const minimum = minimumThinkingLevel(body.model);
  if (minimum) {
    const level = geminiThinkingLevel(body.reasoning_effort, minimum) ?? (isGemini4Argon(body.model) ? "MEDIUM" : undefined);
    config.thinkingConfig = { includeThoughts: Boolean(body.include_reasoning) };
    if (level) config.thinkingConfig.thinkingLevel = level;
  } else if (/^gemini-(2\.5|3[.\d]*)-(flash|pro)/.test(body.model)) {
    const budget = adapters.calculateGoogleBudgetTokens(body.max_tokens, String(body.reasoning_effort), body.model);
    config.thinkingConfig = { includeThoughts: Boolean(body.include_reasoning) && budget !== 0 };
    if (Number.isInteger(budget)) config.thinkingConfig.thinkingBudget = budget;
    else if (typeof budget === "string" && budget) config.thinkingConfig.thinkingLevel = budget;
  }
  const upstreamStream = mode === "streaming" && body.stream === true;
  const outputLimit = gemini4OutputLimit(config.maxOutputTokens, body.model, { stream: upstreamStream, longDecode: body.vertex_long_decode === true });
  if (outputLimit) config.maxOutputTokens = outputLimit.applied;
  if (upstreamStream && native.toolConfig) native.toolConfig.functionCallingConfig.streamFunctionCallArguments = true;
  if (body.vertex_tucao_stop != null && typeof body.vertex_tucao_stop !== "boolean") throw requestError("invalid_tucao_stop");
  const tagStop = body.vertex_tag_stop == null ? null : validateTagStopRule(body.vertex_tag_stop);
  return { body: native, toolName: prepared.toolName, model: body.model, stream: body.stream === true, upstreamStream, mode, continuation, clientTools, tools: prepared.payload.tools, outputLimit,
    waitForStopUsage: !outputLimit?.longDecode && normalizeStopUsageWait(body.vertex_wait_for_stop_usage),
    tucaoStop: tagStop !== null || body.vertex_tucao_stop === true, stopTag: tagStop?.tag, stopCount: tagStop?.count };
}

const finishReasons = { stop: "STOP", length: "MAX_TOKENS", content_filter: "SAFETY", tool_calls: "STOP" };
// ST's Google reader takes each functionCall part as one whole call and keeps the
// thought signature beside it; Gemini 4 also needs its native call ID back.
function functionCallPart(call, model) {
  let args;
  try { args = JSON.parse(call.function?.arguments); } catch {}
  if (!isObject(args) || typeof call.function?.name !== "string") throw protocolError("invalid_restored_tool");
  const part = { functionCall: { name: call.function.name, args } };
  if (isGemini4Argon(model)) {
    const { id, signature } = gemini4ToolMetadata(call.id);
    part.functionCall.id = id;
    if (signature) part.thoughtSignature = signature;
  } else if (typeof call.id === "string" && call.id.startsWith(SIGNATURE_ID_PREFIX)) {
    part.thoughtSignature = call.id.slice(SIGNATURE_ID_PREFIX.length);
  }
  return part;
}
function nativeUsage(usage) {
  return usage ? {
    promptTokenCount: usage.prompt_tokens, candidatesTokenCount: usage.completion_tokens,
    totalTokenCount: usage.total_tokens, cachedContentTokenCount: usage.prompt_tokens_details?.cached_tokens,
    trafficType: usage.traffic_type,
  } : undefined;
}

// Legacy observers read the normal usage fields. Give them provider-confirmed
// totals only; the receipt carries partial observations and local estimates.
export function receiptFields(receipt, estimateText, visibleText) {
  if (!receipt) return {};
  if (!receipt.final && estimateText) receipt.estimate = estimateText(visibleText);
  const fields = { vertexUsageReceipt: receipt };
  if (receipt.final) {
    const native = receipt.usageMetadata;
    fields.usageMetadata = native;
    if (Number.isSafeInteger(native.candidatesTokenCount)) fields.usage = translateUsage(native);
  }
  return fields;
}

// Vertex's ST streaming reader expects native candidates[].content.parts, while
// its non-streaming reader expects choices[] plus responseContent. Match both.
export function toSillyTavernStream(response, getNativeUsage = () => undefined, model, getStopAfter = () => undefined, getTextSignature, getReceipt, estimateText) {
  let visibleText = "";
  return transformSse(response, ({ data }, emit) => {
    if (!data) return;
    if (data.trim() === "[DONE]") {
      const receipt = getReceipt?.();
      if (receipt) emit(sseData({ candidates: [], ...receiptFields(receipt, estimateText, visibleText) }));
      return emit(sseData("[DONE]"));
    }
    const parsed = JSON.parse(data);
    if (parsed.error) return emit(sseData(parsed));
    const output = { candidates: [] };
    for (const choice of parsed.choices ?? []) {
      const delta = choice.delta ?? {};
      // ST's stream reader ignores the text of an event that carries a function call.
      if (delta.tool_calls?.length) emit(sseData({ candidates: [{ index: choice.index ?? 0,
        content: { role: "model", parts: delta.tool_calls.map(call => functionCallPart(call, model)) } }] }));
      const parts = [];
      if (delta.reasoning_content) parts.push({ thought: true, text: delta.reasoning_content });
      if (delta.content) {
        parts.push({ text: delta.content });
        if (estimateText) visibleText += delta.content;
      }
      const candidate = { index: choice.index ?? 0, content: { role: "model", parts } };
      if (choice.finish_reason != null) {
        candidate.finishReason = choice.native_finish_reason ?? finishReasons[choice.finish_reason] ?? "OTHER";
        const signature = !parsed.router_anti_truncation?.restored && !getStopAfter() && getTextSignature?.();
        if (signature) parts.push({ text: "", thoughtSignature: signature });
      }
      output.candidates.push(candidate);
    }
    if (parsed.usage && !getStopAfter()) {
      output.usageMetadata = getNativeUsage() ?? nativeUsage(parsed.usage);
      if (hasUsageTotals(output.usageMetadata)) output.usage = parsed.usage;
    }
    if (parsed.router_anti_truncation) output.vertexAntiTruncation = parsed.router_anti_truncation;
    if (getStopAfter()) output.vertexStopAfter = getStopAfter();
    emit(sseData(output));
  });
}

// A checked, complete reply in the shape ST asked for. Also used in a WebView,
// where older WebKit has no Response.json.
export function completedSillyTavernResponse(completion, prepared, usageMetadata, stopAfter, textSignature, getReceipt, estimateText) {
  const message = completion.choices[0].message;
  if (prepared.stream) return toSillyTavernStream(guardCompletionStream(completionStream(completion, true), () => {}, null, BODY_LIMIT), () => usageMetadata, prepared.model, () => stopAfter, () => textSignature, getReceipt, estimateText);
  const parts = [];
  if (message.reasoning_content) parts.push({ thought: true, text: message.reasoning_content });
  if (message.content) parts.push({ text: message.content });
  if (textSignature && !completion.router_anti_truncation?.restored && !stopAfter) parts.push({text:"",thoughtSignature:textSignature});
  for (const call of message.tool_calls ?? []) parts.push(functionCallPart(call, prepared.model));
  const receipt = getReceipt?.();
  return new Response(JSON.stringify({ ...completion, usage: receipt ? undefined : completion.usage,
    usageMetadata: stopAfter && receipt ? undefined : usageMetadata, responseContent: { role: "model", parts },
    ...receiptFields(receipt, estimateText, message.content || ""), vertexAntiTruncation: completion.router_anti_truncation, ...(stopAfter ? { vertexStopAfter: stopAfter } : {}) }), { headers: { "content-type": "application/json" } });
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

export async function restoreSillyTavernResponse(upstream, prepared, credential, estimateUsage) {
  if (!upstream.ok) {
    throw Object.assign(protocolError("vertex_upstream_http_error"), {
      status: upstream.status, upstreamError: await readUpstreamError(upstream, credential)
    });
  }
  const stop = prepared.toolName && prepared.tucaoStop ? createTagStop(prepared.toolName, prepared.stopTag, prepared.stopCount) : null;
  let usageMetadata;
  const getReceipt = () => {
    if (stop?.marker()) return stop.receipt();
    if (!hasUsageTotals(usageMetadata) && (usageMetadata || estimateUsage)) return { final: false, usageMetadata };
  };
  const estimateText = estimateUsage && (text => estimateUsage(prepared.body, text));
  if (prepared.upstreamStream && !upstream.headers.get("content-type")?.includes("application/json")) {
    if (!upstream.body) throw protocolError("empty_upstream_stream");
    if (stop) upstream = stop.stream(upstream, prepared.waitForStopUsage);
    const translated = wrapNativeTextStream(upstream, prepared.toolName, prepared.model,
      usage => { usageMetadata = usage; }, true, prepared.tools);
    const restored = wrapAntiTruncationStream(translated, prepared.toolName, () => {}, prepared.tools);
    return toSillyTavernStream(guardCompletionStream(restored, () => {}, null, BODY_LIMIT), () => usageMetadata, prepared.model, () => stop?.marker(), undefined, getReceipt, estimateText);
  }
  const raw = await readJson(upstream);
  usageMetadata = raw.usageMetadata;
  stop?.process(raw, true);
  if (raw.candidates?.length > 1) throw protocolError("unexpected_candidates");
  const translated = translateNativeCompletion(raw, prepared.model);
  const inspected = inspectCompletion(translated);
  if (!inspected.valid) throw protocolError(inspected.reason);
  const completion = prepared.toolName ? restoreAntiTruncationCompletion(translated, prepared.toolName) : translated;
  const restored = inspectCompletion(completion);
  if (!restored.valid) throw protocolError(restored.reason);
  return completedSillyTavernResponse(completion, prepared, usageMetadata, stop?.marker(), undefined, getReceipt, estimateText);
}
