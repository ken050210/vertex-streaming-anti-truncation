import { createSseParser, isObject, sseData } from "./wire.mjs";
import { DEFAULT_STOP_TAG, DEFAULT_STOP_COUNT } from "./tag-stop-rule.mjs";

export const STOP_USAGE_WAIT_MS = 250;

export function hasUsageTotals(usage) {
  const count = value => Number.isSafeInteger(value) && value >= 0;
  return count(usage?.promptTokenCount) && (count(usage.candidatesTokenCount) || count(usage.totalTokenCount));
}

// Count complete outermost tag pairs in this reply's visible text. Exact opening
// and closing tags can span any number of events; unmatched closings do not count.
// Inspect native string values before their unfinished tool JSON is reconstructed.
export function createTagStop(toolName, tag = DEFAULT_STOP_TAG, count = DEFAULT_STOP_COUNT) {
  const opening = `<${tag}>`, closing = `</${tag}>`;
  let tail = "", channel, currentTool, matched = false, depth = 0, pairs = 0;
  let latestUsage, terminalUsage, upstreamFinished = false;
  // Observe the provider's finish reason before clipping replaces it with STOP.
  const observe = (frame, buffered) => {
    const reason = frame?.candidates?.[0]?.finishReason;
    if (buffered || (reason && reason !== "CONTINUATION" && reason !== "FINISH_REASON_UNSPECIFIED")) upstreamFinished = true;
    const usage = frame?.usageMetadata;
    if (!frame?.error && isObject(usage)) {
      latestUsage = { ...latestUsage, ...usage };
      if (upstreamFinished) {
        terminalUsage = { ...terminalUsage, ...usage };
        for (const key of ["trafficType", "serviceTier"]) {
          if (latestUsage[key] != null) terminalUsage[key] = latestUsage[key];
        }
      }
    }
  };
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
  const process = (frame, buffered = false) => {
    observe(frame, buffered);
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
        // Only the receipt can distinguish interim counts from a provider finish.
        delete frame.usageMetadata;
        return;
      }
    }
  };
  return {
    clip,
    process,
    marker: () => matched ? closing : undefined,
    receipt: () => {
      const final = hasUsageTotals(terminalUsage);
      return { final, usageMetadata: final ? terminalUsage : latestUsage };
    },
    stream(response, waitForUsage = false, normalizeError) {
      const reader = response.body.getReader(), encoder = new TextEncoder();
      let output, timer, deadline, emitted, closed = false, tailEnded = false;
      const emit = text => { output.enqueue(encoder.encode(text)); emitted = true; };
      const parser = createSseParser(({ raw, data, event }) => {
        if (!data || data.trim() === "[DONE]" || event === "error") {
          if (!matched) emit(raw + "\n\n");
          else if (data || event === "error") { tailEnded = true; return false; }
          return;
        }
        let frame;
        try { frame = JSON.parse(data); }
        catch {
          if (!matched) emit(raw + "\n\n");
          else { tailEnded = true; return false; }
          return;
        }
        if (matched) {
          // Only metering survives the boundary, including later events in the same read.
          observe(frame, false);
          if (frame?.error) { tailEnded = true; return false; }
          if (hasUsageTotals(terminalUsage)) tailEnded = true;
          return;
        }
        const hostError = normalizeError?.(frame);
        if (hostError) frame = hostError;
        else process(frame);
        emit(sseData(frame));
        if (matched && hasUsageTotals(terminalUsage)) tailEnded = true;
      });
      const finishCutoff = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        output.close();
        // A failed or tee'd upstream may reject or delay cancellation after the cutoff.
        void reader.cancel().catch(() => {});
      };
      const body = new ReadableStream({
        start(controller) { output = controller; },
        async pull(controller) {
          emitted = false;
          do {
            try {
              const next = await reader.read();
              if (closed) return;
              if (next.done) {
                parser.finish();
                clearTimeout(timer);
                closed = true;
                controller.close();
                return;
              }
              parser.push(next.value);
            } catch (error) {
              if (closed) return;
              if (!matched) {
                controller.error(error);
                void reader.cancel(error).catch(() => {});
                return;
              }
              tailEnded = true;
            }
            if (matched) {
              deadline ??= Date.now() + STOP_USAGE_WAIT_MS;
              if (tailEnded || !waitForUsage || Date.now() >= deadline) finishCutoff();
              else timer ??= setTimeout(finishCutoff, STOP_USAGE_WAIT_MS);
            }
          } while (!closed && !emitted);
        },
        cancel(reason) {
          closed = true;
          clearTimeout(timer);
          return reader.cancel(reason);
        },
      });
      return new Response(body, { status: response.status, headers: response.headers });
    },
  };
}
