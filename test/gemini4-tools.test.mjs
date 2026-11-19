import test from "node:test";
import assert from "node:assert/strict";
import { nativeRequestBody } from "../src/vertex-native.mjs";
import { translateNativeCompletion, wrapNativeStream } from "../src/vertex-protocol.mjs";

for (const model of ["google/gemini-4-argon", "google/gemini-4-neon"]) test(model + " native tool history round-trips IDs and signatures for Express/flex", async () => {
  const native = { candidates: [{ content: { parts: [{ thoughtSignature: "fixture-signature", functionCall: { id: "call-native-42", name: "lookup", args: { query: "fixture" } } }] }, finishReason: "STOP" }] };
  const message = translateNativeCompletion(native, model).choices[0].message;
  const stream = await wrapNativeStream(new Response("data: " + JSON.stringify(native) + "\n\n"), model).text();
  const delta = JSON.parse(stream.split("\n")[0].slice(6)).choices[0].delta;
  assert.equal(delta.tool_calls[0].id, message.tool_calls[0].id);
  const payload = { model, messages: [{ role: "user", content: "fixture" }, message, { role: "tool", tool_call_id: message.tool_calls[0].id, content: '{"value":42}' }] };
  const body = nativeRequestBody(payload);
  assert.deepEqual(body.contents[1].parts[0], native.candidates[0].content.parts[0]);
  assert.deepEqual(body.contents[2].parts[0].functionResponse, { id: "call-native-42", name: "lookup", response: { value: 42 } });
});
