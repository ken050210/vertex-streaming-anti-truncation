import test from "node:test";
import assert from "node:assert/strict";
import { supportsNativeTextStream, buildNativeTextBody, wrapNativeTextStream } from "../src/vertex-text-stream.mjs";
import { prepareAntiTruncation, wrapAntiTruncationStream } from "../src/anti-truncation.mjs";

const name = "router_emit_native_test";
const request = { messages: [{ role: "user", content: "test" }], stream: true, max_tokens: 512 };
const event = data => "data: " + JSON.stringify(data) + "\n\n";
const call = functionCall => event({ candidates: [{ content: { parts: [{ functionCall }] } }] });
const start = () => call({ name, willContinue: true });
const part = (stringValue, willContinue = true) => call({ partialArgs: [{ jsonPath: "$.content", stringValue, willContinue }], willContinue: true });
const finish = (finishReason = "STOP") => event({ candidates: [{ finishReason }], usageMetadata: {
  promptTokenCount: 12, candidatesTokenCount: 8, thoughtsTokenCount: 3, totalTokenCount: 23, trafficType: "ON_DEMAND",
} });
const parse = text => text.split("\n").filter(x => x.startsWith("data:") && !x.includes("[DONE]")).map(x => JSON.parse(x.slice(5)));
const content = events => events.map(x => x.choices?.[0]?.delta?.content ?? "").join("");
async function restore(wire) {
  const bytes = new TextEncoder().encode(wire);
  let offset = 0;
  const source = new ReadableStream({ pull(controller) {
    if (offset === bytes.length) return controller.close();
    controller.enqueue(bytes.slice(offset, ++offset));
  } });
  return wrapAntiTruncationStream(wrapNativeTextStream(new Response(source), name, "gemini-3.7-flash"), name).text();
}

test("native experiment translates supported settings and falls back before discarding unsupported fields", () => {
  const payload = { ...request, temperature: 0.6, top_p: 0.9, stop: ["END"], frequency_penalty: 0.1,
    extra_body: { google: { thinking_config: { thinking_budget: 128, include_thoughts: true },
      safety_settings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }],
      cached_content: "cachedContents/test", media_resolution: "MEDIA_RESOLUTION_LOW" } } };
  assert.equal(supportsNativeTextStream(payload), true);
  const prepared = prepareAntiTruncation(payload, true, true);
  const body = buildNativeTextBody(prepared.payload);
  const callingConfig = body.toolConfig.functionCallingConfig;
  assert.equal(callingConfig.streamFunctionCallArguments, true);
  assert.equal(body.toolConfig.functionCallingConfig.allowedFunctionNames[0], prepared.toolName);
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 128, includeThoughts: true });
  assert.equal(body.generationConfig.maxOutputTokens, 512);
  assert.deepEqual(body.safetySettings, payload.extra_body.google.safety_settings);
  assert.equal(body.cachedContent, "cachedContents/test");
  assert.equal(body.generationConfig.frequencyPenalty, 0.1);
  assert.equal(body.generationConfig.mediaResolution, "MEDIA_RESOLUTION_LOW");
  assert.equal(buildNativeTextBody(prepareAntiTruncation(request, true, true).payload).safetySettings, undefined);
  const effort = buildNativeTextBody(prepareAntiTruncation({ ...request, reasoning_effort: "low" }, true, true).payload);
  assert.deepEqual(effort.generationConfig.thinkingConfig, { thinkingBudget: 1024 });
  for (const extra of [{ custom: 1 }, { logit_bias: { "1": 5 } }, { reasoning_effort: "unknown" },
    { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }] },
    { extra_body: { google: { thought_tag_marker: "thinking" } } }, { stream_options: { unknown: true } }]) {
    assert.equal(supportsNativeTextStream({ ...request, ...extra }), false);
  }
});

