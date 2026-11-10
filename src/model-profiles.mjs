export const MODEL_ID = "gemini-3.7-flash-antitruncation";
export const UPSTREAM_MODEL = "google/gemini-3.7-flash";
const MODEL_MODES = Object.freeze(["normal", "buffered", "streaming"]);

export function normalizeUpstreamModel(value) {
  if (typeof value !== "string") throw new Error("Invalid upstream Gemini model ID");
  const id = value.trim().replace(/^(?:google\/|publishers\/google\/models\/)/, "");
  if (!/^gemini-[a-z0-9][a-z0-9._-]{0,126}(?:@[a-z0-9-]{1,32})?$/.test(id) || id.includes("..")) throw new Error("Invalid upstream Gemini model ID");
  return "google/" + id;
}

// Relays name models in their own ways, so a custom upstream gets the name exactly as written.
// It only travels in the JSON body, never in a URL.
export function customUpstreamModel(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Invalid custom upstream model name");
  return name;
}

// The Gemini model a free-form name refers to, for model-specific handling only; "" when none.
export const geminiModelKey = name => /gemini-[a-z0-9][a-z0-9._-]*/i.exec(name)?.[0].toLowerCase() ?? "";

// Missing profiles are legacy settings, not an empty model list. Keep the old
// public ID and its selected behavior when upgrading an existing installation.
export function modelProfiles(value, legacyEnabled = true, { custom = false } = {}) {
  if (value == null) {
    const legacy = { id: MODEL_ID, upstreamModel: custom ? UPSTREAM_MODEL.slice("google/".length) : UPSTREAM_MODEL,
      mode: legacyEnabled ? "streaming" : "normal" };
    if (custom) return [legacy];
    const upstreamModel = "google/gemini-4-carbon";
    const defaults = [legacy, { id: "gemini-4-carbon", upstreamModel, mode: "normal" }];
    if (legacyEnabled) defaults.push(
      { id: "gemini-4-carbon-antitruncation-nonstream", upstreamModel, mode: "buffered" },
      { id: "gemini-4-carbon-antitruncation-stream", upstreamModel, mode: "streaming" });
    return defaults;
  }
  if (!Array.isArray(value) || value.length > 100) throw new Error("Model list must contain at most 100 entries");
  const ids = new Set();
  return value.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some(k => !["id", "upstreamModel", "mode", "enabled"].includes(k))) throw new Error("Invalid model profile");
    if (row.enabled !== undefined && typeof row.enabled !== "boolean") throw new Error("Invalid model enabled setting");
    if (typeof row.id !== "string" || !/^[\p{L}\p{N}][\p{L}\p{N}._@-]{0,159}$/u.test(row.id)) throw new Error("Invalid public model ID");
    if (ids.has(row.id)) throw new Error("Model IDs must be unique");
    ids.add(row.id);
    if (!MODEL_MODES.includes(row.mode)) throw new Error("Invalid model mode");
    return { id: row.id, upstreamModel: custom ? customUpstreamModel(row.upstreamModel) : normalizeUpstreamModel(row.upstreamModel), mode: row.mode,
      ...(row.enabled !== undefined ? { enabled: row.enabled } : {}) };
  });
}
