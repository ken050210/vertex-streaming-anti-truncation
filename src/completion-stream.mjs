import { checkCompatibleRejection, checkSseError, isObject, protocolError, sseData, trafficType, transformSse } from "./wire.mjs";
import { finalStopUsage } from "./vertex-native.mjs";

// A buffered profile uses one non-streaming upstream request. When the client
// expects SSE, send the completed reply as SSE without pretending it was live.
export function completionStream(completion, includeUsage) {
  const { choices, usage, router_anti_truncation: restored, ...base } = completion;
  const chunk = { ...base, object: "chat.completion.chunk" };
  let wire = sseData({ ...chunk, choices: choices.map(c => ({ index: c.index, delta: {
    ...c.message, ...(c.message?.tool_calls ? { tool_calls: c.message.tool_calls.map((call, index) => ({ ...call, index })) } : {}),
  }, finish_reason: null })) });
  wire += sseData({ ...chunk, choices: choices.map(({ message, ...c }) => ({ ...c, delta: {} })), ...(restored ? { router_anti_truncation: restored } : {}) });
  if (includeUsage && usage) wire += sseData({ ...chunk, choices: [], usage });
  return new Response(wire + sseData("[DONE]"), { headers: { "content-type": "text/event-stream" } });
}

// Native converters already use the selected alias. Compatible streams need
// the same mapping, including normal profiles that don't use a restorer.
// Without keepUsage, an empty-choices usage chunk is read but not passed on.
export function aliasStream(response, model, onMetadata = () => {}, keepUsage = true, stop) {
  if (!response.body) return response;
  let done = false, cutoffChunk;
  return transformSse(response, ({ raw, lines, data, event }, emit) => {
    checkSseError(event, data, "upstream_stream_error");
    if (!data) return emit(raw + "\n\n");
    if (done) throw new Error("Upstream stream continued after DONE");
    if (data.trim() === "[DONE]") {
      done = true;
      if (cutoffChunk) {
        const usage = finalStopUsage(stop);
        onMetadata({ usage, ...(usage?.traffic_type ? { trafficType: usage.traffic_type } : {}) });
        if (keepUsage && usage) emit(sseData({ ...cutoffChunk, choices: [], usage }));
      }
      onMetadata({ streamDone: true });
      return emit(raw + "\n\n");
    }
    const parsed = JSON.parse(data);
    checkCompatibleRejection(parsed);
    if (!isObject(parsed) || parsed.error) throw Object.assign(protocolError("upstream_stream_error"), { upstreamBody: parsed });
    if (parsed.model != null) parsed.model = model;
    const tier = trafficType(parsed.usage);
    if (tier) onMetadata({ trafficType: tier });
    if (parsed.usage && stop?.marker()) {
      delete parsed.usage; // Only the receipt at EOF can distinguish interim from final counts.
      if (!parsed.choices?.length) return;
    } else if (parsed.usage) {
      onMetadata({ usage: parsed.usage });
      if (!keepUsage && Array.isArray(parsed.choices) && !parsed.choices.length) return;
    }
    const finishReason = parsed.choices?.find(c => c.index === 0)?.finish_reason;
    if (finishReason != null) {
      onMetadata({ finishReason });
      if (stop?.marker()) {
        parsed.router_stop_after = stop.marker();
        cutoffChunk = { id: parsed.id, object: "chat.completion.chunk", created: parsed.created, model };
      }
    }
    emit([...lines.filter(l => l !== "data" && !l.startsWith("data:")), "data: " + JSON.stringify(parsed)].join("\n") + "\n\n");
  }, () => { if (!done) throw new Error("Upstream stream closed before DONE"); });
}
