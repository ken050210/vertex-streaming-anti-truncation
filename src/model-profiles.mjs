export const MODEL_ID = "gemini-3.7-flash-antitruncation";
export const UPSTREAM_MODEL = "google/gemini-3.7-flash";
export const MODEL_MODES = Object.freeze(["normal", "buffered", "streaming"]);

export function normalizeUpstreamModel(value) {
  if (typeof value !== "string") throw new Error("Invalid upstream Gemini model ID");
  const id = value.trim().replace(/^(?:google\/|publishers\/google\/models\/)/, "");
  if (!/^gemini-[a-z0-9][a-z0-9._-]{0,126}(?:@[a-z0-9-]{1,32})?$/.test(id) || id.includes("..")) throw new Error("Invalid upstream Gemini model ID");
  return "google/" + id;
}

// Missing profiles are legacy settings, not an empty model list. Keep the old
// public ID and its selected behavior when upgrading an existing installation.
export function modelProfiles(value, legacyEnabled = true) {
  if (value === undefined || value === null) return [{ id: MODEL_ID, upstreamModel: UPSTREAM_MODEL, mode: legacyEnabled ? "streaming" : "normal" }];
  if (!Array.isArray(value) || value.length > 100) throw new Error("Model list must contain at most 100 entries");
  const ids = new Set();
  return value.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some(k => !["id", "upstreamModel", "mode", "enabled"].includes(k))) throw new Error("Invalid model profile");
    if (row.enabled !== undefined && typeof row.enabled !== "boolean") throw new Error("Invalid model enabled setting");
    if (typeof row.id !== "string" || !/^[\p{L}\p{N}][\p{L}\p{N}._@-]{0,159}$/u.test(row.id)) throw new Error("Invalid public model ID");
    if (ids.has(row.id)) throw new Error("Model IDs must be unique");
    ids.add(row.id);
    if (!MODEL_MODES.includes(row.mode)) throw new Error("Invalid model mode");
    return { id: row.id, upstreamModel: normalizeUpstreamModel(row.upstreamModel), mode: row.mode,
      ...(row.enabled !== undefined ? { enabled: row.enabled } : {}) };
  });
}
