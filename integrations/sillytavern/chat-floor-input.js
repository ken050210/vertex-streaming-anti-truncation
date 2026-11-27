import { prepareUnicodeInput } from "../../src/unicode-input.mjs";
import { prepareOptimizedInput } from "./optimized-input.js";
import { BODY_LIMIT } from "./shared.js";
import { allowedText, depthPresetRanges, formattedSlot, presetFormat, presetRanges, updateMeowWorld } from "./preset-input.js";

export const chatFloorFormat = mode => /^(unicode|optimized|alternate|table|gbk)-chat$/.exec(mode)?.[1];

// SillyTavern binds the actual history floor before preset and database processing.
// An object spread carries the symbol. JSON serialization never sends it upstream.
const source = Symbol("original chat floor");
const database = Symbol("database entry spans");
const generation = Symbol("activated database entries");
const native = Symbol("Tavern prompt source");
const textShape = content => typeof content === "string" ? content : JSON.stringify(content);

// Group rows in the same order as Tavern's before/after/depth world-info slots.
// Keeping ordinary entries in the group disambiguates even byte-identical neighbors.
function databaseGroups(owns, captureWorld) {
  const groups = new Map(), entries = new Map(), world = new Set();
  return {
    entries, world,
    collect(slot, entry, text) {
      if (captureWorld) {
        const body = text.trim(), name = entry.comment?.trim();
        if (body) world.add(name && !body.startsWith(name) && !body.startsWith("【" + name + "】") ? "【" + name + "】\n" + body : body);
      }
      if (!slot) return;
      if (!groups.has(slot)) groups.set(slot, []);
      const owned = owns?.(entry);
      groups.get(slot).unshift({ text, owned });
      if (owned) entries.set(text.trim(), entry.comment);
    },
    locate(slot, value) {
      const group = groups.get(slot);
      if (!group?.some(e => e.owned) || typeof value !== "string") return [];
      const joined = group.map(e => e.text).join("\n");
      const needle = joined.trim();
      let pos = value.indexOf(needle);
      if (!needle || pos < 0 || value.indexOf(needle, pos + 1) >= 0) return [];
      pos -= joined.length - joined.trimStart().length;
      const ranges = [];
      for (const { text, owned } of group) {
        const start = pos + text.length - text.trimStart().length;
        if (owned && text.trim()) ranges.push({ start, text: text.trim() });
        pos += text.length + 1;
      }
      return ranges;
    },
  };
}

function replaceDatabaseBlocks(value, replacements) {
  let result = "", start = 0;
  while (start < value.length) {
    const found = replacements.find(([raw]) => value.startsWith(raw, start) &&
      (start + raw.length === value.length || value.startsWith("\n\n", start + raw.length)));
    if (found) { result += found[1]; start += found[0].length; }
    const next = value.indexOf("\n\n", start);
    if (next < 0) return result + value.slice(start);
    result += value.slice(start, next + 2);
    start = next + 2;
  }
  return result;
}

