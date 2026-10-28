// State belongs to a configuration snapshot. Saving settings starts a fresh pool;
// in-flight requests continue with their original pool and connections.
export function createAccountPool(config, now = Date.now) {
  const policy = config.accountRotation;
  const entries = [{ id: "primary", name: "主账号", ...config }, ...policy.accounts]
    .map(connection => ({ connection, failures: 0, retryAt: 0 }));
  let cursor = 0;
  return {
    take(tried) {
      for (let offset = 0; offset < entries.length; offset++) {
        const index = (cursor + offset) % entries.length, entry = entries[index];
        if (tried.has(entry.connection.id) || entry.retryAt > now()) continue;
        cursor = (index + 1) % entries.length;
        tried.add(entry.connection.id);
        return entry;
      }
      return null;
    },
    success(entry) { entry.failures = 0; entry.retryAt = 0; },
    fail(entry) {
      entry.failures++;
      if (entry.failures < policy.failureThreshold) return false;
      entry.retryAt = now() + policy.cooldownMs;
      return true;
    },
    status() {
      return entries.map(({ connection, failures, retryAt }) => ({ id: connection.id, name: connection.name,
        failures, cooldownRemainingMs: Math.max(0, retryAt - now()) }));
    },
  };
}
