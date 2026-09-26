import { isObject, sseData, trafficType, transformSse } from "./wire.mjs";

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
export function aliasStream(response, model, onMetadata = () => {}) {
  if (!response.body) return response;
  let done = false;
  return transformSse(response, ({ raw, lines, data, event }, emit) => {
    if (!data) return emit(raw + "\n\n");
    if (done) throw new Error("Upstream stream continued after DONE");
    if (data.trim() === "[DONE]") { done = true; onMetadata({ streamDone: true }); return emit(raw + "\n\n"); }
    const parsed = JSON.parse(data);
    if (!isObject(parsed) || parsed.error || event === "error") throw new Error("Invalid upstream stream event");
    if (parsed.model != null) parsed.model = model;
    const tier = trafficType(parsed.usage);
    if (tier) onMetadata({ trafficType: tier });
    const finishReason = parsed.choices?.find(c => c.index === 0)?.finish_reason;
    if (finishReason != null) onMetadata({ finishReason });
    emit([...lines.filter(l => l !== "data" && !l.startsWith("data:")), "data: " + JSON.stringify(parsed)].join("\n") + "\n\n");
  }, () => { if (!done) throw new Error("Upstream stream closed before DONE"); });
}
