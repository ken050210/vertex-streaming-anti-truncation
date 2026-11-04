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
// A Google error envelope (native, or the compatible endpoint's one-element array) reduced
// to fixed fields: the google.rpc status, the ErrorInfo reason and error.message with markup,
// emails, keys, long tokens and the given secret removed, capped at 240 characters.
export function googleErrorDetail(body, secret) {
  const error = (Array.isArray(body) ? body[0] : body)?.error;
  if (!isObject(error)) return null;
  const info = Array.isArray(error.details) ? error.details.find(item => item?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo") : null;
  let message = typeof error.message === "string" ? error.message : "";
  if (secret) message = message.split(secret).join("[key]");
  for (const [pattern, replacement] of redactions) message = message.replace(pattern, replacement);
  message = message.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  if (message.length > 240) message = message.slice(0, 239).replace(/[\ud800-\udbff]$/, "") + "…";
  const detail = { status: enumToken(error.status), reason: enumToken(info?.reason), message: message || null };
  return detail.status || detail.reason || detail.message ? detail : null;
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
