import { createSseParser } from "./completion-integrity.mjs";

export const MAX_RETRY_TEXT_BYTES = 192_000;
export const DEFAULT_RETRY_ERROR_MATCHES = ["The prompt could not be submitted"];
const INSPECTION_BYTES = 64 * 1024;
const geminiModel = model => /(?:^|\/)gemini-[a-z0-9._-]+(?:@[a-z0-9-]+)?$/i.test(model || "");

// Only plain text prefills can change roles without corrupting tool/thought history.
export function convertGeminiPrefill(payload, upstreamModel, enabled) {
  const last = payload.messages?.at(-1);
  const textOnly = typeof last?.content === "string" ? last.content.trim().length > 0 :
    Array.isArray(last?.content) && last.content.length > 0 &&
    last.content.every(part => part?.type === "text" && typeof part.text === "string") &&
    last.content.some(part => part.text.trim());
  if (!enabled || !/(?:^|\/)gemini-3\.[78]-flash(?:-preview(?:-[\d-]+)?)?(?:@[a-z0-9-]+)?$/i.test(upstreamModel || "") ||
      last?.role !== "assistant" || !textOnly ||
      Object.keys(last).some(key => !["role", "content", "name"].includes(key))) {
    return { payload, converted: false };
  }
  return { payload: { ...payload, messages: [...payload.messages.slice(0, -1), { ...last, role: "user" }] }, converted: true };
}

export function prependRetryText(payload, text) {
  const messages = payload.messages;
  let index = 0;
  while (["system", "developer"].includes(messages[index]?.role)) index += 1;
  return { ...payload, messages: [...messages.slice(0, index), { role: "user", content: text }, ...messages.slice(index)] };
}

export function compatibilityLogFields(value) {
  if (!value) return {};
  return { geminiCompatibility: { prefillConverted: value.prefillConverted === true, promptRetried: value.promptRetried === true } };
}

// Only provider rejection fields are matched: error envelopes, OpenAI-compatible
// refusals (Vertex streams its prompt block as delta.refusal) and native prompt
// blocks. Generated content never is. Returns the error body and matched rule.
function submissionError(value, matches, allowMessage = false) {
  const root = Array.isArray(value) ? value[0] : value;
  const error = root?.error ?? (allowMessage ? root : null);
  const found = [[typeof error === "string" ? error : error?.message, typeof error === "string" ? { message: error } : error]];
  for (const choice of Array.isArray(root?.choices) ? root.choices : []) {
    const refusal = (choice?.delta ?? choice?.message)?.refusal;
    found.push([refusal, { message: refusal }]);
  }
  const feedback = root?.promptFeedback;
  if (feedback?.blockReason && !root.candidates?.length) {
    const text = [feedback.blockReason, feedback.blockReasonMessage].filter(Boolean).join(": ");
    found.push([text, { message: text }]);
  }
  for (const [text, body] of found) {
    const rule = typeof text === "string" && matches.find(match => text.toLowerCase().includes(match.toLowerCase()));
    if (rule) return { error: body, rule };
  }
  return null;
}

function replay(response, held, reader, ended) {
  return new Response(new ReadableStream({
    async pull(controller) {
      if (held.length) { controller.enqueue(held.shift()); return; }
      if (ended) { controller.close(); return; }
      const { value, done } = await reader.read();
      if (done) controller.close(); else controller.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); },
  }), { status: response.status, statusText: response.statusText, headers: response.headers });
}

// Inspect only a bounded initial prefix. Stop at the first real stream delta,
// then replay exact bytes; never collect an entire story or scan generated text.
async function inspectSubmissionError(response, stream, matches) {
  if (!response.body) return { response, failure: false };
  const sse = response.ok && stream && /text\/event-stream/i.test(response.headers.get("content-type") || "");
  const reader = response.body.getReader();
  const held = [];
  let bytes = 0, ended = false, decided = false, failure = null;
  const parser = sse && createSseParser((data, event) => {
    if (decided) return;
    let parsed;
    try { parsed = JSON.parse(data); } catch {
      if (event === "error") failure = submissionError(data, matches, true);
      decided = Boolean(data || event === "error");
      return;
    }
    failure = submissionError(parsed, matches, event === "error");
    if (failure) { decided = true; return; }
    // Only known empty/role-only OpenAI chunks and empty native metadata can wait.
    const roleOnly = Array.isArray(parsed?.choices) && parsed.choices.every(choice =>
      !choice.finish_reason && choice.delta && Object.entries(choice.delta).every(([key, value]) =>
        key === "role" || (key === "content" && (value === "" || value === null))));
    const nativeMetadata = parsed && !parsed.error && Array.isArray(parsed.candidates) && parsed.candidates.length === 0;
    decided = event === "error" || (!roleOnly && !nativeMetadata);
  }, INSPECTION_BYTES);
  try {
    while (bytes < INSPECTION_BYTES && !decided) {
      const next = await reader.read();
      if (next.done) { ended = true; if (sse) parser.finish(); break; }
      held.push(next.value);
      bytes += next.value.byteLength;
      if (sse) {
        try { parser.push(next.value); } catch { decided = true; }
      }
    }
    if (!sse && ended) {
      const text = Buffer.concat(held).toString("utf8");
      try { failure = submissionError(JSON.parse(text), matches, !response.ok); }
      catch { if (!response.ok) failure = submissionError(text, matches, true); }
    }
    if (failure && response.ok) {
      await reader.cancel();
      // Matched HTTP-200 error envelopes, refusals and prompt blocks become errors,
      // never successful content, so the client sees the rejection message.
      const errorResponse = new Response(JSON.stringify({ error: failure.error }), {
        status: 400, headers: { "content-type": "application/json; charset=utf-8" },
      });
      errorResponse.routerPromptSubmissionError = failure.rule;
      return { response: errorResponse, failure: true };
    }
    const forwarded = replay(response, held, reader, ended);
    if (failure) forwarded.routerPromptSubmissionError = failure.rule;
    return { response: forwarded, failure: Boolean(failure) };
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
}

export async function fetchWithGeminiRecovery(send, payload, upstreamModel, options = {}) {
  const { settings, state = { used: false }, signal, onRetry = () => {}, bodyLimit = Infinity } = options;
  if (!settings?.enabled || !settings.text?.trim() || !geminiModel(upstreamModel)) return send(payload);
  const matches = (settings.errorMatches ?? DEFAULT_RETRY_ERROR_MATCHES).map(text => text.trim()).filter(Boolean);
  let result = await inspectSubmissionError(await send(payload), payload.stream === true, matches);
  if (!result.failure || state.used || signal?.aborted) return result.response;
  const retryPayload = prependRetryText(payload, settings.text);
  if (Buffer.byteLength(JSON.stringify(retryPayload)) > bodyLimit) return result.response;
  await result.response.body?.cancel();
  signal?.throwIfAborted();
  state.used = true; // One extra submission for the entire client request, across routes.
  onRetry();
  result = await inspectSubmissionError(await send(retryPayload), payload.stream === true, matches);
  return result.response;
}
