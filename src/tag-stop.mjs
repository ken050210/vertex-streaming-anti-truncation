import { createSseParser, isObject, sseData } from "./wire.mjs";
import { DEFAULT_STOP_TAG, DEFAULT_STOP_COUNT } from "./tag-stop-rule.mjs";

export const STOP_USAGE_WAIT_MS = 250;

export function hasUsageTotals(usage) {
  const count = value => Number.isSafeInteger(value) && value >= 0;
  return count(usage?.promptTokenCount) && (count(usage.candidatesTokenCount) || count(usage.totalTokenCount));
}

// Count complete outermost tag pairs in this reply's visible text. Exact opening
// and closing tags can span any number of events; unmatched closings do not count.
// Structured replies can also feed their rendered text into clip, leaving this
// reader responsible for cancellation and the optional metering tail.
export function createTagStop(toolName, tag = DEFAULT_STOP_TAG, count = DEFAULT_STOP_COUNT, exemptTag = "") {
  const opening = `<${tag}>`, closing = `</${tag}>`;
  const exemptOpen = exemptTag && `<${exemptTag}>`, exemptClose = exemptTag && `</${exemptTag}>`;
  const tokens = exemptTag ? [opening, closing, exemptOpen, exemptClose] : [opening, closing];
  let exemptDepth = 0;
  let tail = "", channel, currentTool, matched = false, depth = 0, pairs = 0;
  let latestUsage, terminalUsage, pendingTailUsage, upstreamFinished = false;
  // Observe the provider's finish reason before clipping replaces it with STOP.
  const observe = (frame, buffered) => {
    if (frame?.error) return;
    const candidate = frame?.candidates?.[0], reason = candidate?.finishReason;
    const finished = buffered || (reason && reason !== "CONTINUATION" && reason !== "FINISH_REASON_UNSPECIFIED");
    const usage = frame?.usageMetadata;
    let finalUsage = usage;
    // A usage-only tail can precede a separate finish. Any intervening candidate
    // invalidates it, including more content in the finish frame itself.
    if (matched && !upstreamFinished) {
      if (!frame?.candidates?.length && isObject(usage)) pendingTailUsage = { ...pendingTailUsage, ...usage };
      else if (finished && !candidate?.content?.parts?.length && pendingTailUsage) finalUsage = { ...pendingTailUsage, ...usage };
      else if (candidate) pendingTailUsage = undefined;
    }
    if (isObject(usage)) latestUsage = { ...latestUsage, ...usage };
    if (finished) upstreamFinished = true;
    if (upstreamFinished && isObject(finalUsage)) {
      terminalUsage = { ...terminalUsage, ...finalUsage };
      for (const key of ["trafficType", "serviceTier"]) {
        if (latestUsage[key] != null) terminalUsage[key] = latestUsage[key];
      }
    }
  };
  const clip = (text, kind) => {
    if (matched) return "";
    if (!text) return text;
    channel ??= kind;
    if (channel !== kind) return text;
    const joined = tail + text;
    const previousLength = tail.length;
    tail = "";
    for (let i = joined.indexOf("<"); i >= 0; i = joined.indexOf("<", i + 1)) {
      const token = tokens.find(value => joined.startsWith(value, i));
      if (!token) {
        if (tokens.some(value => joined.length - i < value.length && value.startsWith(joined.slice(i)))) {
          tail = joined.slice(i);
          break;
        }
        continue;
      }
      if (token === exemptOpen) exemptDepth++;
      else if (token === exemptClose) exemptDepth = Math.max(0, exemptDepth - 1);
      else if (exemptDepth === 0) {
        if (token === opening) depth++;
        else if (depth > 0 && --depth === 0 && ++pairs === count) {
          matched = true;
          return text.slice(0, i + token.length - previousLength);
        }
      }
    }
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
    observe,
    marker: () => matched ? closing : undefined,
    receipt: () => {
      const final = hasUsageTotals(terminalUsage);
      return { final, usageMetadata: final ? terminalUsage : latestUsage };
    },
    stream(response, waitForUsage = false, normalizeError, clipFields) {
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
          if (frame?.error) { tailEnded = true; return false; }
          observe(frame, false);
          return;
        }
        const hostError = normalizeError?.(frame);
        if (hostError) frame = hostError;
        else if (clipFields) { observe(frame, false); clipFields(frame); }
        else process(frame);
        emit(sseData(frame));
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
              if (tailEnded || !waitForUsage || (waitForUsage === true && hasUsageTotals(terminalUsage))) finishCutoff();
              else if (waitForUsage === true) {
                deadline ??= Date.now() + STOP_USAGE_WAIT_MS;
                if (Date.now() >= deadline) finishCutoff();
                else timer ??= setTimeout(finishCutoff, STOP_USAGE_WAIT_MS);
              }
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
