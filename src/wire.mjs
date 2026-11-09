// Wire-format helpers shared by the request translators, stream readers and
// stream rewriters.
export const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
export const protocolError = code => Object.assign(new Error(code), { code, protocolFailure: true });
// Translated native usage and the compatible endpoint report the served tier in different places.
export const trafficType = usage => usage?.traffic_type ?? usage?.extra_properties?.google?.traffic_type;
export const sseData = value => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
// Provider codes such as PERMISSION_DENIED or MALFORMED_FUNCTION_CALL; anything else is dropped.
export const enumToken = value => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : null;

const redactions = [
  [/<[^>]*>/g, " "],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]"],
  [/\b(?:Bearer\s+)?(?:ya29\.|AIza)[\w.-]{16,}/g, "[key]"],
  [/[\w+=-]{40,}/g, "[token]"],
];
function diagnosticText(value, secret) {
  let message = typeof value === "string" ? value : "";
  if (secret) message = message.split(secret).join("[key]");
  for (const [pattern, replacement] of redactions) message = message.replace(pattern, replacement);
  message = message.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  return message.length > 4096 ? message.slice(0, 4095).replace(/[\ud800-\udbff]$/, "") + "…" : message;
}

// Only the provider's diagnostic fields go to the client. Logs never receive its message.
export function googleErrorDetail(body, secret) {
  const root = Array.isArray(body) ? body[0] : body;
  const feedback = root?.promptFeedback;
  if (!root?.candidates?.length && (feedback?.blockReason || feedback?.blockReasonMessage)) {
    const blocked = Array.isArray(feedback.safetyRatings) ? feedback.safetyRatings
      .filter(rating => rating?.blocked === true).map(rating => enumToken(rating.category)).filter(Boolean) : [];
    return { status: null, reason: enumToken(feedback.blockReason), message: diagnosticText(feedback.blockReasonMessage, secret) || null,
      promptBlocked: true, ...(blocked.length ? { blockedCategories: blocked } : {}) };
  }
  const error = root?.error;
  if (!isObject(error) && typeof error !== "string") return null;
  const info = Array.isArray(error.details) ? error.details.find(item => item?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo") : null;
  const code = Number.isInteger(error.code) && error.code >= 400 && error.code <= 599 ? error.code : null;
  const detail = { status: enumToken(error.status), reason: enumToken(info?.reason ?? error.details?.reason ?? error.code),
    message: diagnosticText(typeof error === "string" ? error : error.message, secret) || null, ...(code ? { code } : {}) };
  return code || detail.status || detail.reason || detail.message ? detail : null;
}

export function upstreamMessage(detail, fallback) {
  if (!detail) return fallback;
  return [detail.promptBlocked && "Google 拒绝了输入", detail.code && `上游代码 ${detail.code}`, detail.status, detail.reason, ...(detail.blockedCategories ?? []), detail.message]
    .filter(Boolean).join(" · ") || fallback;
}

export function checkSseError(event, data, code) {
  if (event !== "error") return;
  let body;
  try { body = JSON.parse(data); } catch { body = data; }
  const root = Array.isArray(body) ? body[0] : body;
  throw Object.assign(protocolError(code), { upstreamBody: root?.error || root?.promptFeedback ? root : { error: root } });
}

export function checkPromptFeedback(body) {
  const feedback = body?.promptFeedback;
  if (!body?.candidates?.length && (feedback?.blockReason || feedback?.blockReasonMessage)) {
    throw Object.assign(protocolError("google_prompt_blocked"), { status: 400, upstreamBody: body });
  }
}

// Google's OpenAI-compatible API can return a refusal instead of an error
// envelope. Only inspect this protocol field, never ordinary assistant text.
export function checkCompatibleRejection(body) {
  checkPromptFeedback(body);
  if (!Array.isArray(body?.choices)) return;
  for (const choice of body.choices) {
    const message = choice?.delta ?? choice?.message;
    if (!message?.content && typeof message?.refusal === "string" && message.refusal.trim()) {
      throw Object.assign(protocolError("upstream_refusal"), { status: 400, upstreamBody: { error: { message: message.refusal } } });
    }
  }
}

// The HTTP status survives a stalled, malformed or oversized error body.
export async function readUpstreamError(response, credential) {
  const limit = 16 * 1024;
  const reader = response.body?.getReader();
  if (!reader) return null;
  let text = "", size = 0, ended = false;
  const decoder = new TextDecoder();
  const timer = setTimeout(() => reader.cancel().catch(() => {}), 5000);
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) { ended = true; break; }
      text += decoder.decode(value.subarray(0, limit - size), { stream: true });
      size += value.byteLength;
    }
    text += decoder.decode();
  } catch { return null; } finally { clearTimeout(timer); reader.cancel().catch(() => {}); }
  try {
    const body = JSON.parse(text);
    return googleErrorDetail(body, credential) ?? (typeof body?.message === "string" ? googleErrorDetail({ error: body }, credential) : null);
  }
  catch {
    return ended && /^text\/plain\b/i.test(response.headers.get("content-type") ?? "") && !/^\s*[<{\[]/.test(text)
      ? googleErrorDetail({ error: text }, credential) : null;
  }
}
// Logs and events keep only the two codes, never the message.
export function upstreamErrorLogFields(value) {
  const status = enumToken(value?.status), reason = enumToken(value?.reason);
  return status || reason ? { upstreamError: { status, reason } } : {};
}

// Splits an SSE body into events. onEvent receives every event, comment-only ones
// included, as { raw, lines, data, event }; data joins the event's data lines.
// Returning false stops parsing, including any later events in the same chunk.
export function createSseParser(onEvent, maxChars = 2 * 1024 * 1024) {
  const decoder = new TextDecoder();
  let buffer = "", stopped = false;
  const parse = raw => {
    const lines = raw.split(/\r\n|\r|\n/);
    const data = lines.filter(line => line === "data" || line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, "")).join("\n");
    const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
    return onEvent({ raw, lines, data, event });
  };
  const drain = (final = false) => {
    let boundary;
    // Each line may end with CRLF, CR or LF, including mixed line endings.
    // Never split a CRLF into two lines, even across incoming byte chunks.
    while ((boundary = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/.exec(buffer))) {
      if (!final && boundary[0].endsWith("\r") && boundary.index + boundary[0].length === buffer.length) break;
      if (boundary.index > maxChars) throw protocolError("sse_event_limit");
      if (parse(buffer.slice(0, boundary.index)) === false) { stopped = true; buffer = ""; return; }
      buffer = buffer.slice(boundary.index + boundary[0].length);
    }
    if (buffer.length > maxChars) throw protocolError("sse_event_limit");
  };
  return {
    push(bytes) { if (!stopped) { buffer += decoder.decode(bytes, { stream: true }); drain(); } },
    finish() { if (!stopped) { buffer += decoder.decode(); drain(true); if (buffer.trim()) parse(buffer); buffer = ""; } },
  };
}

// Rewrites an SSE response event by event. onEvent and onEnd write output with
// emit; anything they throw fails the stream. Returning false closes the output
// and cancels upstream, without parsing later events already in the same chunk.
export function transformSse(response, onEvent, onEnd = () => {}) {
  const encoder = new TextEncoder();
  let controller, stopped = false;
  const emit = text => controller.enqueue(encoder.encode(text));
  const parser = createSseParser(event => {
    if (onEvent(event, emit) === false) { stopped = true; return false; }
  });
  const body = response.body.pipeThrough(new TransformStream({
    transform(bytes, current) { controller = current; parser.push(bytes); if (stopped) current.terminate(); },
    flush(current) { controller = current; parser.finish(); if (!stopped) onEnd(emit); },
  }));
  return new Response(body, { status: response.status, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}
