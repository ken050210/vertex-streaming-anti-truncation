import { prepareUnicodeInput } from "../../src/unicode-input.mjs";

const envelopes = /(<vat-reading>[\s\S]*?<\/vat-reading>|<vat-encoded>[\s\S]*?<\/vat-encoded>)/g;
const literals = /<[^<>\n]*>|⟦U:[0-9a-fA-F\s]+⟧|\{\{[^{}\n]*\}\}/g;
const protectedText = new RegExp(envelopes.source + "|" + literals.source, "g");
const tokens = new RegExp(literals.source + "|[\\\\{}]|\\p{Script=Han}+", "gu");
const alternateGuide = "每段连续汉字从首字起隔字写成字面量 Unicode 转义（反斜杠、u、四位十六进制数），原字与转义按顺序连读。两个反斜杠表示一个原文反斜杠。";
const tableGuide = "花括号内每项是一个汉字，空格分隔。小写代号查本次请求共用的字表，十六进制数是 Unicode 码点。标签、双花括号及块外文字照读，反斜杠转义的符号取字面值。";

function characterTable(counts) {
  const ranked = [...counts].sort(([a, n], [b, m]) => m - n || a.codePointAt(0) - b.codePointAt(0)).slice(0, 256);
  const letter = n => String.fromCharCode(97 + n);
  return new Map(ranked.map(([ch], i) => [
    ch, i < 26 ? letter(i) : letter(Math.floor(i / 26) - 1) + letter(i % 26),
  ]));
}

function encodeText(value, counts, table) {
  let count = 0;
  const text = value.split(envelopes).map((part, index) => {
    if (index % 2 || !part) return part;
    const before = count;
    const encoded = part.replace(tokens, token => {
      if (token === "\\" || (table && (token === "{" || token === "}"))) return "\\" + token;
      if (!/^\p{Script=Han}/u.test(token)) return token;
      const chars = Array.from(token);
      if (table) {
        count += chars.length;
        return "{" + chars.map(ch => table.get(ch) ?? ch.codePointAt(0).toString(16).toUpperCase()).join(" ") + "}";
      }
      return chars.map((ch, i) => {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
        if (i % 2) return ch;
        count++;
        // One UTF-16 escape per code unit, including both halves of supplementary Han.
        return ch.split("").map(unit => "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0")).join("");
      }).join("");
    });
    return count === before ? part : "<vat-encoded>" + encoded + "</vat-encoded>";
  }).join("");
  return { text, count };
}

export async function prepareOptimizedInput(input, scope, limitBytes, { originalFetch, headers, signal }) {
  const frequencies = new Map();
  const candidates = [];
  let sizeError;
  for (const format of ["alternate", "table"]) {
    // The first pass counts Han only within the selected scope. Floor copies have the same frequencies.
    const table = format === "table" ? characterTable(frequencies) : null;
    const guide = table ? tableGuide + "\n共用字表\n" + [...table].map(([ch, id]) => id + "=" + ch).join(" ") : alternateGuide;
    const codec = { protectedText, guide: "<vat-reading>\n" + guide + "\n</vat-reading>\n",
      encode: text => encodeText(text, frequencies, table) };
    try {
      const { payload, metadata, fields } = prepareUnicodeInput(input, scope, limitBytes, codec);
      if (!fields.length) return { payload, metadata };
      candidates.push({ payload, metadata: { ...metadata, format }, text: fields.join("\n") });
    } catch (error) {
      if (error.code !== "unicode_input_too_large") throw error;
      sizeError = error; // The other representation may still fit the request body limit.
    }
  }
  if (!candidates.length) throw sizeError;
  let selected = candidates[0], selection = "body-limit";
  if (candidates.length === 2) {
    let costs;
    try {
      costs = await Promise.all(candidates.map(async ({ text }) => {
        const res = await originalFetch("/api/tokenizers/gemma/encode", { method: "POST", headers, signal,
          body: JSON.stringify({ text }) });
        if (!res.ok) throw new Error("Gemma tokenizer unavailable");
        const { count } = await res.json();
        if (!Number.isSafeInteger(count) || count <= 0) throw new Error("Invalid Gemma count");
        return count;
      }));
      selection = "gemma";
    } catch (error) {
      signal?.throwIfAborted();
      if (error.name === "AbortError") throw error;
      // Compare both with the same UTF-8 length estimate when Tavern has no working tokenizer.
      costs = candidates.map(({ text }) => new TextEncoder().encode(text).byteLength);
      selection = "utf8";
    }
    if (costs[1] < costs[0]) selected = candidates[1];
  }
  return { payload: selected.payload, metadata: { ...selected.metadata, selection } };
}
