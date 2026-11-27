import test from "node:test";
import assert from "node:assert/strict";
import { installChatFloorInput } from "../integrations/sillytavern/chat-floor-input.js";

test("chat-floor encoding follows surviving source marks through reorder, trim and rewriting", async () => {
  const host = {}, receipt = [];
  installChatFloorInput(host, {
    settings: () => ({ unicodeInput: "unicode-chat" }), report: row => receipt.push(row),
    context: () => ({ chat: [{ is_user: false }, { is_user: true }, { is_system: true }], chatCompletionSettings: { chat_completion_source: "vertexai" } }),
  });
  const original = [{ role: "assistant", content: [{ type: "text", text: "同文" }, { type: "image_url", image_url: { url: "image" } }] },
    { role: "user", content: "同文" }, { role: "assistant", content: "同文" }];
  host.bind(original, [{ floor: 0 }, { floor: 1 }, { floor: 2 }]);
  const body = { chat_completion_source: "vertexai", messages: [
    { ...original[1], content: "改写" }, { ...original[1] }, original[2], JSON.parse(JSON.stringify(original[1])), original[0],
    { role: "tool", content: "同文" },
  ] };
  await host.apply(body);
  assert.deepEqual(body.messages.map(m => typeof m.content === "string" ? m.content : m.content[0].text),
    ["改写", "⟦U:540C 6587⟧", "同文", "同文", "⟦U:540C 6587⟧", "同文"]);
  assert.equal(body.messages[4].content[1], original[0].content[1]);
  assert.equal(original[1].content, "同文");
  assert.equal(receipt[0].matchedMessages, 2);
});

test("stored Izumi floors and Meow's final sync preserve the source of the player's action", async t => {
  const action = "推开木门", recorded = "<advice>" + action + "</advice>\n开场";
  const host = {}, api = { chat: [{ is_user: false, mes: recorded }, { is_user: true, mes: action }] };
  installChatFloorInput(host, { settings: () => ({ unicodeInput: "unicode-chat" }), context: () => api, report() {} });
  const prompt = { role: "system", content: "<<<|catgodml|setLastMessage:" + action + ">>>" };
  const body = { chat_completion_source: "vertexai", messages: [{ role: "assistant", content: "开场" }, { role: "user", content: action }, prompt] };
  host.bind(body.messages, [{ floor: 0 }, { floor: 1 }, {}]);
  body.messages[0].content = recorded;
  const signal = new AbortController().signal;
  await host.apply(body, signal);
  assert.match(body.messages[0].content, /^<advice>⟦U:/);
  assert.equal(body.messages[2], prompt);
  const result = { role: "tool", name: "context", tool_call_id: "call_sync_final", content: JSON.stringify({ user_input: action, note: action }) };
  const call = { role: "assistant", tool_calls: [{ id: "call_sync_final", function: { name: "context" } }] };
  const serialized = JSON.stringify({ messages: [call, result], tools: [{ function: { name: "soliumbra_reply" } }] });
  const init = { signal, body: serialized };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://example.test" } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, "location", descriptor) : delete globalThis.location);
  const url = "/api/backends/chat-completions/generate";
  const updated = host.finishFetch(url, init);
  assert.deepEqual(JSON.parse(JSON.parse(updated.body).messages.at(-1).content), { user_input: body.messages[1].content, note: action });
  assert.equal(host.finishFetch(url, updated), updated);
  const other = { signal: new AbortController().signal, body: serialized };
  assert.equal(host.finishFetch(url, other), other);
  assert.equal(host.finishFetch("https://another.test/generate", init), init);
});

test("only the owned span in a mixed world-info slot and the budget's own recall message are encoded", async t => {
  const host = {};
  const previous = globalThis.acuHistoryBudget;
  globalThis.acuHistoryBudget = { databaseInputOwner: async () => entry => entry.uid === 2 };
  t.after(() => { if (previous) globalThis.acuHistoryBudget = previous; else delete globalThis.acuHistoryBudget; });
  installChatFloorInput(host, { settings: () => ({ unicodeInput: "unicode-chat" }), context: () => ({ chat: [] }), report() {} });
  const groups = await host.beginDatabase();
  // Both entries have exactly the same content. Tavern prepends each to the slot.
  groups.collect("worldInfoBefore", { uid: 2, comment: "TavernDB-ACU-ReadableDataTable" }, " 档案 ");
  groups.collect("worldInfoBefore", { uid: 1, comment: "地图" }, " 档案 ");
  const mixed = { role: "system", content: "前文\n 档案 \n 档案 \n后文" };
  const ranges = groups.locate("worldInfoBefore", mixed.content);
  host.bind([mixed], [{ database: ranges }], groups);
  const recall = { role: "system", content: "<历史纪要>档案</历史纪要>" };
  const body = { chat_completion_source: "vertexai", messages: [mixed, { ...mixed, content: "预设档案" }, recall,
    { ...recall, [Symbol.for("acu.budgetRecall")]: true }] };
  await host.apply(body);
  assert.deepEqual(body.messages.map(m => m.content), [
    "前文\n 档案 \n ⟦U:6863 6848⟧ \n后文", "预设档案", recall.content, "<历史纪要>⟦U:6863 6848⟧</历史纪要>",
  ]);
});
