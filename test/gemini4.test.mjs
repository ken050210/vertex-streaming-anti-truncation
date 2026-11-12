import test from "node:test";
import assert from "node:assert/strict";
import { isGemini4Argon, prepareGeminiThinkingRequest, capGemini4Output, gemini4OutputLimit, encodeGemini4ToolId, gemini4ToolMetadata } from "../src/gemini4.mjs";
import { prepareSillyTavernRequest } from "../src/sillytavern.mjs";
import { convertGeminiPrefill } from "../src/gemini-compat.mjs";

const model = "google/gemini-4-argon";
test("Gemini 4 thinking uses levels, preserves explicit config and caller data", () => {
  for (const [effort, level] of [["low", "LOW"], ["medium", "MEDIUM"], ["high", "HIGH"], ["minimal", "LOW"], ["none", "LOW"], ["max", "HIGH"]]) {
    const input = { reasoning_effort: effort, max_tokens: 123, messages: [{ role: "user", content: "fixture" }] };
    const original = structuredClone(input);
    const result = prepareGeminiThinkingRequest(input, model);
    assert.deepEqual(result.extra_body.google.thinking_config, { thinking_level: level });
    assert.equal(result.reasoning_effort, undefined);
    assert.equal(result.max_tokens, 123);
    assert.deepEqual(input, original);
  }
  const explicit = { reasoning_effort: "high", extra_body: { google: { thinking_config: { thinkingLevel: "low", include_thoughts: true } } } };
  assert.deepEqual(prepareGeminiThinkingRequest(explicit, model).extra_body.google.thinking_config, { thinking_level: "LOW", include_thoughts: true });
  const defaultRequest = { messages: [] };
  assert.strictEqual(prepareGeminiThinkingRequest(defaultRequest, model), defaultRequest);
  assert.deepEqual(prepareGeminiThinkingRequest({ reasoning_effort: "auto" }, model), {});
  assert.strictEqual(prepareGeminiThinkingRequest(explicit, "gemini-2.5-flash"), explicit);
  assert.ok(isGemini4Argon("google/gemini-4-argon@001"));
  assert.equal(isGemini4Argon("gemini-4-argon-invented"), false);
});

test("Tavern and gateway preserve preset levels and provider defaults on level-based models", () => {
  const adapters = { convertGooglePrompt: () => ({ contents: [{ role: "user", parts: [{ text: "hello" }] }] }), getPromptNames: () => ({}), safetySettings: [] };
  for (const [model, min] of [["gemini-4-carbon", "LOW"], ["gemini-4-hydrogen", "LOW"], ["gemini-3.1-pro-preview", "LOW"], ["gemini-3.8-flash", "LOW"], ["gemini-3.5-flash-lite", "MINIMAL"]]) {
    for (const [effort, level] of [["auto", undefined], ["min", min], ["low", "LOW"], ["medium", "MEDIUM"], ["high", "HIGH"]]) {
      const upstream = prepareGeminiThinkingRequest({ reasoning_effort: effort }, "google/" + model + "@001");
      assert.deepEqual(upstream, level ? { extra_body: { google: { thinking_config: { thinking_level: level } } } } : {});
      for (const mode of ["buffered", "streaming"]) {
        const body = { chat_completion_source: "vertexai", model, messages: [{ role: "user", content: "hello" }],
          reasoning_effort: effort, include_reasoning: true, vertex_anti_truncation: mode, stream: mode === "streaming" };
        const actual = prepareSillyTavernRequest({ body }, adapters).body.generationConfig.thinkingConfig;
        assert.deepEqual(actual, level ? { includeThoughts: true, thinkingLevel: level } : { includeThoughts: true });
      }
    }
    const google = { cached_content: "fixture", thinking_config: { include_thoughts: true } };
    assert.deepEqual(prepareGeminiThinkingRequest({ reasoning_effort: "high", extra_body: { google } }, model), { extra_body: { google } });
  }
});

test("Gemini 4 rejects numeric budgets and explicit cache locally", () => {
  for (const field of ["thinking_budget", "thinkingBudget"]) {
    assert.throws(() => prepareGeminiThinkingRequest({ extra_body: { google: { thinking_config: { [field]: 1024 } } } }, model), { status: 400, code: "unsupported_gemini4_thinking_budget" });
  }
  assert.throws(() => prepareGeminiThinkingRequest({ extra_body: { google: { cached_content: "fixture-cache" } } }, model), { status: 400, code: "unsupported_gemini4_cached_content" });
  assert.throws(() => prepareGeminiThinkingRequest({ reasoning_effort: "invalid" }, model), { status: 400, code: "invalid_gemini4_thinking_level" });
});

test("Gemini 4 output ceilings over one request's limit are capped, or kept for long decode", () => {
  for (const stream of [false, true]) for (const field of ["max_tokens", "max_completion_tokens"]) {
    const limit = stream ? 65536 : 32768;
    for (const requested of [undefined, 128, limit, "100000"]) {
      const input = { [field]: requested };
      assert.deepEqual(capGemini4Output(input, model, { stream }), { payload: input, outputLimit: null });
    }
    const input = { [field]: 100000, messages: [{ role: "user", content: "Hi" }] };
    const original = structuredClone(input);
    const capped = capGemini4Output(input, model, { stream });
    assert.equal(capped.payload[field], limit);
    assert.deepEqual(capped.outputLimit, { requested: 100000, applied: limit, longDecode: false });
    assert.deepEqual(input, original);
    assert.equal(capGemini4Output(input, model, { stream, longDecode: true }).payload[field], 100000);
    assert.strictEqual(capGemini4Output(input, "gemini-3.8-flash", { stream }).payload, input);
  }
  assert.deepEqual(gemini4OutputLimit(2000000, model, { longDecode: true }), { requested: 2000000, applied: 1048576, longDecode: true });
  assert.deepEqual(gemini4OutputLimit(65536, model, { stream: true, limit: 32768 }), { requested: 65536, applied: 32768, longDecode: false });
});

test("Gemini 4 text prefills follow the opt-in conversion and preserve tool history", () => {
  const payload = { messages: [{ role: "user", content: "Continue" }, { role: "assistant", content: "Prefix" }] };
  assert.equal(convertGeminiPrefill(payload, model, true).payload.messages.at(-1).role, "user");
  assert.strictEqual(convertGeminiPrefill(payload, model, false).payload, payload);
  const tools = { messages: [{ role: "assistant", content: "", tool_calls: [{ id: "fixture" }] }] };
  assert.strictEqual(convertGeminiPrefill(tools, model, true).payload, tools);
});

test("Gemini 4 opaque tool IDs retain call identity and signature", () => {
  const id = encodeGemini4ToolId({ functionCall: { id: "function-42" }, thoughtSignature: "fixture-signature" });
  assert.deepEqual(gemini4ToolMetadata(id), { id: "function-42", signature: "fixture-signature" });
  const legacy = gemini4ToolMetadata("vtx.old-signature");
  assert.match(legacy.id, /^call_[0-9a-f]{24}$/);
  assert.equal(legacy.signature, "old-signature");
  assert.throws(() => gemini4ToolMetadata("vtx4.invalid"), { code: "invalid_tool_history" });
});
