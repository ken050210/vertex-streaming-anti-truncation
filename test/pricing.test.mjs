import test from "node:test";
import assert from "node:assert/strict";
import { estimateCostUsd, refreshPricing, usageTokens } from "../src/pricing.mjs";

const tokens = (promptTokens, outputTokens, cachedTokens = 0) => ({ promptTokens, cachedTokens, outputTokens });
const october = new Date("2026-10-17T12:00:00Z");

test("usage tokens count thinking reported only in the total and cap cached tokens at the prompt", () => {
  assert.deepEqual(usageTokens({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 150 }), tokens(100, 50));
  assert.deepEqual(usageTokens({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 60 } }), tokens(100, 50, 60));
  assert.deepEqual(usageTokens({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 99 } }), tokens(10, 5, 10));
  for (const usage of [null, {}, { prompt_tokens: 1 }, { prompt_tokens: -1, completion_tokens: 1 }, { prompt_tokens: "1", completion_tokens: 1 }]) assert.equal(usageTokens(usage), null);
});

test("live Vertex rows use the reported tier and survive an invalid refresh", async () => {
  const row = { source: "vertexai", model: "gemini-4-carbon", tier: "priority", input: 8, cachedInput: 1, output: 12, validUntil: "2026-11-30" };
  const feed = entries => async () => Response.json({ schemaVersion: 1, pricing: {
    updatedAt: "2026-11-14", currency: "USD", unit: "per_million_tokens", entries
  } });
  await refreshPricing(feed([{ ...row, source: "makersuite", input: 999 }, row]));
  await assert.rejects(refreshPricing(feed([{ ...row, cachedInput: -1 }])));
  const options = { at: new Date("2026-11-30"), trafficType: "ON_DEMAND_PRIORITY" };
  const usage = tokens(100_000, 10_000, 20_000);
  assert.equal(estimateCostUsd(row.model, usage, options), 0.78);
  assert.equal(estimateCostUsd(row.model, usage, { ...options, at: new Date("2026-12-01") }), 0.9432);
});

test("estimates follow Google's list prices by model, date, tier, region and prompt length", () => {
  // Gemini 3.7 Flash: $0.75 input, $0.075 cached, $3.75 output per 1M through 2026, then double.
  assert.equal(estimateCostUsd("google/gemini-3.7-flash", tokens(1_000_000, 1_000_000), { at: october }), 4.5);
  assert.equal(estimateCostUsd("google/gemini-3.7-flash", tokens(1_000_000, 0, 1_000_000), { at: october }), 0.075);
  assert.equal(estimateCostUsd("gemini-3.7-flash", tokens(1_000_000, 1_000_000), { at: new Date("2027-01-01T00:00:00Z") }), 9);
  // Gemini 4 Argon's promotion ends on November 30, 2026.
  assert.equal(estimateCostUsd("google/gemini-4-argon", tokens(1_000_000, 1_000_000), { at: new Date("2026-11-30T23:59:59Z") }), 12);
  assert.equal(estimateCostUsd("google/gemini-4-argon", tokens(1_000_000, 1_000_000), { at: new Date("2026-12-01T00:00:00Z") }), 24);
  const mixed = tokens(100_000, 10_000, 20_000);
  const before = { at: new Date("2026-11-30T23:59:59Z") };
  const after = { at: new Date("2026-12-01T00:00:00Z") };
  assert.equal(estimateCostUsd("google/gemini-4-carbon", mixed, before), 0.262);
  assert.equal(estimateCostUsd("google/gemini-4-carbon", mixed, after), 0.524);
  assert.equal(estimateCostUsd("google/gemini-4-hydrogen", mixed, before), 0.1965);
  assert.equal(estimateCostUsd("google/gemini-4-hydrogen", mixed, after), 0.1965);
  // The reported traffic type wins over the requested tier.
  assert.equal(estimateCostUsd("google/gemini-3.7-flash", tokens(1_000_000, 0), { serviceTier: "priority", trafficType: "ON_DEMAND", at: october }), 0.75);
  assert.equal(estimateCostUsd("google/gemini-3.7-flash", tokens(1_000_000, 0), { serviceTier: "priority", at: october }), 1.35);
  assert.equal(estimateCostUsd("google/gemini-3.7-flash", tokens(1_000_000, 0), { trafficType: "ON_DEMAND_FLEX", at: october }), 0.375);
  assert.equal(estimateCostUsd("google/gemini-3.7-flash", tokens(1_000_000, 0), { location: "us-central1", at: october }), 0.825);
  // Regional endpoints add 10% only from Gemini 3 on; long prompts switch every token to long-context rates.
  assert.equal(estimateCostUsd("google/gemini-2.5-pro@001", tokens(100_000, 0), { location: "us-central1", at: october }), 0.125);
  assert.equal(estimateCostUsd("google/gemini-2.5-pro", tokens(200_000, 100_000), { at: october }), 1.25);
  assert.equal(estimateCostUsd("google/gemini-2.5-pro", tokens(200_001, 100_000), { at: october }), 2.0000025);
  for (const [model, options] of [["google/gemini-3-flash-preview", {}], ["google/gemini-unknown", {}], ["google/gemini-3.7-flash", { trafficType: "PROVISIONED_THROUGHPUT" }]]) {
    assert.equal(estimateCostUsd(model, tokens(1000, 1000), { ...options, at: october }), null);
  }
});
