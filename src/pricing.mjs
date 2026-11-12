// Google's list prices for Vertex Gemini text models in USD per 1M tokens on the Standard tier and
// the global endpoint: [input, cached input, output (response and thinking)]. Checked 2026-10-17 at
// https://cloud.google.com/vertex-ai/generative-ai/pricing. A dated row applies before its `until`
// day (UTC). Promotional rows are the price after Google's 50% credit back on net spend.
const dated = (until, rates, later) => [{ until, rates }, { rates: later }];
const flash = dated("2027-01-01", [0.75, 0.075, 3.75], [1.5, 0.15, 7.5]);
// Gemini 4 rates checked 2026-11-13 against https://cloud.google.com/model-garden/pricing.
const argonAndCarbon = dated("2026-12-01", [2, 0.1, 10], [4, 0.2, 20]);
const PRICES = {
  "gemini-4-argon": argonAndCarbon,
  "gemini-4-carbon": argonAndCarbon,
  "gemini-4-hydrogen": [{ rates: [1.5, 0.075, 7.5] }],
  "gemini-3.8-flash": flash, "gemini-3.7-flash": flash, "gemini-3.6-flash": flash,
  "gemini-3.5-flash": [{ rates: [1.5, 0.15, 9] }],
  "gemini-3.5-flash-lite": [{ rates: [0.3, 0.03, 2.5] }],
  "gemini-3.1-flash-lite": [{ rates: [0.25, 0.025, 1.5] }],
  // A prompt over 200K tokens bills all its tokens at the long-context rates.
  "gemini-3.1-pro-preview": [{ rates: [2, 0.2, 12], long: [4, 0.4, 18] }],
  "gemini-2.5-pro": [{ rates: [1.25, 0.125, 10], long: [2.5, 0.25, 15] }],
  "gemini-2.5-flash": [{ rates: [0.3, 0.03, 2.5] }],
  "gemini-2.5-flash-lite": [{ rates: [0.1, 0.01, 0.4] }],
};
// Every listed Priority price is 1.8 times Standard and every Flex price half of it.
// Provisioned Throughput is prepaid, so it has no per-token estimate.
const TIERS = { ON_DEMAND: 1, ON_DEMAND_FLEX: 0.5, ON_DEMAND_PRIORITY: 1.8 };
const REQUESTED = { standard: "ON_DEMAND", flex: "ON_DEMAND_FLEX", priority: "ON_DEMAND_PRIORITY" };

const feed = "https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/data/model-support.json";
let liveRows = [], priceDate = "2026-11-13";

export async function refreshPricing(fetchImpl = fetch) {
  const response = await fetchImpl(feed, { redirect: "error", signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Price catalog HTTP ${response.status}`);
  const { schemaVersion, pricing } = await response.json();
  if (schemaVersion !== 1 || pricing?.currency !== "USD" || pricing.unit !== "per_million_tokens" ||
      !/^\d{4}-\d\d-\d\d$/.test(pricing.updatedAt) || pricing.updatedAt < priceDate || !Array.isArray(pricing.entries)) {
    throw new Error("Unsupported or outdated PayGo price catalog");
  }
  const rows = pricing.entries.filter(r => r?.source === "vertexai" && ["gemini-4-carbon", "gemini-4-hydrogen"].includes(r.model));
  if (!rows.length || !rows.every(r => Object.hasOwn(REQUESTED, r.tier) &&
      [r.input, r.cachedInput, r.output].every(n => Number.isFinite(n) && n >= 0) &&
      (r.validUntil == null || /^\d{4}-\d\d-\d\d$/.test(r.validUntil)) && r.longContextThreshold == null)) {
    throw new Error("Unsupported Gemini 4 price rows");
  }
  liveRows = rows;
  priceDate = pricing.updatedAt;
}

export function startPricingUpdates() {
  const refresh = () => refreshPricing().catch(error => console.warn("[pricing]", error.message));
  void refresh();
  setInterval(refresh, 6 * 60 * 60 * 1000).unref();
}

// Token counts from an OpenAI-shaped usage object. Output includes thinking, which some
// replies count only in the total.
export function usageTokens(usage) {
  const prompt = usage?.prompt_tokens, completion = usage?.completion_tokens;
  if (!Number.isInteger(prompt) || !Number.isInteger(completion) || prompt < 0 || completion < 0) return null;
  const total = Number.isInteger(usage.total_tokens) ? usage.total_tokens : prompt + completion;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  return { promptTokens: prompt, cachedTokens: Number.isInteger(cached) && cached > 0 ? Math.min(cached, prompt) : 0,
    outputTokens: Math.max(completion, total - prompt) };
}

// The reported traffic type wins over the requested tier: Priority can fall back to Standard.
export function estimateCostUsd(upstreamModel, tokens, { trafficType, serviceTier = "standard", location = "global", at = new Date() } = {}) {
  const model = upstreamModel.replace(/^google\//, "").replace(/@[a-z0-9-]+$/, "");
  const rows = PRICES[model], multiplier = TIERS[trafficType ?? REQUESTED[serviceTier]];
  if (!rows || !tokens || multiplier === undefined) return null;
  const day = at.toISOString().slice(0, 10);
  const row = rows.find(item => !item.until || day < item.until);
  const live = day >= priceDate && liveRows.find(r => r.model === model &&
    REQUESTED[r.tier] === (trafficType ?? REQUESTED[serviceTier]) && (!r.validUntil || day <= r.validUntil));
  const [input, cached, output] = live ? [live.input, live.cachedInput, live.output] :
    tokens.promptTokens > 200_000 && row.long ? row.long : row.rates;
  // Gemini 3 and later cost 10% more on regional endpoints.
  const region = location !== "global" && !model.startsWith("gemini-2.") ? 1.1 : 1;
  const cost = ((tokens.promptTokens - tokens.cachedTokens) * input + tokens.cachedTokens * cached + tokens.outputTokens * output) / 1e6;
  return Math.round(cost * (live ? 1 : multiplier) * region * 1e8) / 1e8;
}
