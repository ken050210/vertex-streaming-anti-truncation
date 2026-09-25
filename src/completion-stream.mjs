// A buffered profile uses one non-streaming upstream request. When the client
// expects SSE, send the completed reply as SSE without pretending it was live.
export function completionStream(completion, includeUsage) {
  const { choices, usage, router_anti_truncation: restored, ...base } = completion;
  const chunk = { ...base, object: "chat.completion.chunk" };
  const encode = value => "data: " + JSON.stringify(value) + "\n\n";
  let wire = encode({ ...chunk, choices: choices.map(c => ({ index: c.index, delta: {
    ...c.message, ...(c.message?.tool_calls ? { tool_calls: c.message.tool_calls.map((call, index) => ({ ...call, index })) } : {}),
  }, finish_reason: null })) });
  wire += encode({ ...chunk, choices: choices.map(({ message, ...c }) => ({ ...c, delta: {} })), ...(restored ? { router_anti_truncation: restored } : {}) });
  if (includeUsage && usage) wire += encode({ ...chunk, choices: [], usage });
  return new Response(wire + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

// Native converters already use the selected alias. Compatible streams need
// the same mapping, including normal profiles that don't use a restorer.
export function aliasStream(response, model, onMetadata = () => {}) {
  if (!response.body) return response;
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  let buffer = "", done = false;
  function event(raw) {
    const lines = raw.split(/\r\n|\n|\r/);
    const data = lines.filter(l => l === "data" || l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
    if (!data) return raw + "\n\n";
    if (done) throw new Error("Upstream stream continued after DONE");
    if (data.trim() === "[DONE]") { done = true; onMetadata({ streamDone: true }); return raw + "\n\n"; }
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.error || lines.some(l => /^event:\s*error\s*$/.test(l))) throw new Error("Invalid upstream stream event");
    if (parsed.model != null) parsed.model = model;
    const trafficType = parsed.usage?.traffic_type ?? parsed.usage?.extra_properties?.google?.traffic_type;
    if (trafficType) onMetadata({ trafficType });
    const finishReason = parsed.choices?.find(c => c.index === 0)?.finish_reason;
    if (finishReason != null) onMetadata({ finishReason });
    return lines.filter(l => l !== "data" && !l.startsWith("data:")).join("\n") + "\ndata: " + JSON.stringify(parsed) + "\n\n";
  }
  function drain(controller) {
    let boundary;
    while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
      if (boundary.index > 2 * 1024 * 1024) throw new Error("SSE event is too large");
      controller.enqueue(encoder.encode(event(buffer.slice(0, boundary.index))));
      buffer = buffer.slice(boundary.index + boundary[0].length);
    }
    if (buffer.length > 2 * 1024 * 1024) throw new Error("SSE event is too large");
  }
  return new Response(response.body.pipeThrough(new TransformStream({
    transform(bytes, controller) { buffer += decoder.decode(bytes, { stream: true }); drain(controller); },
    flush(controller) {
      buffer += decoder.decode(); drain(controller);
      if (buffer.trim()) controller.enqueue(encoder.encode(event(buffer)));
      if (!done) throw new Error("Upstream stream closed before DONE");
    },
  })), { status: response.status, headers: { "content-type": "text/event-stream" } });
}
