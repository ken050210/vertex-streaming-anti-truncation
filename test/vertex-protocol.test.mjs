import test from "node:test";
import assert from "node:assert/strict";
import { translateNativeCompletion, wrapNativeStream } from "../src/vertex-protocol.mjs";
import { nativeRequestBody, supportsNativeRequest } from "../src/vertex-native.mjs";
import { wrapNativeTextStream } from "../src/vertex-text-stream.mjs";
import { guardCompletionStream } from "../src/completion-integrity.mjs";

const sse = value => "data: " + JSON.stringify(value) + "\n\n";
const records = wire => wire.split("\n").filter(line => line.startsWith("data:") && !line.includes("[DONE]"))
  .map(line => JSON.parse(line.slice(5)));

test("native prompt blocks surface the provider's rejection in JSON and both SSE transports", async () => {
  // One code the finish-reason table knows and one it does not.
  for (const blockReason of ["BLOCKLIST", "JAILBREAK"]) {
    for (const candidates of [undefined, []]) {
      const native = { candidates, promptFeedback: { blockReason, blockReasonMessage: "private provider detail" } };
      const failure = error => error.code === "google_prompt_blocked" && error.status === 400
        && error.upstreamBody?.promptFeedback?.blockReasonMessage === native.promptFeedback.blockReasonMessage
        && error.upstreamBody?.promptFeedback?.blockReason === blockReason;
      assert.throws(() => translateNativeCompletion(native, "fixture"), failure);
      await assert.rejects(wrapNativeStream(new Response(sse(native)), "fixture").text(), failure);
      await assert.rejects(wrapNativeTextStream(new Response(sse(native)), "router_emit_fixture", "fixture").text(), failure);
    }
  }
});

test("normal native streams retain candidate finish codes and public finish semantics", async () => {
  for (const [finishReason, expected] of [["STOP", "stop"], ["MAX_TOKENS", "length"], ["SPII", "content_filter"]]) {
    const native = { candidates: [{ content: { parts: [{ text: "fixture answer" }] }, finishReason }] };
    const wire = await guardCompletionStream(wrapNativeStream(new Response(sse(native)), "fixture")).text();
    const choice = records(wire).flatMap(record => record.choices).find(item => item.finish_reason);
    assert.equal(choice.finish_reason, expected);
    assert.equal(choice.native_finish_reason, finishReason);
  }
});

test("native real-tool streams preserve STOP alongside tool_calls", async () => {
  const native = { candidates: [{ content: { parts: [{ functionCall: { name: "fixture_tool", args: { ok: true } } }] }, finishReason: "STOP" }] };
  const wire = await guardCompletionStream(wrapNativeStream(new Response(sse(native)), "fixture")).text();
  const choice = records(wire).flatMap(record => record.choices).find(item => item.finish_reason);
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.native_finish_reason, "STOP");
});

test("a parameterless native function call without args becomes empty JSON arguments", async () => {
  const native = { candidates: [{ content: { parts: [{ functionCall: { name: "get_time" } }] }, finishReason: "STOP" }] };
  const completion = translateNativeCompletion(native, "fixture");
  assert.equal(completion.choices[0].finish_reason, "tool_calls");
  assert.equal(completion.choices[0].message.tool_calls[0].function.arguments, "{}");
  const wire = await guardCompletionStream(wrapNativeStream(new Response(sse(native)), "fixture")).text();
  const call = records(wire).flatMap(record => record.choices).find(item => item.delta?.tool_calls)?.delta.tool_calls[0];
  assert.deepEqual([call.function.name, call.function.arguments], ["get_time", "{}"]);
  const invalid = { candidates: [{ content: { parts: [{ functionCall: { name: "get_time", args: "x" } }] }, finishReason: "STOP" }] };
  assert.throws(() => translateNativeCompletion(invalid, "fixture"), { code: "invalid_native_tool" });
});

