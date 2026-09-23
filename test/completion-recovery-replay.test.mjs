import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithGeminiRecovery } from "../src/gemini-compat.mjs";
import { inspectCompletion } from "../src/completion-integrity.mjs";

test("enabled recovery replays unmatched compatible replies byte for byte across the inspection limit", async () => {
  for (const choice of [
    { finish_reason: "stop" },
    { message: null, finish_reason: "content_filter" },
    { message: { content: "The prompt could not be submitted is quoted dialogue." }, finish_reason: "stop" },
    { message: { content: "中文😀".repeat(12000) }, finish_reason: "stop" },
  ]) {
    const original = { choices: [choice] };
    const bytes = Buffer.from(JSON.stringify(original));
    let calls = 0, retried = false;
    const response = await fetchWithGeminiRecovery(async () => {
      calls++;
      let offset = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(offset, offset + 137)); offset += 137;
      } }), { headers: { "content-type": "application/json" } });
    }, { stream: false, messages: [{ role: "user", content: "fixture" }] }, "google/gemini-3.7-flash", {
      settings: { enabled: true, text: "private retry prefix" }, onRetry: () => { retried = true; },
    });
    const result = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(result, bytes);
    assert.deepEqual(inspectCompletion(JSON.parse(result)), inspectCompletion(original));
    assert.equal(calls, 1); assert.equal(retried, false);
  }
});
