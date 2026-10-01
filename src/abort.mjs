// Stop waiting for shared work without cancelling it for other callers. Both
// outcomes remain observed after an abort, so a later rejection is handled.
export function waitWithSignal(operation, signal) {
  return new Promise((resolve, reject) => {
    const finish = (settle, value) => {
      signal.removeEventListener("abort", abort);
      settle(value);
    };
    const abort = () => finish(reject, signal.reason);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(value => finish(resolve, value), error => finish(reject, error));
  });
}
