import { prepareUnicodeInput } from "./unicode-input.mjs";

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

function encodeText(value, counts, table, gbk) {
  let count = 0;
  const text = value.split(envelopes).map((part, index) => {
    if (index % 2 || !part) return part;
    const before = count;
    const encoded = part.replace(tokens, token => {
      if (token === "\\" || ((table || gbk) && (token === "{" || token === "}"))) return "\\" + token;
      if (!/^\p{Script=Han}/u.test(token)) return token;
      const chars = Array.from(token);
      if (gbk) {
        let hex = "", result = "";
        for (const ch of chars) {
          const code = gbk.get(ch);
          if (code) { hex += code; count++; }
          else { if (hex) result += "{" + hex + "}"; hex = ""; result += ch; }
        }
        return result + (hex ? "{" + hex + "}" : "");
      }
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

// TextEncoder only supports UTF-8. Invert the platform's GBK decoder once on first use.
let gbkCodes;
function gbkMap() {
  if (gbkCodes) return gbkCodes;
  const decoder = new TextDecoder("gbk"), codes = new Map(), pair = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    pair[0] = lead;
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      pair[1] = trail;
      const ch = decoder.decode(pair);
      if (/^\p{Script=Han}$/u.test(ch) && !codes.has(ch)) codes.set(ch, ((lead << 8) | trail).toString(16).toUpperCase());
    }
  }
  gbkCodes = codes;
  return codes;
}

const gbkGuide = "花括号内每四位十六进制数是一个汉字的 GBK 双字节编码。其他文字照读，反斜杠转义的符号取字面值。";

export function inputEncodingMode(value) {
  if (typeof value !== "string") return null;
  return /^(optimized|alternate|table|gbk)(?:-(recent|all))?$/.exec(value);
}

export async function prepareEncodedInput(input, scope, limitBytes, method, countTokens, signal) {
  const frequencies = new Map(), candidates = [];
  let sizeError, unchanged;
  // The alternate pass also collects character frequencies for the table.
  const formats = method === "optimized" ? ["alternate", "table", "gbk"] : method === "table" ? ["alternate", "table"] : [method];
  for (const format of formats) {
    const table = format === "table" ? characterTable(frequencies) : null;
    const gbk = format === "gbk" ? gbkMap() : null;
    const guide = table ? tableGuide + "\n共用字表\n" + [...table].map(([ch, id]) => id + "=" + ch).join(" ") : gbk ? gbkGuide : alternateGuide;
    const codec = { protectedText, guide: "<vat-reading>\n" + guide + "\n</vat-reading>\n",
      encode: text => encodeText(text, frequencies, table, gbk) };
    try {
      const { payload, metadata, fields } = prepareUnicodeInput(input, scope, limitBytes, codec);
      if (method === "table" && format === "alternate") continue;
      if (fields.length) candidates.push({ payload, metadata: { ...metadata, format } });
      else unchanged = { payload, metadata };
    } catch (error) {
      if (error.code !== "unicode_input_too_large") throw error;
      sizeError = error;
    }
  }
  if (!candidates.length) {
    if (sizeError) throw sizeError;
    return unchanged;
  }
  let selected = candidates[0], selection = method === "optimized" ? "body-limit" : "manual";
  if (candidates.length > 1) {
    let best = Infinity;
    try {
      // Count sequentially: Tavern may still be loading the tokenizer on the first call.
      for (const candidate of candidates) {
        // A GBK candidate can leave an entire rare-Han message unchanged.
        // Compare the same message positions for every candidate.
        const text = candidate.payload.messages.flatMap((m, index) => {
          if (candidates.every(c => c.payload.messages[index] === input.messages[index])) return [];
          if (typeof m.content === "string") return [m.content];
          return m.content.flatMap(p => typeof p === "string" ? [p] : p?.type === "text" ? [p.text] : []);
        }).join("\n");
        const cost = await countTokens(text);
        if (cost < best) { best = cost; selected = candidate; }
      }
    } catch (cause) {
      signal?.throwIfAborted();
      throw Object.assign(new Error("Gemma token counting failed", { cause }), { code: "input_tokenizer_unavailable", status: 503 });
    }
    selection = "gemma";
  }
  return { payload: selected.payload, metadata: { ...selected.metadata, selection } };
}
