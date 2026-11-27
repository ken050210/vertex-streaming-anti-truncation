import { prepareEncodedInput } from "../../src/optimized-input.mjs";

export function prepareOptimizedInput(input, scope, limitBytes, { originalFetch, headers, signal }, format = "optimized") {
  return prepareEncodedInput(input, scope, limitBytes, format, async text => {
    const res = await originalFetch("/api/tokenizers/gemma/encode", {
      method: "POST", headers, signal, body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error("Gemma tokenizer unavailable");
    const { count } = await res.json();
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error("Invalid Gemma count");
    return count;
  }, signal);
}

export const choiceHeader = "x-vertex-encoding-choice";
const journalKey = "vertex-auto-encoding-history";
const formats = { alternate: "隔字 Unicode", table: "高频字表", gbk: "GBK 十六进制" };
const scopes = { current: "当前输入", recent: "最近两条 AI 与当前输入", all: "全部上下文", chat: "聊天楼层及数据库", "except-preset": "全部上下文（排除预设）" };

export function encodingHistory(store) {
  return JSON.parse(store.getItem(journalKey) || "[]");
}

export function recordEncodingChoice(store, format, scope) {
  const random = crypto.getRandomValues(new Uint16Array(3));
  const id = random[0] * 2 ** 32 + random[1] * 65536 + random[2];
  const entry = { id, at: Date.now(), format, scope };
  window.__meowTiming?.encodingChoice?.(id, format, scope);
  store.setItem(journalKey, JSON.stringify([entry, ...encodingHistory(store)].slice(0, 32)));
  return id;
}

export function displayEncodingChoice(entry) {
  return new Date(entry.at).toLocaleString() + " · " + formats[entry.format] + " · " + scopes[entry.scope];
}
