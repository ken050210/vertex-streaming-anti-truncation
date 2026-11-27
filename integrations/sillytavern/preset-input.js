export const presetFormat = mode => /^(unicode|optimized|alternate|table|gbk)-except-preset$/.exec(mode)?.[1];

// A prompt produced by the preset stays a single source, even if its macros
// expand to a player's exact text. Native slots can contain both kinds of text.
export function presetRanges(value, mark) {
  return mark === true ? [[0, value.length]] : mark || [];
}

export function formattedSlot(value, slot, template, placeholder, protectSlot = false, resolveLiteral) {
  let literals = template.split(placeholder);
  if (literals.length === 1) return !protectSlot;
  if (resolveLiteral) literals = literals.map(resolveLiteral);
  // Tavern expands {{original}} once per card override. Later occurrences are empty.
  if (protectSlot && literals.length > 2) {
    const tail = literals.slice(1).join("");
    literals.splice(1, literals.length - 1, tail);
  }
  // Match the actual substitution, including repeated slots and identical literal
  // text. Additional macro expansion can change boundaries in the rendered prompt.
  if (literals.join(slot) !== value) {
    if (literals.length === 2 && !literals[0] && !literals[1]) return protectSlot;
    return "unknown";
  }
  const ranges = [];
  let offset = 0;
  for (const [i, literal] of literals.entries()) {
    if (!protectSlot && literal) ranges.push([offset, offset + literal.length]);
    offset += literal.length;
    if (i === literals.length - 1) break;
    if (protectSlot && slot) ranges.push([offset, offset + slot.length]);
    offset += slot.length;
  }
  return ranges.length ? ranges : false;
}

export function depthPresetRanges(prompts, joined) {
  if (prompts.some(p => p.presetInput === "unknown")) return "unknown";
  const leading = joined.length - joined.trimStart().length;
  const length = joined.trim().length;
  let offset = -leading;
  const ranges = [];
  for (const prompt of prompts) {
    for (const [start, end] of presetRanges(prompt.content, prompt.presetInput)) {
      const a = Math.max(0, offset + start), b = Math.min(length, offset + end);
      if (a < b) ranges.push([a, b]);
    }
    offset += prompt.content.length + 1;
  }
  return ranges;
}

export function allowedText(value, ranges) {
  const parts = [];
  let start = 0;
  for (const [a, b] of ranges) {
    if (a > start && value.slice(start, a).trim()) parts.push({ start, text: value.slice(start, a) });
    start = b;
  }
  if (start < value.length && value.slice(start).trim()) parts.push({ start, text: value.slice(start) });
  return parts;
}

// The Meow registry stores escaped worldbook blocks between its named sections.
// Limit matches to complete entries in those sections. A copy in the preset's
// rules, in the opening story or in another tool must retain its own origin.
const registrySections = ["初始常驻世界书基线", "常驻深层世界书设定 (@D1+)", "深层指令与设定 (@D0)"];
export function updateMeowWorld(registry, data, entries) {
  if (!entries?.length) return false;
  let changed = false;
  const encoded = new Map(entries);
  for (const key of ["activated_info", "d0_injections", "live_world_state", "live_d0_directives", "memory_briefing"]) {
    if (!Array.isArray(data[key])) continue;
    data[key] = data[key].map(v => {
      if (!encoded.has(v)) return v;
      changed = true;
      return encoded.get(v);
    });
  }
  if (!registry?.content?.startsWith("SoliUmbra World Context Registry.\n")) return changed;
  const escaped = entries.map(pair => pair.map(s => JSON.stringify(s).slice(1, -1)));
  for (const name of registrySections) {
    const marker = "\\n【" + name + "】：\\n";
    const at = registry.content.indexOf(marker);
    if (at < 0 || registry.content.indexOf(marker, at + 1) >= 0) continue;
    let pos = at + marker.length, updated = "";
    // The next section starts after a single escaped newline. Inside a worldbook
    // section separate entries use two. Stop at the first unverified boundary.
    for (;;) {
      const match = escaped.find(([raw]) => registry.content.startsWith(raw, pos) && registry.content.startsWith("\\n", pos + raw.length));
      if (!match) break;
      updated += match[1]; pos += match[0].length; changed = true;
      if (!registry.content.startsWith("\\n\\n", pos)) break;
      updated += "\\n\\n"; pos += 4;
    }
    if (updated) registry.content = registry.content.slice(0, at + marker.length) + updated + registry.content.slice(pos);
  }
  return changed;
}
