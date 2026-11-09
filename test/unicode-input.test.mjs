import test from "node:test";
import assert from "node:assert/strict";
import { encodeUnicodeText, prepareUnicodeInput, unicodeInputLogFields } from "../src/unicode-input.mjs";
const floor = '<tag value="ABC">你好 ABC，123😀𠀀</tag> {{user}}';
const request = () => ({ model: "sample", router_unicode_input: { user_floor: floor }, messages: [
  { role: "system", content: "before " + floor + " after" },
  { role: "user", content: "unrelated history" }, { role: "assistant", content: floor },
  { role: "user", content: floor + "\n" + floor }, { role: "user", content: "preset tail" }],
  stream: true, extra_body: { test: 1 } });
const prepare = payload => prepareUnicodeInput(payload, true, 65536);

test("all-context encodes system, developer, history and current text without reading a chat floor", () => {
  const media={type:"image_url",image_url:{url:"https://example.test/keep"}};
  const tool={role:"tool",tool_call_id:"call",content:'{"key":"tool value"}'};
  const input={model:"model-name",messages:[
    {role:"system",content:"<System>规则</System>"},{role:"developer",content:"Guide"},
    {role:"user",content:"前文"},{role:"assistant",content:[{type:"text",text:"历史"},media]},
    tool,{role:"user",content:[{type:"text",text:"当前❤ ⟦U:41⟧"}]}]};
  const {payload,metadata}=prepareUnicodeInput(input,"all",65536);
  assert.equal(metadata.method,"all-context");
  assert.equal(metadata.matchedMessages,5);
  assert.equal(payload.messages[0].content,"<System>⟦U:89C4 5219⟧</System>");
  assert.equal(payload.messages[1].content,encodeUnicodeText("Guide").text);
  assert.equal(payload.messages[2].content,encodeUnicodeText("前文").text);
  assert.equal(payload.messages[3].content[0].text,encodeUnicodeText("历史").text);
  assert.equal(payload.messages[3].content[1],media);
  assert.equal(payload.messages[4],tool);
  assert.equal(payload.messages[5].content[0].text,"⟦U:5F53 524D⟧❤ ⟦U:41⟧");
  assert.deepEqual(prepareUnicodeInput(payload,"all",65536).payload,payload);
  assert.throws(()=>prepareUnicodeInput(input,"all",100),{code:"unicode_input_too_large"});
});

test("reference encoding protects tags and encoded blocks, not macros; astral Han round-trips", () => {
  const result = encodeUnicodeText(floor);
  assert.equal(result.count, 10);
  assert.match(result.text, /⟦U:4F60 597D⟧ ⟦U:41 42 43⟧，123😀⟦U:20000⟧/);
  assert.ok(result.text.includes('<tag value="ABC">'));
  assert.ok(result.text.includes('{{⟦U:75 73 65 72⟧}}'));
  assert.equal(result.text.replace(/⟦U:([0-9A-F ]+)⟧/g, (_, codes) => String.fromCodePoint(...codes.split(" ").map(c => parseInt(c, 16)))), floor);
  assert.equal(encodeUnicodeText(result.text).text, result.text);
});

test("all exact floor copies change regardless of role, unrelated history and preset tail stay intact", () => {
  const payload = request(), original = structuredClone(payload);
  const result = prepare(payload);
  assert.deepEqual(payload, original);
  for (const i of [1, 4]) assert.equal(result.payload.messages[i], payload.messages[i]);
  for (const i of [0, 2, 3]) assert.ok(result.payload.messages[i].content.includes("⟦U:"));
  assert.equal(result.payload.messages[3].content, [encodeUnicodeText(floor).text, encodeUnicodeText(floor).text].join('\n'));
  assert.equal(result.payload.router_unicode_input, undefined);
  assert.equal(result.payload.extra_body, payload.extra_body);
  assert.deepEqual(result.metadata, { reason: "encoded", method: "chat-floor-match", encodedCharacters: 40, matchedMessages: 3, occurrences: 4 });
  const second = prepare({ ...result.payload, router_unicode_input: payload.router_unicode_input });
  assert.deepEqual(second.payload, result.payload);
  assert.equal(second.metadata.reason, "floor-not-found");
});

test("original, trimmed and normalized newline forms follow reference order", () => {
  const source = "  第一行\r\nSecond  ";
  const parts = [source, source.trim(), source.replace(/\r\n?/g, '\n')];
  const result = prepare({ messages: parts.map(content => ({ role: "user", content })), router_unicode_input: { user_floor: source } });
  assert.equal(result.metadata.occurrences, 3);
  assert.deepEqual(result.payload.messages.map(m => m.content), parts.map(s => encodeUnicodeText(s).text));
});

