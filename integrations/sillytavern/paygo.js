import { prepareAntiTruncation } from "../../src/anti-truncation.mjs";
import { capGemini4Output } from "../../src/gemini4.mjs";
import { createTagStop } from "../../src/tag-stop.mjs";
import { restoreBrowserStream } from "../../src/tauritavern.mjs";
import { BODY_LIMIT, PLUGIN_PATH } from "./shared.js";
import { googleErrorDetail, upstreamMessage } from "../../src/wire.mjs";

// PayGo owns the request URL, single-use ticket, stream flag, service tier and
// usage observer. Shape only the submitted messages/tools and consume its reply.
export async function sendPayGoRequest({ originalFetch, input, init, body, mode, imageMode, tagStop, longDecode,
  unicode, ensureBackend, getRequestHeaders, onStatus }) {
  const signal = init?.signal ?? input?.signal;
  let image;
  if (imageMode !== "off") {
    if (!await ensureBackend("image-input-convert")) throw new Error("paygo_image_backend_required");
    const converted = await originalFetch(PLUGIN_PATH + "/image-input", {
      method: "POST", headers: getRequestHeaders(), signal, cache: "no-store",
      body: JSON.stringify({ messages: body.messages, mode: imageMode })
    });
    if (!converted.ok) {
      const detail = (await converted.json().catch(() => null))?.error;
      throw Object.assign(new Error(detail?.message || detail?.code || "image_render_failed"), {
        code: detail?.code || "image_render_failed", character: detail?.character, param: detail?.param
      });
    }
    const result = await converted.json();
    body.messages = result.messages;
    delete body.vertex_image_input;
    image = result.metadata;
  }
  const continuation = body.type === "continue";
  const capped = capGemini4Output(body, body.model, {stream: body.stream === true});
  if (longDecode && capped.outputLimit) throw new Error("paygo_long_decode_unsupported");
  const prepared = prepareAntiTruncation(capped.payload, mode !== "off", false, { continuation });
  const payload = JSON.stringify(prepared.payload);
  if (new TextEncoder().encode(payload).byteLength > BODY_LIMIT) throw new Error("request_too_large");
  signal?.throwIfAborted();
  const reply = await originalFetch(input, { ...init, body: payload });
  if (!reply.ok) return reply;
  const live = mode === "streaming" && body.stream === true;
  const transport = body.stream && (live || mode === "off") ? "paygo-streaming" : "buffered";
  let delivered = reply;
  if (reply.body) {
    if (body.stream && prepared.toolName) {
      delivered = await restoreBrowserStream(reply, { toolName: prepared.toolName, tools: prepared.payload.tools,
        model: body.model, continuation, stream: true, upstreamStream: live, tagStop, outputLimit: capped.outputLimit }, signal);
    } else if (!body.stream) {
      const data = await reply.json();
      if (data?.error || data?.promptFeedback?.blockReason) {
        const detail = googleErrorDetail(data);
        const message = upstreamMessage(detail, data.message || "Vertex PayGo 返回了错误。");
        return Response.json({ ...data, error: { ...(typeof data.error === "object" ? data.error : {}),
          code: data.error?.code ?? "paygo_upstream_error", message } }, { status: detail?.promptBlocked ? 400 : 502 });
      }
      delivered = Response.json(prepared.toolName ? restorePayGoJson(data, prepared.toolName, tagStop) : data);
    }
  }
  onStatus(delivered.ok ? { mode, payGo: true, unicode, continuation, outputLimit:capped.outputLimit,
    ...(image ? { image: { ...image, transport } } : {}) } : { error: delivered.status });
  return delivered;
}

// ST omits Google's finish reason from some non-streaming responses. Preserve
// the host envelope, usage, and signatures on real tools. Never infer a finish.
function restorePayGoJson(data, toolName, tagStop) {
  if (data.error) return data;
  if (data.candidates?.length > 1) throw new Error("unexpected_candidates");
  const candidate = data.candidates?.[0] ?? {content:data.responseContent};
  if (!Array.isArray(candidate.content?.parts)) throw new Error("invalid_upstream_json");
  const stop = tagStop && createTagStop(toolName, tagStop.tag, tagStop.count);
  if (stop) {
    stop.process({candidates:[candidate]});
    if (stop.marker()) data.vertexStopAfter = stop.marker();
  }
  let restored = false;
  const parts = candidate.content.parts.map(part => {
    if (part.functionCall?.name !== toolName) return part;
    if (restored || typeof part.functionCall.args?.content !== "string") throw new Error("anti_truncation_invalid_arguments");
    restored = true;
    return {text:part.functionCall.args.content};
  });
  const content = {...candidate.content, parts};
  candidate.content = data.responseContent = content;
  if (data.choices?.[0]?.message) {
    data.choices[0].message.content = parts.filter(p => !p.thought && typeof p.text === "string").map(p => p.text).join("");
  }
  data.vertexAntiTruncation = {restored};
  return data;
}
