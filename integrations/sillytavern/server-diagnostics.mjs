import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import https from "node:https";
import { DIAGNOSTIC_HEADER, HISTORY_LIMIT, configurationProblem, diagnosticId, networkCodes, pluginFrames, readClientHeader, requestFields, safeCode } from "./diagnostic-fields.js";
import { enumToken } from "../../src/wire.mjs";
import { PLUGIN_ID, PLUGIN_VERSION } from "./shared.js";

const filename = "vertex-anti-truncation-errors.json";
const writes = new Map();
const live = new Map();
const recent = new Map();

export const serverEnvironment = { node: process.versions.node, os: process.platform, arch: process.arch };
export async function identifyServerBuild() {
  const digest = createHash("sha256");
  for (const dir of [new URL("./", import.meta.url), new URL("../../src/", import.meta.url)]) {
    for (const name of (await readdir(dir)).filter(name => /\.(?:mjs|js)$/.test(name)).sort()) {
      digest.update(name).update(await readFile(new URL(name, dir)));
    }
  }
  serverEnvironment.build = digest.digest("hex").slice(0, 12);
}

async function history(file) {
  try {
    const records = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(records)) throw Error("Invalid diagnostic journal");
    return records;
  }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

async function writeFailure(root, record) {
  const file = join(root, filename);
  const previous = writes.get(file) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    const records = await history(file);
    const kept = records.filter(item => item.id !== record.id).slice(0, HISTORY_LIMIT - 1);
    await writeFile(file + ".tmp", JSON.stringify([record, ...kept], null, 2), { mode: 0o600 });
    await rename(file + ".tmp", file);
  });
  writes.set(file, write);
  try { await write; } finally { if (writes.get(file) === write) writes.delete(file); }
}

export function startDiagnostic(request, version, stage = "request") {
  const root = request.user.directories.root;
  const incoming = diagnosticId(request.headers?.[DIAGNOSTIC_HEADER]);
  const id = incoming ?? randomUUID();
  const record = { id, idSource: incoming ? "request" : "server", at: new Date().toISOString(), version, ...serverEnvironment,
    proxyAgent: https.globalAgent.constructor.name === "ProxyAgent", request: requestFields(request.body ?? {}), client: readClientHeader(request.headers),
    stage, timeline: { [stage]: 0 }, attempts: [], bytesSent: 0, state: "pending" };
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  if (root) {
    if (!live.has(root)) live.set(root, new Set());
    live.get(root).add(record);
  }
  return { record, elapsed,
    stage(name) { record.stage = name; record.timeline[name] = elapsed(); },
    async finish(state, error, code, upstream, response) {
      if (record.state !== "pending") return;
      Object.assign(record, { state, elapsedMs: elapsed(), code: safeCode(code),
        httpStatus: response.headersSent ? response.statusCode : undefined });
      if (error) {
        record.network = networkCodes(error);
        record.exception = ["TypeError", "Error", "FetchError", "AbortError", "TimeoutError", "SyntaxError", "AggregateError"].includes(error.name) ? error.name : "Error";
        record.frames = pluginFrames(error);
        if (configurationProblem(error.message)) record.configReason = error.message;
        if (error.oauthStatus) record.oauthStatus = error.oauthStatus;
        if (error.oauthReason) record.oauthReason = error.oauthReason;
        if (error.oauthTimeoutMs) record.oauthTimeoutMs = error.oauthTimeoutMs;
      }
      if (upstream) record.google = { status: enumToken(upstream.status), reason: enumToken(upstream.reason),
        code: upstream.code, blocked: upstream.blockedCategories };
      if (!root) return;
      const active = live.get(root);
      active.delete(record);
      if (!active.size) live.delete(root);
      const records = [record, ...(recent.get(root) ?? []).filter(item => item.id !== id)];
      recent.set(root, records.slice(0, HISTORY_LIMIT));
      if (state === "ok") return;
      try { await writeFailure(root, record); }
      catch (failure) {
        record.storage = "stderr";
        console.error("[vertex-anti-truncation] diagnostic journal unavailable", failure.code ?? "io", JSON.stringify(record));
      }
    },
  };
}

export async function readDiagnostics(request, response) {
  response.setHeader("cache-control", "no-store");
  const root = request.user?.directories?.root;
  if (!root) return response.sendStatus(401);
  let saved = [], storage;
  try { saved = await history(join(root, filename)); }
  catch { storage = "unavailable"; }
  const entries = new Map(saved.map(item => [item.id, item]));
  for (const item of [...recent.get(root) ?? [], ...live.get(root) ?? []]) entries.set(item.id, item);
  return response.json({ id: PLUGIN_ID, version: PLUGIN_VERSION, records: [...entries.values()].sort((a, b) => b.at.localeCompare(a.at)), storage });
}
