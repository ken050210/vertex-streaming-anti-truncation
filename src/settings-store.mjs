import { readFile, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_SETTINGS, SECRET_FIELDS, buildConfig, buildConnectionConfig, settingsFromEnv } from "./config.mjs";
import { modelProfiles } from "./model-profiles.mjs";

export class SettingsError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const revisionOf = text => createHash("sha256").update(text).digest("hex");
const settingNames = new Set(Object.keys(DEFAULT_SETTINGS));

export function mergeSettings(current, patch, { connectionOnly = false } = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some(k => !settingNames.has(k))) throw new SettingsError("Invalid configuration fields");
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (SECRET_FIELDS.includes(key)) {
      if (typeof value !== "string" || value.length > 128 * 1024) throw new SettingsError("Invalid credential field");
      if (value.trim()) next[key] = value.trim().replace(/^\uFEFF/, "");
    } else next[key] = value;
  }
  if (next.authMode === "service-account" && !next.projectId && next.serviceAccountJson) {
    try { next.projectId = JSON.parse(next.serviceAccountJson).project_id || ""; } catch { /* Validated below. */ }
  }
  if (connectionOnly) buildConnectionConfig(next);
  else {
    if (next.models != null) next.models = modelProfiles(next.models);
    buildConfig(next);
  }
  return next;
}

export function createSettingsStore({ directory = process.env.GATEWAY_STATE_DIR || join(homedir(), ".vertex-streaming-anti-truncation"), env = process.env } = {}) {
  const file = join(directory, "settings.json");
  const lock = join(directory, "settings.lock");
  async function load() {
    let raw;
    try { raw = await readFile(file, "utf8"); }
    catch (error) {
      if (error.code !== "ENOENT") throw new SettingsError("Cannot read saved configuration", 500);
      return { settings: await settingsFromEnv(env), revision: "new", saved: false };
    }
    try {
      const data = JSON.parse(raw);
      if (data.version !== 1 || !data.settings || Object.keys(data.settings).some(k => !settingNames.has(k))) throw new Error();
      const settings = { ...DEFAULT_SETTINGS, ...data.settings };
      buildConfig(settings);
      return { settings, revision: revisionOf(raw), saved: true };
    } catch { throw new SettingsError("Saved configuration is invalid; the existing file was preserved", 500); }
  }
  async function acquireLock() {
    try { return await open(lock, "wx", 0o600); }
    catch (error) { if (error.code !== "EEXIST") throw new SettingsError("Cannot lock configuration", 409); }
    // A save holds the lock for milliseconds. An older lock was left by a process
    // that exited mid-save and would otherwise block every later save.
    const age = await stat(lock).then(info => Date.now() - info.mtimeMs, () => Infinity);
    if (age < 60000) throw new SettingsError("Configuration is being edited by another process", 409);
    await unlink(lock).catch(() => {});
    try { return await open(lock, "wx", 0o600); }
    catch { throw new SettingsError("Configuration is being edited by another process", 409); }
  }
  async function save(settings, revision) {
    buildConfig(settings);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const held = await acquireLock();
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
      if ((await load()).revision !== revision) throw new SettingsError("Configuration changed; reload before saving", 409);
      const raw = JSON.stringify({ version: 1, settings }, null, 2) + "\n";
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(raw, "utf8"); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, file);
      return { settings, revision: revisionOf(raw), saved: true };
    } finally {
      await unlink(temporary).catch(() => {});
      await held.close(); await unlink(lock);
    }
  }
  return { load, save, directory };
}
