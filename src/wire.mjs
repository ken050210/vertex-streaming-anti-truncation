// Wire-format helpers shared by the request translators, stream readers and
// stream rewriters.
export const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
export const protocolError = code => Object.assign(new Error(code), { code, protocolFailure: true });
// Translated native usage and the compatible endpoint report the served tier in different places.
export const trafficType = usage => usage?.traffic_type ?? usage?.extra_properties?.google?.traffic_type;
export const sseData = value => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;

// Splits an SSE body into events. onEvent receives every event, comment-only ones
// included, as { raw, lines, data, event }; data joins the event's data lines.
export function createSseParser(onEvent, maxChars = 2 * 1024 * 1024) {
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = raw => {
    const lines = raw.split(/\r\n|\r|\n/);
    const data = lines.filter(line => line === "data" || line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, "")).join("\n");
    const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
    onEvent({ raw, lines, data, event });
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

// Rewrites an SSE response event by event. onEvent and onEnd write output with
// emit; anything they throw fails the stream.
export function transformSse(response, onEvent, onEnd = () => {}) {
  const encoder = new TextEncoder();
  let controller;
  const emit = text => controller.enqueue(encoder.encode(text));
  const parser = createSseParser(event => onEvent(event, emit));
  const body = response.body.pipeThrough(new TransformStream({
    transform(bytes, current) { controller = current; parser.push(bytes); },
    flush(current) { controller = current; parser.finish(); onEnd(emit); },
  }));
  return new Response(body, { status: response.status, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}