test("matches inside surrounding tags or encoded blocks stay intact and replacements are never matched again", () => {
  const tags = prepare({ messages: [{ role: "system", content: "<剧情>上文剧情</剧情>" }, { role: "user", content: "剧情" }],
    router_unicode_input: { user_floor: "剧情" } });
  assert.deepEqual(tags.payload.messages.map(m => m.content), ["<剧情>上文⟦U:5267 60C5⟧</剧情>", "⟦U:5267 60C5⟧"]);
  assert.equal(tags.metadata.occurrences, 2);
  const block = prepare({ messages: [{ role: "assistant", content: "⟦U:4E2D 6587⟧ D" }], router_unicode_input: { user_floor: "D" } });
  assert.equal(block.payload.messages[0].content, "⟦U:4E2D 6587⟧ ⟦U:44⟧");
  const trimmed = prepare({ messages: [{ role: "user", content: "say U" }], router_unicode_input: { user_floor: " U" } });
  assert.equal(trimmed.payload.messages[0].content, "say ⟦U:55⟧");
  assert.deepEqual([trimmed.metadata.occurrences, trimmed.metadata.encodedCharacters], [1, 1]);
  const stray = prepare({ messages: [{ role: "system", content: "<history>\nUser: I <3 cats\nBot: meow\nUser: 你好呀\n</history>" },
    { role: "user", content: "你好呀" }], router_unicode_input: { user_floor: "你好呀" } });
  assert.equal(stray.payload.messages[0].content, "<history>\nUser: I <3 cats\nBot: meow\nUser: ⟦U:4F60 597D 5440⟧\n</history>");
  assert.equal(stray.metadata.occurrences, 2);
});

test("string parts and text parts match while images and tool/schema definitions are preserved", () => {
  const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
  const tools = [{ type: "function", function: { name: "test", parameters: { type: "object" } } }];
  const payload = { messages: [{ role: "tool", content: [floor, { type: "text", text: floor, extra: 1 }, image] }],
    router_unicode_input: { user_floor: floor }, tools, tool_choice: "auto", response_format: { type: "json_object" } };
  const result = prepare(payload);
  assert.equal(result.metadata.occurrences, 2);
  assert.equal(result.payload.messages[0].content[1].extra, 1);
  assert.equal(result.payload.messages[0].content[2], image);
  assert.equal(result.payload.tools, tools);
  assert.equal(result.payload.response_format, payload.response_format);
});

test("unmatched floor never changes protocol fields, schema, media or escaped text", () => {
  for (const floor of ["lookup", "model", "type", "user", "中"]) {
    const payload = { model: floor, messages: [{ role: "user", content: [{ type: "text", text: String.raw`\u4e2d` },
      { type: "image_url", image_url: { url: "https://example.invalid/" + floor } }] }],
      tools: [{ type: "function", function: { name: floor, parameters: { type: "object", properties: { [floor]: { type: "string" } } } } }],
      response_format: { type: "json_schema", json_schema: { name: floor, schema: { type: "object", properties: { [floor]: { type: "string" } } } } },
      extra_body: { note: floor }, router_unicode_input: { user_floor: floor } };
    const expected = structuredClone(payload); delete expected.router_unicode_input;
    const result = prepare(payload);
    assert.deepEqual(result.payload, expected);
    assert.equal(result.metadata.reason, "floor-not-found");
    assert.equal(result.metadata.method, "chat-floor-match");
  }
});

test("missing/malformed floor errors locally, disabled models strip metadata, expansions are bounded", () => {
  for (const source of [undefined, {}, { user_floor: 1 }, { user_floor: "" }, { user_floor: floor, extra: 1 }]) {
    assert.throws(() => prepare({ ...request(), router_unicode_input: source }), { status: 400, code: "unicode_floor_required" });
  }
  assert.throws(() => prepareUnicodeInput(request(), true, 100), { status: 413, code: "unicode_input_too_large" });
  const ordinary = { model: "ordinary", messages: [] };
  assert.equal(prepareUnicodeInput(ordinary, false, 1).payload, ordinary);
  assert.deepEqual(prepareUnicodeInput({ ...ordinary, router_unicode_input: { user_floor: "private" } }, false, 1).payload, ordinary);
  assert.equal(prepare({ messages: [{ role: "user", content: "123😀" }], router_unicode_input: { user_floor: "123😀" } }).metadata.reason, "no-encodable-text");
  assert.deepEqual(unicodeInputLogFields({ reason: "private", encodedCharacters: "secret", content: "secret" }),
    { unicodeInput: { mode: "compact", reason: "unknown", method: "chat-floor-match", encodedCharacters: 0, matchedMessages: 0, occurrences: 0 } });
});
