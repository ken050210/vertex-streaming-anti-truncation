// Compact Unicode and current-floor matching follow Genesis Corridor v0.7.2.
// Match message text only: never substitute serialized protocol fields.
// The client supplies the actual chat floor; assembled messages are not a chat store.
const reasons = new Set(["encoded", "floor-not-found", "no-encodable-text"]);
const methods = new Set(["chat-floor-match"]);
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

export function prepareUnicodeInput(input, enabled, limitBytes) {
  const supplied = Object.hasOwn(input, "router_unicode_input");
  const source = input.router_unicode_input;
  let payload = input;
  // This local extension never goes upstream, even on an ordinary model.
  if (supplied) { payload = { ...input }; delete payload.router_unicode_input; }
  if (!enabled) return { payload, metadata: null };
  if (!source || typeof source !== "object" || Array.isArray(source) ||
      Object.keys(source).some(key => key !== "user_floor") || typeof source.user_floor !== "string" || !source.user_floor.length) {
    throw inputError(400, "unicode_floor_required", "Unicode input requires router_unicode_input.user_floor from the latest real user chat floor");
  }
  const floor = source.user_floor;
  const variants = [...new Set([floor, floor.trim(), floor.replace(/\r\n?/g, "\n")].filter(Boolean))];
  const metadata = { reason: "floor-not-found", method: "chat-floor-match", encodedCharacters: 0, matchedMessages: 0, occurrences: 0 };
  const replaceText = text => {
    let value = String(text ?? "");
    for (const candidate of variants) {
      if (!value.includes(candidate)) continue;
      const encoded = encodeUnicodeText(candidate);
      if (encoded.text === candidate) continue;
      const pieces = value.split(candidate);
      metadata.occurrences += pieces.length - 1;
      metadata.encodedCharacters += (pieces.length - 1) * encoded.count;
      value = pieces.join(encoded.text);
    }
    return value;
  };
  const messages = payload.messages.map(message => {
    if (!message || typeof message !== "object") return message;
    const before = metadata.occurrences;
    const content = typeof message.content === "string" ? replaceText(message.content)
      : Array.isArray(message.content) ? message.content.map(part => typeof part === "string" ? replaceText(part)
        : part?.type === "text" && typeof part.text === "string" ? { ...part, text: replaceText(part.text) } : part)
        : message.content;
    if (metadata.occurrences === before) return message;
    metadata.matchedMessages++;
    return { ...message, content };
  });
  if (metadata.occurrences) payload = { ...payload, messages };
  else if (!encodeUnicodeText(floor).count) metadata.reason = "no-encodable-text";
  if (metadata.occurrences) metadata.reason = "encoded";
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > limitBytes) {
    throw inputError(413, "unicode_input_too_large", "Unicode-encoded request exceeds the configured body limit");
  }
  return { payload, metadata };
}
