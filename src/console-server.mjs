import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { buildConfig, buildConnectionConfig, publicSettings } from "./config.mjs";
import { createSettingsStore, mergeSettings, SettingsError } from "./settings-store.mjs";
import { createGatewayServer } from "./gateway.mjs";
import { discoverModels } from "./model-discovery.mjs";

const assets = new Map([["/", ["index.html", "text/html"]], ["/app.css", ["app.css", "text/css"]], ["/app.js", ["app.js", "text/javascript"]], ["/favicon.svg", ["favicon.svg", "image/svg+xml"]]]);
const equal = (a, b) => typeof a === "string" && typeof b === "string" && a.length > 0 && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); };
async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) throw new SettingsError("JSON required", 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size <= 2 * 1024 * 1024) chunks.push(chunk); }
  if (size > 2 * 1024 * 1024) throw new SettingsError("Configuration is too large", 413);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new SettingsError("Invalid JSON"); }
}
async function listen(server, port) {
  server.listen(port, "127.0.0.1");
  try { await once(server, "listening"); }
  catch { throw new SettingsError("Port is unavailable; the running service has not been changed", 409); }
}
async function close(server) {
  if (!server?.listening) return;
  await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
}
// Runs work for one browser request and cancels it if the page closes the connection first.
async function whileConnected(res, run) {
  const client = new AbortController();
  const abort = () => { if (!res.writableEnded) client.abort(); };
  res.once("close", abort);
  try { return await run(client.signal); } finally { res.off("close", abort); }
}

