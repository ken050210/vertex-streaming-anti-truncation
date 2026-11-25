import { setTimeout as delay } from "node:timers/promises";

// One cursor per connection attempt. Prompt recovery and long decode keep the last selected region.
// The caller owns the request-wide budget, including any subsequent account attempts.
export function createRegionSender({ locations, budget, intervalMs, signal, retryLast, canRetry, onAttempt }) {
  let index = 0;
  return async (send, pinned) => {
    for (;;) {
      signal.throwIfAborted();
      const attempt = { location: locations[index], status: null };
      onAttempt(attempt);
      const reply = await send(attempt.location);
      attempt.status = reply.status;
      const advance = !pinned && index + 1 < locations.length;
      if (reply.status !== 429 || !budget.remaining || !canRetry() || (!advance && !retryLast)) return reply;
      const after = reply.headers.get("retry-after") ?? "";
      const wait = /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now();
      // Node timers above 2^31-1 ms fire immediately. The request deadline cancels a longer wait.
      const waitMs = Math.min(2147483647, Math.max(intervalMs, wait || 0));
      reply.body?.cancel().catch(() => {});
      await delay(waitMs, undefined, { signal });
      if (advance) index++;
      budget.remaining--;
    }
  };
}