test("SillyTavern's disabled thinking extension keeps native streaming without changing Gemini thinking", () => {
  const payload = { ...request, thinking: { type: "disabled" }, temperature: 0.9, top_p: 0.95,
    top_k: 40, presence_penalty: 0, frequency_penalty: 0, seed: -1, n: 1, stop: [], logit_bias: {} };
  const original = structuredClone(payload);
  const prepared = prepareAntiTruncation(payload, true, true);
  assert.equal(prepared.reason, "tool-transport-native-streaming");
  const body = buildNativeTextBody(prepared.payload);
  assert.equal(body.thinking, undefined);
  assert.equal(body.generationConfig.thinkingConfig, undefined);
  assert.deepEqual(payload, original);
  for (const thinking of ["disabled", {}, { type: "enabled" }, { type: "adaptive" }, { type: "disabled", budget_tokens: 100 }]) {
    const fallback = prepareAntiTruncation({ ...payload, thinking }, true, true);
    assert.equal(fallback.reason, "tool-transport-buffered-fields");
    assert.strictEqual(fallback.payload.thinking, thinking);
  }
  for (const [enabled, streaming, stream] of [[true, false, true], [true, true, false], [false, true, true]]) {
    const normal = prepareAntiTruncation({ ...payload, stream }, enabled, streaming);
    assert.notEqual(normal.reason, "tool-transport-native-streaming");
    assert.strictEqual(normal.payload.thinking, payload.thinking);
  }
});

test("native partialArgs preserve quotes, control characters, split surrogates, usage and a genuine stop", async () => {
  const fragments = ['中文 "quoted" \\ path\n', '\t<gametxt>first', '\ud83d', '\ude00</gametxt>'];
  const text = await restore(start() + fragments.map(value => part(value)).join("") + part("", false) + call({}) + finish());
  const records = parse(text);
  assert.equal(content(records), fragments.join(""));
  assert.equal(records.some(r => r.choices?.[0]?.delta?.tool_calls), false);
  assert.equal(records.find(r => r.choices?.[0]?.finish_reason)?.choices[0].finish_reason, "stop");
  assert.deepEqual(records.find(r => r.usage).usage, { prompt_tokens: 12, completion_tokens: 11, total_tokens: 23,
    prompt_tokens_details: { cached_tokens: 0 }, traffic_type: "ON_DEMAND" });
  assert.equal(records.at(-1).router_anti_truncation.restored, true);
  assert.ok(text.endsWith("data: [DONE]\n\n"));
});

test("native transport handles full arguments, plain fallback and thought metadata without combining answers", async () => {
  const wire = event({ candidates: [{ content: { parts: [{ text: "meta", thought: true }, { text: "plain" }] } }] }) +
    call({ name, args: { content: "synthetic" } }) + finish();
  const records = parse(await restore(wire));
  assert.equal(content(records), "plain");
  assert.equal(records.find(r => r.choices?.[0]?.delta?.reasoning_content)?.choices[0].delta.reasoning_content, "meta");
  assert.equal(records.at(-1).router_anti_truncation.restored, false);
  assert.equal(content(parse(await restore(call({ name, args: { content: "complete" } }) + finish()))), "complete");
});

test("native truncation and cancellation cannot become successful completion", async () => {
  for (const [reason, expected] of [["MAX_TOKENS", "length"], ["SAFETY", "content_filter"]]) {
    const records = parse(await restore(start() + part("partial") + finish(reason)));
    assert.equal(content(records), "partial");
    assert.equal(records.find(r => r.choices?.[0]?.finish_reason)?.choices[0].finish_reason, expected);
  }
  for (const wire of [start() + part("partial"), start() + part("partial") + finish(),
    start() + part("closed", false) + call({}) + call({ name, args: { content: "duplicate" } }) + finish(),
    start() + call({ partialArgs: [{ jsonPath: "$.other", stringValue: "bad" }], willContinue: true })]) {
    await assert.rejects(restore(wire), /anti_truncation_native_/);
  }
  let source, cancelled = false;
  const body = new ReadableStream({ start(c) { source = c; }, cancel() { cancelled = true; } });
  const reader = wrapAntiTruncationStream(wrapNativeTextStream(new Response(body), name, "test"), name).body.getReader();
  source.enqueue(new TextEncoder().encode(start() + part("first")));
  let received = "";
  while (!received.includes("first")) received += new TextDecoder().decode((await reader.read()).value);
  assert.equal(received.includes("[DONE]"), false);
  await reader.cancel();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
});
