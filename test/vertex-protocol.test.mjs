import test from "node:test";
import assert from "node:assert/strict";
import { translateNativeCompletion, wrapNativeStream } from "../src/vertex-protocol.mjs";
import { wrapNativeTextStream } from "../src/vertex-text-stream.mjs";
import { guardCompletionStream, inspectCompletion } from "../src/completion-integrity.mjs";

const sse = value => "data: " + JSON.stringify(value) + "\n\n";
const records = wire => wire.split("\n").filter(line => line.startsWith("data:") && !line.includes("[DONE]"))
  .map(line => JSON.parse(line.slice(5)));

test("native prompt blocks retain original codes without exposing rejection text", async () => {
  for (const blockReason of ["BLOCKLIST", "PROHIBITED_CONTENT", "OTHER", "JAILBREAK"]) {
    for (const candidates of [undefined, []]) {
      const native = { candidates, promptFeedback: { blockReason, blockReasonMessage: "private provider detail" } };
      const completion = translateNativeCompletion(native, "fixture");
      assert.equal(inspectCompletion(completion).valid, true);
      assert.equal(completion.choices[0].finish_reason, "content_filter");
      assert.equal(completion.choices[0].native_finish_reason, blockReason);
      assert.equal(JSON.stringify(completion).includes("private provider detail"), false);

      const wire = await guardCompletionStream(wrapNativeStream(new Response(sse(native)), "fixture")).text();
      const choice = records(wire).flatMap(record => record.choices).find(item => item.finish_reason);
      assert.equal(choice.finish_reason, "content_filter");
      assert.equal(choice.native_finish_reason, blockReason);
      assert.match(wire, /\[DONE\]/);
      assert.equal(wire.includes("private provider detail"), false);

      const text = await guardCompletionStream(wrapNativeTextStream(new Response(sse(native)), "router_emit_fixture", "fixture")).text();
      const textChoice = records(text).flatMap(record => record.choices).find(item => item.finish_reason);
      assert.equal(textChoice.finish_reason, "content_filter");
      assert.equal(textChoice.native_finish_reason, blockReason);
      assert.equal(text.includes("private provider detail"), false);
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