export function installChatFloorInput(bridge, { settings, context, report, onEncodingChoice }) {
  if (!bridge) return;
  const syncInputs = new WeakMap();
  bridge.excludesPreset = () => bridge.presetVersion === 1 && Boolean(presetFormat(settings().unicodeInput));
  Object.assign(bridge, { presetRanges, formattedSlot, depthPresetRanges });
  bridge.enabled = () => context().chatCompletionSettings?.chat_completion_source === "vertexai" && (Boolean(chatFloorFormat(settings().unicodeInput)) || bridge.excludesPreset());
  bridge.beginDatabase = async () => {
    const owns = await globalThis.acuHistoryBudget?.databaseInputOwner?.();
    const captureWorld = bridge.excludesPreset();
    return owns || captureWorld ? databaseGroups(owns, captureWorld) : undefined;
  };
  bridge.bind = (messages, records, db) => {
    const chat = context().chat;
    const exclude = bridge.excludesPreset();
    messages.forEach((message, index) => {
      const number = records[index]?.floor;
      if (exclude) message[native] = { role: message.role, content: textShape(message.content), protected: records[index]?.preset, world: db?.world };
      if (db?.entries.size) message[generation] = db.entries;
      if (records[index]?.database?.length) message[database] = { content: message.content, ranges: records[index].database };
      const floor = Number.isInteger(number) && chat[number];
      if (!floor || floor.is_system || message.role !== (floor.is_user ? "user" : "assistant") || !message.content) return;
      message[source] = { number, role: message.role, content: textShape(message.content), saved: floor.mes };
    });
  };
  bridge.apply = async (body, signal, beforeBudget) => {
    const exclude = bridge.excludesPreset();
    const format = exclude ? presetFormat(settings().unicodeInput) : chatFloorFormat(settings().unicodeInput);
    if (body.chat_completion_source !== "vertexai" || !format) return;
    const chat = context().chat;
    const messages = [], floors = [], spans = [], outgoing = body.messages.slice();
    const dbParts = new Map();
    let excluded = 0, mixed = 0, unknown = 0;
    function databasePart(text) {
      if (!dbParts.has(text)) dbParts.set(text, messages.push({ role: "system", content: text }) - 1);
      return dbParts.get(text);
    }
    body.messages.forEach((message, index) => {
      if (exclude) {
        if (!["system", "developer", "assistant", "user"].includes(message?.role) || !message.content) return;
        const origin = message[native], floor = message[source];
        const fromBudget = message[Symbol.for("acu.budgetRecall")] || (beforeBudget && !beforeBudget.has(message));
        if (origin?.protected === true) { excluded++; return; }
        if (origin?.protected === "unknown") { unknown++; return; }
        // Izumi records which player floor it replaced with its own continuation
        // instruction. The same sentence typed by a player has no such receipt.
        const advice = floor?.role === "user" && chat[floor.number]?.extra?.izumi_advice;
        if (advice?.version === 1 && Number.isInteger(advice.assistantId) && advice.text !== advice.replacementText &&
            message.content === advice.replacementText) { excluded++; return; }
        if ((!origin && !fromBudget) || origin && (origin.role !== message.role ||
            origin.content !== textShape(message.content) && !(floor?.saved === message.content && !origin.protected))) { unknown++; return; }
        const protect = origin?.protected;
        if (protect?.length) {
          const parts = typeof message.content === "string" ? allowedText(message.content, protect) : [];
          if (!parts.length) { excluded++; return; }
          mixed++;
          spans.push({ index, ranges: parts.map(r => ({ ...r, part: databasePart(r.text) })) });
        } else {
          floors.push({ index, part: messages.push(message) - 1 });
        }
        return;
      }
      if (message?.[Symbol.for("acu.budgetRecall")] && typeof message.content === "string") {
        spans.push({ index, ranges: [{ start: 0, text: message.content, part: databasePart(message.content) }] });
        return;
      }
      const db = message?.[database];
      if (db && message.content === db.content) {
        spans.push({ index, ranges: db.ranges.map(r => ({ ...r, part: databasePart(r.text) })) });
        return;
      }
      const original = message?.[source];
      if (!original || original.role !== message.role) return;
      // Izumi restores the stored floor (including the player's advice) after assembly.
      if (original.content !== textShape(message.content) && message.content !== original.saved) return;
      floors.push({ index, part: messages.push(message) - 1 });
    });
    try {
      const current = chat.findLast(floor => floor.is_user && !floor.is_system)?.mes;
      const meowSync = signal && current && body.messages.some(m => m.content === "<<<|catgodml|setLastMessage:" + current + ">>>");
      let player = -1;
      const world = new Map();
      if (signal) syncInputs.delete(signal);
      if (meowSync) {
        player = messages.findLastIndex(m => m.role === "user" && m.content === current);
        if (player < 0) player = messages.push({ role: "user", content: current }) - 1;
        for (const text of body.messages.find(m => m?.[generation])?.[generation]?.keys() || []) databasePart(text);
        if (exclude) for (const text of body.messages.find(m => m?.[native])?.[native]?.world || []) world.set(text, databasePart(text));
      }
      const selected = { messages };
      const { payload, metadata } = format === "unicode" ? prepareUnicodeInput(selected, "all", BODY_LIMIT)
        : await prepareOptimizedInput(selected, "all", BODY_LIMIT, { originalFetch: window.fetch.bind(window), headers: context().getRequestHeaders(), signal }, format);
      const choice = format === "optimized" && metadata.format
        ? onEncodingChoice?.(metadata.format, exclude ? "except-preset" : "chat") : undefined;
      const guide = payload.messages.flatMap(m => Array.isArray(m.content) ? m.content.map(p => p?.text ?? p) : [m.content])
        .find(t => typeof t === "string" && t.startsWith("<vat-reading>"))?.match(/^<vat-reading>[\s\S]*?<\/vat-reading>\n/)?.[0] || "";
      const encodedPart = part => {
        const value = payload.messages[part].content;
        return guide && value.startsWith(guide) && !messages[part].content.startsWith(guide) ? value.slice(guide.length) : value;
      };
      for (const { index, part } of floors) outgoing[index] = payload.messages[part];
      for (const { index, ranges } of spans) {
        let value = outgoing[index].content;
        for (let i = ranges.length - 1; i >= 0; i--) {
          const r = ranges[i];
          value = value.slice(0, r.start) + encodedPart(r.part) + value.slice(r.start + r.text.length);
        }
        outgoing[index] = { ...outgoing[index], content: value };
      }
      if (guide && spans.length && !outgoing.some(m => typeof m.content === "string" ? m.content.includes(guide) : Array.isArray(m.content) && m.content.some(p => (p?.text ?? p)?.includes?.(guide)))) {
        const first = spans.find(s => outgoing[s.index].content !== body.messages[s.index].content);
        if (first) outgoing[first.index].content = guide + outgoing[first.index].content;
      }
      if (new TextEncoder().encode(JSON.stringify({ ...body, messages: outgoing })).byteLength > BODY_LIMIT) {
        throw Object.assign(new Error("聊天楼层转码后请求超过 8 MiB"), { code: "unicode_input_too_large" });
      }
      body.messages = outgoing;
      if (player >= 0) {
        const sources = outgoing.find(m => m?.[generation])?.[generation];
        const replacements = [...dbParts].map(([raw, part]) => [raw, encodedPart(part)]).filter(([a, b]) => a !== b).sort(([a], [b]) => b.length - a.length);
        const db = exclude ? replacements.filter(([raw]) => sources?.has(raw)) : replacements;
        const syncGuide = guide || (exclude && format === "unicode" ? "<vat-reading>⟦U:…⟧ 内是空格分隔的 Unicode 十六进制码点，按原文阅读；正常书写回复。</vat-reading>\n" : "");
        syncInputs.set(signal, { current, encoded: encodedPart(player), guide: syncGuide, world: [...world].map(([raw, p]) => [raw, encodedPart(p)]).filter(([raw, value]) => raw !== value),
          database: db, archive: db.filter(([raw]) => /(?:TavernDB-ACU-(?:OutlineTable|PersonsHeader|ImportantPersonsIndex|CustomExport-(?:重要角色表|重要人物表|大总结))|重要人物条目\d+$)/.test(sources?.get(raw) || "")) });
      }
      if (exclude) report({ format: metadata.format, excludePreset: true, excluded, mixed, unknown,
        matchedMessages: floors.filter(f => payload.messages[f.part] !== messages[f.part]).length + spans.filter(s => s.ranges.some(r => encodedPart(r.part) !== r.text)).length });
      else report({ ...metadata, selected: floors.length, matchedMessages: floors.filter(f => payload.messages[f.part] !== messages[f.part]).length,
        databaseParts: spans.reduce((n, s) => n + s.ranges.filter(r => encodedPart(r.part) !== r.text).length, 0) });
      return choice;
    } catch (error) {
      report({ error: error.code || error.message });
      throw error;
    }
  };
  // Meow reconstructs the final context tool result inside its fetch wrapper.
  // Match the two named context calls and this dispatch's confirmed sources.
  bridge.finishFetch = (input, init) => {
    const item = syncInputs.get(init?.signal);
    if (!item || typeof init.body !== "string") return init;
    const url = new URL(input instanceof Request ? input.url : input, location.origin);
    if (url.origin !== location.origin || !url.pathname.endsWith("/generate")) return init;
    let body;
    try { body = JSON.parse(init.body); } catch { return init; }
    const result = body.messages?.at(-1), call = body.messages?.at(-2)?.tool_calls?.[0];
    if (result?.role !== "tool" || result.name !== "context" || result.tool_call_id !== "call_sync_final" ||
        call?.id !== result.tool_call_id || call.function?.name !== "context" ||
        !body.tools?.some(t => t.function?.name === "soliumbra_reply")) return init;
    let data;
    try { data = JSON.parse(result.content); } catch { return init; }
    if (!data || typeof data !== "object") return init;
    let changed = false;
    if (data.user_input === item.current && item.encoded !== item.current) { data.user_input = item.encoded; changed = true; }
    // Meow rebuilds this field from activated (raw) world entries. Preserve the
    // containing tool JSON and replace only complete entries verified by their owner.
    if (Array.isArray(data.database_state)) data.database_state = data.database_state.map(value => {
      if (typeof value !== "string") return value;
      const updated = replaceDatabaseBlocks(value, item.database);
      if (updated !== value) changed = true;
      return updated;
    });
    const registry = body.messages.find((m, i, all) => m.role === "tool" && m.name === "context" && m.tool_call_id === "call_init_context_00" &&
      all[i - 1]?.tool_calls?.some(c => c.id === m.tool_call_id && c.function?.name === "context"));
    if (updateMeowWorld(registry, data, item.world)) changed = true;
    const heading = "\\n【前情场记状态归档】：\\n";
    if (item.archive.length && registry?.content?.startsWith("SoliUmbra World Context Registry.\n")) {
      const at = registry.content.indexOf(heading);
      // The database archive is the first block; ordinary archives follow it.
      if (at >= 0 && registry.content.indexOf(heading, at + 1) < 0) {
        let pos = at + heading.length, prefix = registry.content.slice(0, pos);
        const remaining = item.archive.map(pair => pair.map(s => JSON.stringify(s).slice(1, -1)));
        while (remaining.length) {
          const i = remaining.findIndex(([raw]) => registry.content.startsWith(raw, pos) && registry.content.startsWith("\\n", pos + raw.length));
          if (i < 0) break;
          const [raw, encoded] = remaining.splice(i, 1)[0];
          prefix += encoded; pos += raw.length; changed = true;
          if (!registry.content.startsWith("\\n\\n", pos)) break;
          prefix += "\\n\\n"; pos += 4;
        }
        registry.content = prefix + registry.content.slice(pos);
      }
    }
    if (!changed) return init;
    if (item.guide && !init.body.includes("<vat-reading>")) {
      if (typeof data.user_input === "string") data.user_input = item.guide + data.user_input;
      else if (data.database_state?.length) data.database_state[0] = item.guide + data.database_state[0];
    }
    result.content = JSON.stringify(data);
    const serialized = JSON.stringify(body);
    if (new TextEncoder().encode(serialized).byteLength > BODY_LIMIT) throw new Error("聊天楼层转码后请求超过 8 MiB");
    return { ...init, body: serialized };
  };
}
