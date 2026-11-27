import assert from "node:assert/strict";
import test from "node:test";
import { installChatFloorInput } from "../integrations/sillytavern/chat-floor-input.js";
import { depthPresetRanges, formattedSlot, updateMeowWorld } from "../integrations/sillytavern/preset-input.js";

test("preset ownership follows real slots through identical literals, repetitions and mixed depth", async () => {
  const slot = "甲", template = "甲{0}乙{0}甲", value = "甲甲乙甲甲";
  const host = { presetVersion: 1 }, receipts = [];
  const chat = [{ is_user: true, mes: slot }];
  installChatFloorInput(host, { settings: () => ({ unicodeInput: "unicode-except-preset" }),
    context: () => ({ chat, chatCompletionSettings: { chat_completion_source: "vertexai" } }), report: r => receipts.push(r) });
  const mixed = formattedSlot(value, slot, template, "{0}");
  const ambiguous = formattedSlot("甲甲", slot, "{{variable}}{0}", "{0}");
  const depth = depthPresetRanges([{ content: "   甲", presetInput: true }, { content: slot }], "   甲\n甲");
  const media = { type: "image_url", image_url: { url: "image" } };
  const body = { chat_completion_source: "vertexai", messages: [
    { role: "user", content: slot }, { role: "user", content: slot },
    { role: "system", content: value }, { role: "system", content: "甲甲" },
    { role: "system", content: "甲\n甲" }, { role: "user", content: [{ type: "text", text: slot }, media] },
    { role: "assistant", content: "甲甲乙甲" },
  ] };
  host.bind(body.messages, [{ preset: true }, { floor: 0 }, { preset: mixed },
    { preset: ambiguous }, { preset: depth }, {}, { preset: formattedSlot("甲甲乙甲", slot, "甲{{original}}乙{{original}}甲", "{{original}}", true) }]);
  body.messages.push({ role: "system", content: slot });
  await host.apply(body);
  const encoded = "⟦U:7532⟧";
  assert.deepEqual(body.messages.map(m => m.content), [
    slot, encoded, "甲" + encoded + "乙" + encoded + "甲", "甲甲", "甲\n" + encoded,
    [{ type: "text", text: encoded }, media], encoded + "甲⟦U:4E59 7532⟧", slot,
  ]);
  assert.equal(receipts[0].unknown, 2);
  assert.equal(receipts[0].excluded, 1);
});

test("Meow changes only whole owned entries inside recognized worldbook sections", () => {
  const prefix = "SoliUmbra World Context Registry.\n";
  const marker = "\\n【初始常驻世界书基线】：\\n";
  const end = "\\n【其他段落】：\\n";
  const registry = { content: prefix + "甲" + marker + "甲\\n\\n乙" + end + "甲" };
  const data = { activated_info: ["甲", "甲甲"], unknown_field: ["甲"] };
  assert.equal(updateMeowWorld(registry, data, [["甲", "A"], ["乙", "B"]]), true);
  assert.equal(registry.content, prefix + "甲" + marker + "A\\n\\nB" + end + "甲");
  assert.deepEqual(data, { activated_info: ["A", "甲甲"], unknown_field: ["甲"] });
  registry.content += marker + "甲" + end;
  const ambiguous = registry.content;
  assert.equal(updateMeowWorld(registry, {}, [["甲", "A"]]), false);
  assert.equal(registry.content, ambiguous);
});
