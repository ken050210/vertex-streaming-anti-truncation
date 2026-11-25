import { customUpstreamModel, normalizeUpstreamModel } from "./model-profiles.mjs";
import { vertexHost } from "./vertex-locations.mjs";
import { waitWithSignal } from "./abort.mjs";

class DiscoveryError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

async function readCatalog(response) {
  const chunks = []; let size = 0;
  for await (const bytes of response.body ?? []) {
    size += bytes.length;
    if (size > 4 * 1024 * 1024) throw new DiscoveryError("Model catalog response is too large");
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new DiscoveryError("Invalid model catalog response"); }
}

// A custom upstream's OpenAI-compatible model list. Names stay exactly as the upstream lists them;
// `models` keeps those that mention Gemini, `ids` every name for checking saved profiles.
async function discoverCustomModels(config, fetchImpl, requestSignal) {
  try {
    const credential = await config.accessToken();
    const response = await fetchImpl(config.baseUrl + "/models", { method: "GET", headers: { authorization: "Bearer " + credential }, signal: requestSignal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DiscoveryError(`Custom upstream model listing failed (HTTP ${response.status}); add a model ID manually`);
    }
    const data = await readCatalog(response);
    if (!Array.isArray(data?.data)) throw new DiscoveryError("Invalid model catalog response");
    const ids = new Set();
    for (const item of data.data) {
      try { ids.add(customUpstreamModel(item?.id)); } catch { /* Not a usable name. */ }
    }
    const sorted = [...ids].sort((a, b) => a.localeCompare(b));
    return { models: sorted.filter(id => /gemini/i.test(id)).map(id => ({ id, upstreamModel: id, displayName: id })), ids: sorted,
      source: "custom-upstream-models", fetchedAt: new Date().toISOString() };
  } catch (error) {
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError(requestSignal.aborted ? "Model listing was cancelled or timed out" : "Unable to reach the custom upstream; check its URL and the connection");
  }
}

// Publisher catalog only: listing metadata does not invoke any model, and does
// not establish project entitlement, regional capacity, or service-tier support.
export async function discoverModels(config, { fetchImpl = fetch, signal } = {}) {
  const deadline = AbortSignal.timeout(20000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  if (config.authMode === "custom") return discoverCustomModels(config, fetchImpl, requestSignal);
  const host = vertexHost(config.location);
  const base = `https://${host}/v1beta1/publishers/google/models`;
  let credential;
  try { credential = await waitWithSignal(() => config.accessToken(), requestSignal); }
  // A provider authentication failure is not an expired local console session.
  catch { throw new DiscoveryError(requestSignal.aborted ? "Model listing was cancelled or timed out" : "Model list authentication failed; check the selected credentials"); }
  const headers = config.authMode === "express" ? { "x-goog-api-key": credential } : { authorization: "Bearer " + credential };
  const models = new Map(), seenTokens = new Set();
  let pageToken = "";
  try {
    for (let page = 0; page < 20; page++) {
      requestSignal.throwIfAborted();
      const url = new URL(base);
      url.searchParams.set("pageSize", "100");
      url.searchParams.set("listAllVersions", "true");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await fetchImpl(url.href, { method: "GET", headers, signal: requestSignal, redirect: "error" });
      if (!response.ok) {
        await response.body?.cancel();
        const prefix = config.authMode === "express" ? "Express model listing is unavailable with this API key" : "Vertex model listing failed";
        throw new DiscoveryError(`${prefix} (HTTP ${response.status}); add a model ID manually or use service-account credentials`);
      }
      const data = await readCatalog(response);
      if (!data || typeof data !== "object" || Array.isArray(data) || data.error ||
          (data.publisherModels != null && !Array.isArray(data.publisherModels))) throw new DiscoveryError("Invalid model catalog response");
      for (const item of data.publisherModels || []) {
        let upstreamModel;
        try { upstreamModel = normalizeUpstreamModel(item?.name); } catch { continue; }
        const id = upstreamModel.slice("google/".length);
        models.set(id, { id, upstreamModel, displayName: typeof item.displayName === "string" ? item.displayName.slice(0, 160) : id });
      }
      pageToken = data.nextPageToken || "";
      if (!pageToken) return { models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)), source: "vertex-publisher-catalog", fetchedAt: new Date().toISOString() };
      if (typeof pageToken !== "string" || pageToken.length > 8192 || seenTokens.has(pageToken)) throw new DiscoveryError("Invalid model catalog pagination");
      seenTokens.add(pageToken);
    }
    throw new DiscoveryError("Model catalog exceeded the page limit; no partial list was applied");
  } catch (error) {
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError(requestSignal.aborted ? "Model listing was cancelled or timed out" : "Unable to fetch the model catalog; check the connection");
  }
}