export async function createConsole({ store = createSettingsStore(), fetchImpl = fetch, logger = () => {}, autoStart = true } = {}) {
  let saved = await store.load();
  let activeConfig, gateway, gatewayRef, runtimeError = null, busy = false;
  const retired = new Set(), events = [], sessions = new Map();
  const bootstrapToken = saved.settings.gatewayKey ? null : randomBytes(32).toString("hex");
  let failures = 0, blockedUntil = 0;
  const startedAt = Date.now();
  const log = event => { events.unshift(event); if (events.length > 200) events.pop(); logger(event); };
  const makeGateway = config => createGatewayServer(config, { fetchImpl, logger: log });
  const activeRequests = () => (gateway?.gatewayStats().active || 0) + [...retired].reduce((n, s) => n + s.gatewayStats().active, 0);
  function status() {
    return { running: Boolean(gateway?.listening), activeRequests: activeRequests(), error: runtimeError,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), models: activeConfig?.models || [],
      modelAvailability: gateway?.modelAvailability() || [],
      active: activeConfig ? { port: activeConfig.port, projectId: activeConfig.projectId, location: activeConfig.location, authMode: activeConfig.authMode,
        serviceTier: activeConfig.serviceTier, antiTruncation: activeConfig.antiTruncation,
        geminiPromptRetryEnabled: activeConfig.geminiPromptRetry.enabled } : null,
      requests: events.length, successes: events.filter(e => e.status >= 200 && e.status < 300).length,
      restored: events.filter(e => e.antiTruncation?.restored === true).length,
      lastTrafficType: events.find(e => e.trafficType)?.trafficType || null };
  }
  async function start(config = buildConfig(saved.settings)) {
    if (gateway?.listening) return;
    if (server.address()?.port === config.port) throw new SettingsError("Gateway and console must use different ports");
    const ref = { current: config };
    const candidate = makeGateway(() => ref.current);
    await listen(candidate, config.port);
    activeConfig = config; gateway = candidate; gatewayRef = ref; runtimeError = null;
  }
  async function stop() {
    if (activeRequests()) throw new SettingsError("Requests are still running; wait before stopping the gateway", 409);
    await close(gateway); gateway = null; activeConfig = null;
  }
  async function apply(body, sessionId) {
    const latest = await store.load();
    if (body.revision !== latest.revision) throw new SettingsError("Configuration changed; reload before saving", 409);
    const next = mergeSettings(latest.settings, body.settings);
    const config = buildConfig(next);
    if (server.address()?.port === config.port) throw new SettingsError("Gateway and console must use different ports");
    // Bind the replacement first. A port conflict or failed disk write leaves the
    // original listener/configuration intact. Existing streams drain on their snapshot.
    let candidate;
    const ref = { current: config };
    if (!gateway?.listening || activeConfig.port !== config.port) {
      candidate = makeGateway(() => ref.current);
      await listen(candidate, config.port);
    }
    try { saved = await store.save(next, body.revision); }
    catch (error) { candidate?.closeAllConnections(); await close(candidate); throw error; }
    if (candidate) {
      const old = gateway; gateway = candidate; gatewayRef = ref;
      if (old) { retired.add(old); old.close(() => retired.delete(old)); old.closeIdleConnections(); }
    } else gatewayRef.current = config;
    activeConfig = config; runtimeError = null;
    for (const id of sessions.keys()) if (id !== sessionId) sessions.delete(id);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const port = server.address()?.port;
      // Browsers leave the default HTTP port out of Host.
      const hosts = ["127.0.0.1", "localhost"].flatMap(name => port === 80 ? [name, name + ":80"] : [name + ":" + port]);
      if (!hosts.includes(req.headers.host)) throw new SettingsError("Invalid local host", 403);
      const origin = req.headers.origin;
      if ((origin && origin !== "http://" + req.headers.host) || req.headers["sec-fetch-site"] === "cross-site") throw new SettingsError("Cross-origin access denied", 403);
      const path = new URL(req.url, "http://localhost").pathname;
      if (req.method === "GET" && assets.has(path)) {
        const [file, type] = assets.get(path);
        const bytes = await readFile(new URL("../public/" + file, import.meta.url));
        res.writeHead(200, { "content-type": type + "; charset=utf-8" }); return res.end(bytes);
      }
      const sessionId = /(?:^|;\s*)vertex_console=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || "")?.[1];
      for (const [id, session] of sessions) if (session.expires < Date.now()) sessions.delete(id);
      const session = sessions.get(sessionId);
      if (req.method === "GET" && path === "/api/session") return json(res, 200, { authenticated: Boolean(session), setup: !saved.settings.gatewayKey, ...(session ? { csrf: session.csrf } : {}) });
      if (req.method === "POST" && path === "/api/login") {
        if (Date.now() < blockedUntil) throw new SettingsError("Too many attempts; try again in a minute", 429);
        const body = await readJson(req);
        saved = await store.load();
        const expected = saved.settings.gatewayKey || bootstrapToken;
        if (!equal(body?.key, expected)) {
          if (++failures >= 5) { blockedUntil = Date.now() + 60000; failures = 0; }
          throw new SettingsError("Invalid local access key", 401);
        }
        failures = 0;
        const id = randomBytes(32).toString("hex"), csrf = randomBytes(24).toString("hex");
        if (sessions.size >= 16) sessions.delete(sessions.keys().next().value);
        sessions.set(id, { csrf, expires: Date.now() + 8 * 3600000 });
        res.setHeader("set-cookie", `vertex_console=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        return json(res, 200, { csrf });
      }
      if (!session) throw new SettingsError("Please sign in", 401);
      if (req.method === "GET" && path === "/api/config") {
        const current = await store.load();
        return json(res, 200, { settings: publicSettings(current.settings), revision: current.revision, saved: current.saved });
      }
      if (req.method === "GET" && path === "/api/status") return json(res, 200, status());
      if (req.method === "GET" && path === "/api/events") return json(res, 200, { events });
      if (req.method !== "POST") throw new SettingsError("Not found", 404);
      if (!equal(req.headers["x-csrf-token"], session.csrf)) throw new SettingsError("Session verification failed", 403);
      if (path === "/api/logout") {
        sessions.delete(sessionId); res.setHeader("set-cookie", "vertex_console=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
        return json(res, 200, { ok: true });
      }
      const body = await readJson(req);
      if (path === "/api/models/discover") {
        const next = mergeSettings((await store.load()).settings, body.settings, { connectionOnly: true });
        return json(res, 200, await whileConnected(res, signal => discoverModels(buildConnectionConfig(next), { fetchImpl, signal })));
      }
      if (path === "/api/probe") {
        if (body?.confirm !== true) throw new SettingsError("A paid test must be explicitly requested");
        if (!gateway?.listening) throw new SettingsError("Start the gateway first", 409);
        const model = body.model ?? activeConfig.models[0]?.id;
        if (!activeConfig.models.some(m => m.id === model)) throw new SettingsError("Select a saved model before testing");
        return await whileConnected(res, async signal => {
          const upstream = await fetch(`http://127.0.0.1:${activeConfig.port}/v1/chat/completions`, {
            method: "POST", signal,
            headers: { authorization: "Bearer " + activeConfig.gatewayKey, "content-type": "application/json" },
            body: JSON.stringify({ model, messages: [{ role: "user", content: "Write three short lines about a river." }], max_tokens: 512, stream: body.stream === true,
              ...(body.stream === true ? { stream_options: { include_usage: true } } : {}) }),
          });
          res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type"),
            "x-request-id": upstream.headers.get("x-request-id"), "x-anti-truncation-transport": upstream.headers.get("x-anti-truncation-transport") || "unknown" });
          for await (const bytes of upstream.body) if (!res.write(Buffer.from(bytes))) await once(res, "drain", { signal });
          res.end();
        });
      }
      if (!["/api/config", "/api/validate", "/api/start", "/api/stop"].includes(path)) throw new SettingsError("Not found", 404);
      if (busy) throw new SettingsError("Another operation is in progress", 409);
      busy = true;
      try {
        if (path === "/api/config") await apply(body, sessionId);
        if (path === "/api/validate") { mergeSettings((await store.load()).settings, body.settings); return json(res, 200, { valid: true }); }
        if (path === "/api/start") { saved = await store.load(); await start(); }
        if (path === "/api/stop") await stop();
        return json(res, 200, { settings: publicSettings(saved.settings), revision: saved.revision, saved: saved.saved, status: status() });
      } finally { busy = false; }
    } catch (error) {
      if (res.headersSent) res.destroy();
      else json(res, error.status || 400, { error: { message: error.code ? "Local operation failed; check file permissions and port availability" : error.message || "Operation failed" } });
    }
  });
  server.headersTimeout = 10000; server.requestTimeout = 30000;
  return {
    server, bootstrapToken, status,
    async listen(port = 4780) {
      await listen(server, port);
      if (autoStart && saved.settings.gatewayKey) {
        try { await start(); } catch (error) { runtimeError = error.message; }
      }
    },
    async close() {
      for (const s of [gateway, ...retired, server]) { s?.closeAllConnections(); await close(s); }
    },
  };
}