test("native streams send the empty-choices usage chunk only when the caller asks for it", async () => {
  const native = { candidates: [{ content: { parts: [{ text: "fixture answer" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3, trafficType: "ON_DEMAND" } };
  for (const includeUsage of [false, true]) {
    let reported, nativeUsage;
    const wire = await wrapNativeStream(new Response(sse(native)), "fixture", usage => { reported = usage; }, includeUsage).text();
    assert.equal(records(wire).some(record => !record.choices.length), includeUsage);
    assert.equal(reported.traffic_type, "ON_DEMAND");
    const text = await wrapNativeTextStream(new Response(sse(native)), "router_emit_fixture", "fixture", usage => { nativeUsage = usage; }, includeUsage).text();
    assert.equal(records(text).some(record => !record.choices.length), includeUsage);
    assert.equal(nativeUsage.trafficType, "ON_DEMAND");
    assert.match(text, /\[DONE\]/);
  }
});

test("native requests map image detail, keep late instructions in place and reject images in instructions", () => {
  const image = detail => ({ type: "image_url", image_url: { url: "data:image/png;base64,AA==", ...(detail === undefined ? {} : { detail }) } });
  const user = (...details) => ({ model: "fixture", messages: [{ role: "user", content: [{ type: "text", text: "look" }, ...details.map(image)] }] });
  // A level applies only when every image asks for it; a rendered text page has no detail.
  for (const [details, resolution] of [[[undefined], undefined], [["auto"], undefined], [[null], undefined],
    [["low"], "MEDIA_RESOLUTION_LOW"], [["high", "high"], "MEDIA_RESOLUTION_HIGH"], [["low", "auto"], undefined],
    [[undefined, "low"], undefined], [["low", "high"], undefined]]) {
    assert.equal(supportsNativeRequest(user(...details)), true);
    const body = nativeRequestBody(user(...details));
    assert.equal(body.generationConfig.mediaResolution, resolution);
    assert.deepEqual(body.contents[0].parts[1], { inlineData: { mimeType: "image/png", data: "AA==" } });
  }
  const history = { model: "fixture", messages: [{ role: "user", content: [image("low")] }, { role: "assistant", content: "seen" },
    { role: "user", content: [{ type: "text", text: "and this" }, image("auto")] }] };
  assert.equal(supportsNativeRequest(history), true);
  assert.equal(nativeRequestBody(history).generationConfig.mediaResolution, undefined);
  const mixedOverride = { ...user("low", "high"), extra_body: { google: { media_resolution: "MEDIA_RESOLUTION_HIGH" } } };
  assert.equal(supportsNativeRequest(mixedOverride), true);
  assert.equal(nativeRequestBody(mixedOverride).generationConfig.mediaResolution, "MEDIA_RESOLUTION_HIGH");
  for (const payload of [user("medium"),
    { ...user("high"), extra_body: { google: { media_resolution: "MEDIA_RESOLUTION_LOW" } } },
    { model: "fixture", messages: [{ role: "system", content: [{ type: "text", text: "rules" }, image()] }, { role: "user", content: "hi" }] },
    { model: "fixture", messages: [{ role: "user", content: "hi" }, { role: "developer", content: [image("auto")] }] }]) {
    assert.equal(supportsNativeRequest(payload), false);
  }
  const explicit = { ...user("low"), extra_body: { google: { media_resolution: "MEDIA_RESOLUTION_LOW" } } };
  assert.equal(supportsNativeRequest(explicit), true);
  assert.equal(nativeRequestBody(explicit).generationConfig.mediaResolution, "MEDIA_RESOLUTION_LOW");

  const ordered = { model: "fixture", messages: [{ role: "system", content: "S1" }, { role: "developer", content: "S2" },
    { role: "user", content: "u1" }, { role: "assistant", content: "a1" }, { role: "system", content: "POST-HISTORY" }, { role: "user", content: "u2" }] };
  assert.equal(supportsNativeRequest(ordered), true);
  const body = nativeRequestBody(ordered);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "S1" }, { text: "S2" }] });
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "u1" }] }, { role: "model", parts: [{ text: "a1" }] },
    { role: "user", parts: [{ text: "POST-HISTORY" }, { text: "u2" }] }]);
});

test("user text after function responses starts its own native turn", () => {
  const call = id => ({ id, type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } });
  const body = nativeRequestBody({ model: "google/gemini-3.7-flash", messages: [{ role: "user", content: "ask" },
    { role: "assistant", content: null, tool_calls: [call("vtx.sig-a"), call("call-b")] },
    { role: "tool", tool_call_id: "vtx.sig-a", content: '{"v":1}' }, { role: "tool", tool_call_id: "call-b", content: "two" },
    { role: "user", content: "Transport format for this reply" }] });
  // Gemini 3.7 rejects a final turn that mixes function responses and text.
  assert.deepEqual(body.contents.map(content => content.role + ":" + content.parts.map(part => Object.keys(part).join("+")).join(",")),
    ["user:text", "model:functionCall+thoughtSignature,functionCall", "user:functionResponse,functionResponse", "user:text"]);
});
