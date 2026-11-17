const PLAN_END = "</think_nya><!--</think>-->";

// The first animation callback runs before paint. Give the plan a paint of its
// own before revealing the buffered story, even if both arrived in the STOP frame.
function afterPaint() {
  return new Promise(resolve => {
    let frame;
    const done = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(done, 80); // A backgrounded tab may suspend rAF.
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(done); });
  });
}

export function installMeowStreamPreview(getContext) {
  const { eventSource, eventTypes, messageFormatter } = getContext();
  const streams = new WeakSet();
  if (!messageFormatter?.addHook || !eventTypes?.STREAM_TOKEN_RECEIVED) return streams;
  let active;

  messageFormatter.addHook((text, floor) => {
    if (active?.bodyLimit == null || floor.isUser || floor.isSystem || floor.isReasoning) return text;
    const { processor, bodyLimit } = active;
    if (processor !== getContext().streamingProcessor || processor.isFinished || floor.messageId !== processor.messageId) return text;
    // Continue can prepend an older reply with its own planning section.
    const start = text.startsWith(processor.continueMessage) ? processor.continueMessage.length : 0;
    const end = text.indexOf(PLAN_END, start);
    if (end < 0) return text;
    return text.slice(0, end + PLAN_END.length + bodyLimit).replace(/[\uD800-\uDBFF]$/, "");
  }, { stage: messageFormatter.stage.BEFORE_REGEX });

  eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, async text => {
    const processor = getContext().streamingProcessor;
    if (!streams.has(processor) || processor.type === "impersonate") return;
    if (active?.processor !== processor) {
      if (!text.startsWith("<think_nya>")) return;
      active = watch(processor, getContext);
    }
    await active.received(text);
  });
  eventSource.on(eventTypes.GENERATION_ENDED, () => {
    if (active?.processor !== getContext().streamingProcessor || active?.processor.isFinished) active = undefined;
  });
  return streams;
}

function watch(processor, getContext) {
  const state = { processor, bodyLimit: null, received };
  const progress = processor.onProgressStreaming.bind(processor);
  const signal = processor.abortController.signal;
  const interval = 1000 / (getContext().powerUserSettings.streaming_fps || 60);
  const current = () => !signal.aborted && !processor.isFinished && getContext().streamingProcessor === processor;
  let timer, trailingPaint, planClosed = false;
  const cancel = () => { clearTimeout(timer); timer = undefined; };
  signal.addEventListener("abort", cancel, { once: true });

  // ST already serializes its normal paints. Cancel the trailing paint if ST
  // painted this update itself, or join it if a new chunk arrived mid-paint.
  processor.onProgressStreaming = async (...args) => {
    cancel();
    if (trailingPaint) await trailingPaint;
    return progress(...args);
  };

  async function received(text) {
    if (trailingPaint) await trailingPaint;
    if (!current()) return;
    const full = processor.continueMessage + text;
    const end = planClosed ? -1 : text.indexOf(PLAN_END);
    if (end >= 0) {
      planClosed = true;
      const tail = text.slice(end + PLAN_END.length);
      if (!document.hidden) {
        cancel();
        // Cap playback at four short steps regardless of the backlog size.
        // Every write to the floor/swipe gets the entire accepted response.
        const step = Math.max(64, Math.ceil(tail.length / 4));
        try {
          // A close-only event and the first story event can share a network read.
          for (let length = 0; length < Math.max(1, tail.length) && current() && !document.hidden; length += step) {
            state.bodyLimit = length;
            await progress(processor.messageId, full);
            await afterPaint();
          }
        } finally {
          state.bodyLimit = null;
        }
        if (!current()) return;
      }
    }
    if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        if (!current()) return;
        trailingPaint = progress(processor.messageId, processor.continueMessage + processor.result)
          .catch(error => console.error("Meow streaming preview failed", error))
          .finally(() => { trailingPaint = undefined; });
      }, interval);
    }
  }
  return state;
}
