// Compact Unicode and current-floor matching follow the encoder by 灰鸠「GoldRush」 (see NOTICE.md).
// Match message text only: never substitute serialized protocol fields.
// The client supplies the actual chat floor; assembled messages are not a chat store.
const reasons = new Set(["encoded", "floor-not-found", "no-encodable-text"]);
const methods = new Set(["chat-floor-match", "recent-floors", "all-context"]);
const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function unicodeInputLogFields(value) {
  if (!value) return {};
  return { unicodeInput: { mode: "compact", reason: reasons.has(value.reason) ? value.reason : "unknown",
    method: methods.has(value.method) ? value.method : "chat-floor-match",
    encodedCharacters: counter(value.encodedCharacters), matchedMessages: counter(value.matchedMessages),
    occurrences: counter(value.occurrences) } };
}

export function encodeUnicodeText(value) {
  let count = 0;
  const encoded = String(value ?? "").split(/(<[^>]*>|⟦U:[0-9a-fA-F\s]+⟧)/g).map(part => {
    if (!part || /^<[^>]*>$/.test(part) || /^⟦U:/.test(part)) return part;
    let result = "", codes = [];
    const flush = () => { if (codes.length) result += `⟦U:${codes.join(" ")}⟧`; codes = []; };
    for (const character of part) {
      const point = character.codePointAt(0);
      const han = (point >= 0x3400 && point <= 0x4DBF) || (point >= 0x4E00 && point <= 0x9FFF) ||
        (point >= 0xF900 && point <= 0xFAFF) || (point >= 0x20000 && point <= 0x2EBEF) || (point >= 0x30000 && point <= 0x323AF);
      if (/^[A-Za-z]$/.test(character) || han) { codes.push(point.toString(16).toUpperCase()); count++; }
      else { flush(); result += character; }
    }
    flush();
    return result;
  }).join("");
  return { text: encoded, count };
}

