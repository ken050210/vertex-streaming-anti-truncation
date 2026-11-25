import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import https from "node:https";
import { DIAGNOSTIC_HEADER, HISTORY_LIMIT, networkCodes, readClientHeader, requestFields, safeCode } from "./diagnostic-fields.js";
import { enumToken } from "../../src/wire.mjs";

const filename = "vertex-anti-truncation-errors.json";
const writes = new Map();
const live = new Map();
const recent = new Map();
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const pluginUrl = new URL("../../", import.meta.url).href;
const configReasons = new Set(["Invalid VERTEX_FALLBACK_LOCATIONS", "Invalid service tier", "Invalid VERTEX_PROJECT_ID", "Invalid VERTEX_LOCATION",
  "Invalid VERTEX_API_KEY", "Express, Flex and Priority require the global location", "Service account must contain a valid RSA private key",
  "vertex service account secret is not valid JSON", "vertex service account secret must contain type, client_email, private_key and an HTTPS token_uri",
  "Only Google's OAuth token endpoint is allowed", "vertex token exchange returned no access_token"]);

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
  const incoming = request.headers?.[DIAGNOSTIC_HEADER];
  const id = typeof incoming === "string" && uuid.test(incoming) ? incoming : randomUUID();
  const record = { id, at: new Date().toISOString(), version, ...serverEnvironment,
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
        record.frames = String(error.stack ?? "").split("\n").filter(line => /^\s*at /.test(line) && line.includes(pluginUrl))
          .map(line => line.split(pluginUrl).at(-1).match(/^((?:src|integrations\/sillytavern)\/[\w-]+\.(?:mjs|js):\d+:\d+)\)?$/)?.[1]).filter(Boolean).slice(0, 4);
        if (configReasons.has(error.message)) record.configReason = error.message;
        if (error.oauthStatus) record.oauthStatus = error.oauthStatus;
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
  return response.json({ records: [...entries.values()].sort((a, b) => b.at.localeCompare(a.at)), storage });
}
