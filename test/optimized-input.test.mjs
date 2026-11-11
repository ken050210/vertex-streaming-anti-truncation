import assert from "node:assert/strict";
import test from "node:test";
import { createFetchInterceptor, GENERATE_PATH } from "../integrations/sillytavern/shared.js";
import { prepareOptimizedInput } from "../integrations/sillytavern/optimized-input.js";

const tokenizer = "/api/tokenizers/gemma/encode";
const noFetch = () => assert.fail("unexpected tokenizer request");

test("optimized current input counts both guides, changes floor copies and delivers one provider response", async () => {
  const floor = "你好𠀀", requests = [], comparisons = [], statuses = [];
  const artifact = { type: "image_url", image_url: { url: "https://example.invalid/" + floor } };
  const tool = { role: "tool", tool_call_id: "call", content: floor };
  const schema = { properties: { [floor]: { type: "string" } } };
  const input = { chat_completion_source: "vertexai", model: "gemini-example", json_schema: schema,
    messages: [{ role: "system", content: "<" + floor + ">固定文本</" + floor + ">" },
      { role: "user", content: floor + "/" + floor },
      { role: "assistant", content: [artifact, { type: "text", text: floor }] }, tool] };
  const refusal = { choices: [{ finish_reason: "content_filter", message: { refusal: "fixture" } }] };
  const intercept = createFetchInterceptor(async (url, init) => {
    const body = JSON.parse(init.body);
    if (url === tokenizer) {
      comparisons.push(body.text);
      assert.equal(init.headers["X-CSRF-Token"], "fixture");
      return Response.json({ count: body.text.includes("共用字表") ? 20 : 10 });
    }
    assert.equal(url, GENERATE_PATH);
    requests.push(body);
    return Response.json(refusal);
  }, { origin: "http://localhost", getMode: () => "off", getUnicodeInput: () => "optimized",
    getRequestHeaders: () => ({ "Content-Type": "application/json", "X-CSRF-Token": "fixture" }),
    getUserFloor: () => floor, onStatus: status => statuses.push(status) });
  const reply = await intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify(input) });
  assert.deepEqual(await reply.json(), refusal);
  assert.equal(requests.length, 1);
  assert.equal(comparisons.length, 2);
  assert.ok(comparisons.every(text => text.split("<vat-reading>").length === 2));
  assert.ok(comparisons.every(text => !text.includes("example.invalid")));
  const [sent] = requests;
  const block = "<vat-encoded>\\u4f60好\\ud840\\udc00</vat-encoded>";
  assert.equal(sent.messages[0].content, input.messages[0].content);
  assert.ok(sent.messages[1].content.endsWith(block + "/" + block));
  assert.deepEqual(sent.messages[2].content, [artifact, { type: "text", text: block }]);
  assert.deepEqual(sent.messages[3], tool);
  assert.deepEqual(sent.json_schema, schema);
  assert.equal(sent.router_unicode_input, undefined);
  assert.equal(statuses.at(-1).unicode.format, "alternate");
  assert.equal(statuses.at(-1).unicode.selection, "gemma");
});

test("all-context table preserves tags, macros, old code blocks, literal syntax and already encoded messages", async () => {
  const text = "<角色>乙乙甲𠀀</角色> {{变量::甲}} ⟦U:4E00⟧ C:\\tmp {x}";
  const source = { messages: [{ role: "developer", content: text }, { role: "user", content: "甲" },
    { role: "assistant", content: [{ type: "thinking", text: "其他文字" }] }] };
  const result = await prepareOptimizedInput(source, "all", 65536, {
    originalFetch: async (_url, init) => Response.json({ count: JSON.parse(init.body).text.includes("共用字表") ? 15 : 35 }),
  });
  assert.equal(result.metadata.format, "table");
  const [first, second, third] = result.payload.messages;
  assert.ok(first.content.includes("a=乙 b=甲 c=𠀀"));
  assert.ok(first.content.includes("<角色>{a a b c}</角色> {{变量::甲}} ⟦U:4E00⟧ C:\\\\tmp \\{x\\}"));
  assert.equal(second.content, "<vat-encoded>{b}</vat-encoded>");
  assert.equal(third, source.messages[2]);
  assert.equal(source.messages[0].content, text);
  const again = await prepareOptimizedInput(result.payload, "all", 65536, { originalFetch: noFetch });
  assert.equal(again.metadata.reason, "no-encodable-text");
  assert.deepEqual(again.payload, result.payload);
});

test("optimized input distinguishes size bounds, missing floors, tokenizer failure and cancellation", async () => {
  const source = { messages: [{ role: "user", content: "湖".repeat(600) }] };
  const limited = await prepareOptimizedInput(source, "all", 2200, { originalFetch: noFetch });
  assert.equal(limited.metadata.format, "table");
  assert.equal(limited.metadata.selection, "body-limit");
  await assert.rejects(prepareOptimizedInput(source, "all", 100, { originalFetch: noFetch }), { code: "unicode_input_too_large" });
  await assert.rejects(prepareOptimizedInput(source, true, 65536, { originalFetch: noFetch }), { code: "unicode_floor_required" });
  const missing = await prepareOptimizedInput({ ...source, router_unicode_input: { user_floor: "别处" } },
    true, 65536, { originalFetch: noFetch });
  assert.equal(missing.metadata.reason, "floor-not-found");
  assert.deepEqual(missing.payload, source);
  const unavailable = async () => Response.json({ count: 0 });
  const fallback = await prepareOptimizedInput(source, "all", 65536, { originalFetch: unavailable });
  assert.equal(fallback.metadata.selection, "utf8");
  assert.equal(fallback.metadata.format, "table");
  await assert.rejects(prepareOptimizedInput(source, "all", 65536,
    { originalFetch: unavailable, signal: AbortSignal.abort() }), { name: "AbortError" });
});
