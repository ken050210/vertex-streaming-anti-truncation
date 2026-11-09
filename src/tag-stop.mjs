import { createSseParser, sseData } from "./wire.mjs";
import { DEFAULT_STOP_TAG, DEFAULT_STOP_COUNT } from "./tag-stop-rule.mjs";

// Count complete outermost tag pairs in this reply's visible text. Exact opening
// and closing tags can span any number of events; unmatched closings do not count.
// Inspect native string values before their unfinished tool JSON is reconstructed.
export function createTagStop(toolName, tag = DEFAULT_STOP_TAG, count = DEFAULT_STOP_COUNT) {
  const opening = `<${tag}>`, closing = `</${tag}>`;
  let tail = "", channel, currentTool, matched = false, depth = 0, pairs = 0;
  const clip = (text, kind) => {
    if (matched) return "";
    if (!text) return text;
    channel ??= kind;
    if (channel !== kind) return text;
    const joined = tail + text;
    let cursor = 0;
    for (;;) {
      const start = joined.indexOf(opening, cursor), end = joined.indexOf(closing, cursor);
      if (start < 0 && end < 0) break;
      if (start >= 0 && (end < 0 || start < end)) {
        depth++;
        cursor = start + opening.length;
        continue;
      }
      cursor = end + closing.length;
      if (depth > 0 && --depth === 0 && ++pairs === count) {
        matched = true;
        return text.slice(0, cursor - tail.length);
      }
    }
    tail = joined.slice(cursor).slice(-(closing.length - 1));
    return text;
  };
  const process = frame => {
    if (frame.error || frame.candidates?.length !== 1) return;
    const candidate = frame.candidates[0], parts = candidate.content?.parts;
    if (!Array.isArray(parts)) return;
    for (const [index, part] of parts.entries()) {
      const call = part.functionCall;
      if (call) {
        if (typeof call.name === "string") currentTool = call.name;
        if (currentTool === toolName) {
          if (typeof call.args?.content === "string") call.args.content = clip(call.args.content, "tool");
          if (!matched && Array.isArray(call.partialArgs)) {
            for (const [i, arg] of call.partialArgs.entries()) {
              if (arg.jsonPath !== "$.content" || typeof arg.stringValue !== "string") continue;
              arg.stringValue = clip(arg.stringValue, "tool");
              if (matched) {
                arg.willContinue = false;
                call.partialArgs.length = i + 1;
                break;
              }
            }
          }
          if (matched) call.willContinue = false;
        }
      }
      if (!matched && part.thought !== true && typeof part.text === "string") part.text = clip(part.text, "plain");
      if (matched) {
        // A mixed part's text follows its function call; do not append that suffix.
        if (call) delete part.text;
        parts.length = index + 1;
        candidate.finishReason = "STOP";
        delete candidate.continuationToken;
        // This is a local stop, so no final upstream usage is available here.
        delete frame.usageMetadata;
        return;
      }
    }
  };
  return {
    clip,
    process,
    marker: () => matched ? closing : undefined,
    stream(response) {
      const encoder = new TextEncoder();
      let controller;
      const parser = createSseParser(({ raw, data, event }) => {
        if (!data || data.trim() === "[DONE]" || event === "error") { controller.enqueue(encoder.encode(raw + "\n\n")); return; }
        let frame;
        // Preserve the existing native decoder's error contract before a stop.
        try { frame = JSON.parse(data); }
        catch { controller.enqueue(encoder.encode(raw + "\n\n")); return; }
        process(frame);
        controller.enqueue(encoder.encode(sseData(frame)));
        if (matched) return false;
      });
      const body = response.body.pipeThrough(new TransformStream({
        transform(bytes, current) {
          controller = current;
          parser.push(bytes);
          // terminate closes the readable side and cancels upstream immediately.
          if (matched) current.terminate();
        },
        flush(current) { controller = current; parser.finish(); },
      }));
      return new Response(body, { status: response.status, headers: response.headers });
    },
  };
}
