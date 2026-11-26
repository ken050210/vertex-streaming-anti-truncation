import { createSseParser, enumToken, googleErrorDetail } from "../../src/wire.mjs";
import { DIAGNOSTIC_HEADER, diagnosticId, diagnosticReasonCode, httpRejection, safeCode } from "./diagnostic-fields.js";

// Observe the bytes Tavern actually consumes. Cancellation propagates to the
// original reader. Neither an auxiliary stream nor a second generation is needed.
export function observeDelivery(response, trace, report) {
  const row = trace.record;
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const sse = type.includes("text/event-stream");
  row.contentType = sse ? "SSE" : type.includes("json") ? "JSON" : type.includes("html") ? "HTML" : "other";
  row.httpStatus = response.status;
  if (row.route === "plugin") {
    const header = response.headers.get(DIAGNOSTIC_HEADER);
    row.replyId = diagnosticId(header);
    row.replyIdState = header === null ? "响应头缺失" : !row.replyId ? "响应头编号格式错误" : row.replyId === row.id ? "与请求一致" : "与请求不同";
  }
  const transport = response.headers.get("x-anti-truncation-transport");
  if (["native-streaming", "paygo-streaming", "buffered"].includes(transport)) row.transport = transport;
  const applied = Number(response.headers.get("x-gemini-output-tokens-applied"));
  if (Number.isSafeInteger(applied) && applied > 0) row.applied = applied;
  row.headersMs = trace.elapsed();
  const pluginReply = response.ok && row.route === "plugin";
  const formatError = message => {
    if (row.state !== "pending") return;
    row.responseProblem = message;
    trace.finish("error", "invalid_response_format");
  };
  if (pluginReply && response.body && row.contentType === "HTML") formatError("收到 HTML 网页");
  const readEvent = (value, errorText, bodyNote) => {
    if (pluginReply && value !== undefined) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return formatError(sse ? "流式事件应为 JSON 对象" : "正文应为 JSON 对象");
      if (!sse && !value.error && !Array.isArray(value.choices) && !Array.isArray(value.candidates) && value.responseContent == null)
        return formatError("JSON 正文缺少回复字段 choices、candidates 或 responseContent");
    }
    if (value?.error || !response.ok) {
      const detail = value?.error;
      if (row.route === "plugin" && detail?.diagnostic) {
        const record = detail.diagnostic, id = diagnosticId(record.id);
        if (id && (id === row.id || id === row.replyId || (row.replyIdState === "响应头缺失" && record.idSource === "server"))) row.server = record;
      }
      const upstream = detail?.upstreamError ?? (row.route !== "plugin" ? googleErrorDetail(value) : null);
      if (upstream?.message) trace.preview(googleErrorDetail({ error: { message: upstream.message } })?.message);
      if (upstream) row.google = { status: enumToken(upstream.status), reason: enumToken(upstream.reason) };
      if (!response.ok) row.httpRejection = httpRejection(response.status, response.headers, value ?? errorText, bodyNote);
      const code = safeCode(detail?.code) ?? diagnosticReasonCode(value?.code);
      const externalAuthError = !row.server && [401, 403, 407].includes(response.status);
      trace.finish("error", (externalAuthError && !diagnosticReasonCode(code) ? undefined : code) ?? (response.ok ? "upstream_stream_error" : "http_error"));
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
    else if (pluginReply) formatError("响应正文为空");
    else trace.finish("ok");
    return response;
  }
  const reader = response.body.getReader();
  let sawHttpErrorEvent = false;
  let parser = sse && createSseParser(({ data }) => {
    if (data?.trim() === "[DONE]") { row.doneMarker = true; return; }
    if (!data) return;
    let value;
    try { value = JSON.parse(data); } catch {
      if (pluginReply) formatError("流式事件的 JSON 解析失败");
      return;
    }
    if (response.ok || value?.error) {
      if (!response.ok) sawHttpErrorEvent = true;
      readEvent(value);
    }
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
          }
          if (!sse || (!response.ok && !sawHttpErrorEvent)) {
            let parsed, bodyNote, errorText;
            if (json !== null) {
              json += decoder.decode();
              try { parsed = JSON.parse(json); } catch {
                if (pluginReply) formatError(json.trim() ? "JSON 正文解析失败" : "响应正文为空");
                else if (!response.ok && row.contentType === "JSON" && json) bodyNote = "响应格式错误，错误正文不是有效的 JSON";
                else if (!response.ok) errorText = json;
              } finally { json = null; }
            } else if (pluginReply && row.contentType === "other") formatError("内容类型应为 JSON 或 SSE");
            else if (row.observerLimit) bodyNote = "错误正文超过 512 KiB";
            readEvent(parsed, errorText, bodyNote);
          }
          if (response.ok && sse && row.route === "plugin" && !row.doneMarker && !row.observerLimit) trace.finish("error", "stream_ended_without_done");
          else trace.finish("ok");
          controller.close();
          return;
        }
        row.bytesReceived += value.byteLength;
        row.lastDataMs = trace.elapsed();
        if (parser) {
          try { parser.push(value); } catch { row.observerLimit = true; parser = null; }
        }
        if (json !== null) {
          // The direct plugin's unary JSON is one complete document. A truncated
          // final byte must be reported even when the prefix is a large valid reply.
          if ((pluginReply && row.contentType === "JSON") || row.bytesReceived <= 512 * 1024) json += decoder.decode(value, { stream: true });
          else { json = null; row.observerLimit = true; }
        }
        controller.enqueue(value);
      } catch (error) {
        if (!response.ok) row.httpRejection ??= httpRejection(response.status, response.headers, null, "读取错误正文时中断");
        trace.thrown(error, "response_read_failed"); controller.error(error);
      }
    },
    cancel(reason) {
      if (!response.ok && !sawHttpErrorEvent) readEvent(null);
      else if (row.doneMarker) trace.finish("ok");
      else trace.finish("cancelled", "reader_cancelled");
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