function inputError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export function prepareUnicodeInput(input, enabled, limitBytes, codec) {
  const supplied = Object.hasOwn(input, "router_unicode_input");
  const source = input.router_unicode_input;
  let payload = input;
  // This local extension never goes upstream, even on an ordinary model.
  if (supplied) { payload = { ...input }; delete payload.router_unicode_input; }
  if (!enabled) return { payload, metadata: null };
  const encode = codec?.encode ?? encodeUnicodeText;
  const all = enabled === "all";
  const recent = enabled === "recent";
  if (!all && (!source || typeof source !== "object" || Array.isArray(source) ||
      Object.keys(source).some(key => key !== "user_floor" && !(recent && key === "ai_floors")) || typeof source.user_floor !== "string" || (!recent && !source.user_floor.length))) {
    throw inputError(400, "unicode_floor_required", "Unicode input requires router_unicode_input.user_floor from the latest real user chat floor");
  }
  const floor = all ? "" : source.user_floor;
  // Longest form first, so at one position the original wins over its trimmed copy.
  const floorVariants = floor => [...new Set([floor, floor.trim(), floor.replace(/\r\n?/g, "\n")].filter(Boolean))]
    .map(text => ({ text, encoded: encode(text) })).filter(variant => variant.encoded.count)
    .sort((left, right) => right.text.length - left.text.length);
  const userVariants = floorVariants(floor);
  const aiMatches = new Map();
  if (recent) {
    // Presets may put several floors in one message. Walk the outgoing text backwards
    // so equal replies in older history don't get encoded along with the selected two.
    let lastMessage = payload.messages.length - 1, lastPart = Infinity, end = Infinity;
    for (const aiFloor of source.ai_floors.slice(-2).reverse()) {
      if (typeof aiFloor !== "string" || !aiFloor.trim()) continue;
      const variants = floorVariants(aiFloor);
      search: for (let i = lastMessage; i >= 0; i--) {
        const message = payload.messages[i];
        if (!["assistant", "user", "system", "developer"].includes(message?.role)) continue;
        const parts = Array.isArray(message.content) ? message.content : [message.content];
        for (let j = Math.min(parts.length - 1, i === lastMessage ? lastPart : Infinity); j >= 0; j--) {
          const part = parts[j];
          const value = typeof part === "string" ? part : part?.type === "text" ? part.text : null;
          if (typeof value !== "string") continue;
          const stop = i === lastMessage && j === lastPart ? end : value.length;
          let match;
          for (const variant of variants) {
            if (variant.text.length > stop) continue;
            const at = value.lastIndexOf(variant.text, stop - variant.text.length);
            if (at >= 0 && (!match || at + variant.text.length > match.at + match.text.length)) match = { ...variant, at };
          }
          if (!match) continue;
          const key = i + "/" + j;
          aiMatches.set(key, [...(aiMatches.get(key) ?? []), match]);
          lastMessage = i;
          lastPart = j;
          end = match.at;
          break search;
        }
      }
    }
  }
  const metadata = { reason: all ? "no-encodable-text" : "floor-not-found", method: all ? "all-context" : recent ? "recent-floors" : "chat-floor-match", encodedCharacters: 0, matchedMessages: 0, occurrences: 0 };
  // One left-to-right pass, so an inserted block is never matched again. Unlike the
  // reference, a match that lies inside a tag or an existing ⟦U:…⟧ block of the
  // surrounding text (a preset's <剧情> tag, say) is left unchanged. A tag here
  // cannot contain another "<" or a newline, so a stray "<3" protects nothing.
  const replaceText = (text, variants) => {
    const value = String(text ?? "");
    if (all) {
      const encoded = encode(value);
      if (encoded.count) {
        metadata.occurrences++;
        metadata.encodedCharacters += encoded.count;
      }
      return encoded.text;
    }
    if (!variants.some(variant => value.includes(variant.text))) return value;
    const protectedText = codec?.protectedText ?? /<[^<>\n]*>|⟦U:[0-9a-fA-F\s]+⟧/g;
    const spans = [...value.matchAll(protectedText)].map(match => [match.index, match.index + match[0].length]);
    const isProtected = (at, length) => {
      let low = 0, high = spans.length;
      while (low < high) { const mid = (low + high) >> 1; if (spans[mid][0] <= at) low = mid + 1; else high = mid; }
      return low > 0 && at + length <= spans[low - 1][1];
    };
    const find = (variant, from) => {
      if (variant.at !== undefined) return variant.at >= from && !isProtected(variant.at, variant.text.length) ? variant.at : -1;
      let at = value.indexOf(variant.text, from);
      while (at >= 0 && isProtected(at, variant.text.length)) at = value.indexOf(variant.text, at + 1);
      return at;
    };
    const next = variants.map(variant => find(variant, 0));
    let result = "", from = 0;
    for (;;) {
      let best = -1;
      for (const [index, at] of next.entries()) if (at >= 0 && (best < 0 || at < next[best])) best = index;
      if (best < 0) break;
      const { text: match, encoded } = variants[best];
      result += value.slice(from, next[best]) + encoded.text;
      from = next[best] + match.length;
      metadata.occurrences++;
      metadata.encodedCharacters += encoded.count;
      for (const [index, at] of next.entries()) if (at >= 0 && at < from) next[index] = find(variants[index], from);
    }
    return result + value.slice(from);
  };
  // Compare candidate costs on the changed fields, including the shared reading guide once.
  const fields = [];
  const transformField = (text, index, part = 0) => {
    const ai = recent && aiMatches.get(index + "/" + part);
    const variants = ai ? [...ai, ...userVariants].sort((a, b) => b.text.length - a.text.length) : userVariants;
    const before = metadata.occurrences;
    const result = replaceText(text, variants);
    if (!codec || before === metadata.occurrences) return result;
    const field = fields.length ? result : codec.guide + result;
    fields.push(field);
    return field;
  };
  const messages = payload.messages.map((message, index) => {
    if (!message || typeof message !== "object") return message;
    // A tool result may itself be structured JSON consumed by another tool.
    if ((all || recent || codec) && !["system", "developer", "user", "assistant"].includes(message.role)) return message;
    const before = metadata.occurrences;
    const content = typeof message.content === "string" ? transformField(message.content, index)
      : Array.isArray(message.content) ? message.content.map((part, j) => typeof part === "string" ? transformField(part, index, j)
        : part?.type === "text" && typeof part.text === "string" ? { ...part, text: transformField(part.text, index, j) } : part)
        : message.content;
    if (metadata.occurrences === before) return message;
    metadata.matchedMessages++;
    return { ...message, content };
  });
  if (metadata.occurrences) payload = { ...payload, messages };
  else if (!all && !userVariants.length && !source.ai_floors?.some(Boolean)) metadata.reason = "no-encodable-text";
  if (metadata.occurrences) metadata.reason = "encoded";
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > limitBytes) {
    throw inputError(413, "unicode_input_too_large", "Unicode-encoded request exceeds the configured body limit");
  }
  return codec ? { payload, metadata, fields } : { payload, metadata };
}
