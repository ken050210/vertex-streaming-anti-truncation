import { createSseParser, enumToken, googleErrorDetail } from "../../src/wire.mjs";
import { safeCode } from "./diagnostic-fields.js";

// Observe the bytes Tavern actually consumes. Cancellation propagates to the
// original reader. Neither an auxiliary stream nor a second generation is needed.
export function observeDelivery(response, trace, report) {
  const row = trace.record;
  const type = response.headers.get("content-type") ?? "";
  const sse = type.includes("text/event-stream");
  row.contentType = sse ? "SSE" : type.includes("json") ? "JSON" : type.includes("html") ? "HTML" : "other";
  row.httpStatus = response.status;
  const transport = response.headers.get("x-anti-truncation-transport");
  if (["native-streaming", "paygo-streaming", "buffered"].includes(transport)) row.transport = transport;
  const applied = Number(response.headers.get("x-gemini-output-tokens-applied"));
  if (Number.isSafeInteger(applied) && applied > 0) row.applied = applied;
  row.headersMs = trace.elapsed();
  const readEvent = value => {
    if (value?.error || !response.ok) {
      const detail = value?.error;
      if (row.route === "plugin" && detail?.diagnostic?.id === row.id) row.server = detail.diagnostic;
      const upstream = detail?.upstreamError ?? (row.route !== "plugin" ? googleErrorDetail(value) : null);
      if (upstream?.message) trace.preview(googleErrorDetail({ error: { message: upstream.message } })?.message);
      if (upstream) row.google = { status: enumToken(upstream.status), reason: enumToken(upstream.reason) };
      trace.finish("error", safeCode(detail?.code) ?? (response.ok ? "upstream_stream_error" : "http_error"));
      report(value, !response.ok ? response.status : undefined);
      return;
    }
    const candidate = value?.candidates?.[0];
    const parts = candidate?.content?.parts;
    const text = (Array.isArray(parts) && parts.some(p => p && !p.thought && p.text)) || value?.choices?.[0]?.message?.content;
    if (text) row.firstTextMs ??= trace.elapsed();
    const finish = enumToken(candidate?.finishReason) ?? safeCode(value?.choices?.[0]?.finish_reason);
    if (finish) row.finishReason = finish;
    if (value?.vertexStopAfter) row.tagStopped = true;
  };
  if (!response.body) {
    if (!response.ok) readEvent(null);
    else trace.finish("ok");
    return response;
  }
  const reader = response.body.getReader();
  let parser = sse && createSseParser(({ data }) => {
    if (data?.trim() === "[DONE]") { row.doneMarker = true; return; }
    if (!data) return;
    let value;
    try { value = JSON.parse(data); } catch { return; }
    readEvent(value);
  });
  const decoder = new TextDecoder();
  let json = row.contentType === "JSON" || !response.ok ? "" : null;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (parser) {
            try { parser.finish(); } catch { row.observerLimit = true; }
          } else if (!sse) {
            let parsed;
            if (json !== null) { try { parsed = JSON.parse(json + decoder.decode()); } catch {} }
            readEvent(parsed);
          }
          if (sse && row.route === "plugin" && !row.doneMarker && !row.observerLimit) trace.finish("error", "stream_ended_without_done");
          else trace.finish("ok");
          controller.close();
          return;
        }
        row.bytesReceived += value.byteLength;
        row.lastDataMs = trace.elapsed();
        if (parser) {
          try { parser.push(value); } catch { row.observerLimit = true; parser = null; }
        } else if (json !== null) {
          // Large completions still stream through unchanged. Only a small unary
          // envelope is inspected for finish metadata, and never persisted.
          json = row.bytesReceived <= 512 * 1024 ? json + decoder.decode(value, { stream: true }) : null;
        }
        controller.enqueue(value);
      } catch (error) { trace.thrown(error, "response_read_failed"); controller.error(error); }
    },
    cancel(reason) { trace.finish("cancelled", "reader_cancelled"); return reader.cancel(reason); },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
