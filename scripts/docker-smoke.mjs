// Isolated Compose acceptance test. Synthetic credentials only; no generation or
// discovery endpoints are called. Build the local image before running this script.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const image = process.env.DOCKER_TEST_IMAGE || "vertex-streaming-anti-truncation:local";
const project = "vertex-docker-test-" + randomUUID().slice(0, 8);
const temporary = await mkdtemp(join(tmpdir(), project + "-"));
const docker = async args => (await execute("docker", args, { cwd: root, timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, DOCKER_BIND_IP: "127.0.0.1", CONSOLE_PORT: String(consolePort), GATEWAY_PORT: String(gatewayPort),
    GUI_ORIGIN: base, GATEWAY_PUBLIC_URL: apiBase + "/v1" },
})).stdout.trim();
const args = ["compose", "--project-directory", root, "--env-file", join(temporary, ".env"), "-p", project,
  "-f", join(root, "compose.yaml"), "-f", join(temporary, "override.json")];
const compose = (...extra) => docker([...args, ...extra]);
async function freePort() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function ready(url) {
  const deadline = Date.now() + 30000;
  let lastError;
  while (Date.now() < deadline) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; lastError = "HTTP " + response.status; }
    catch (error) { lastError = error.cause?.code || error.message; }
    await delay(250);
  }
  throw new Error("Container did not become ready: " + lastError);
}
const consolePort = await freePort();
let gatewayPort = await freePort();
while (gatewayPort === consolePort) gatewayPort = await freePort();
const base = `http://127.0.0.1:${consolePort}`, apiBase = `http://127.0.0.1:${gatewayPort}`;
const gatewayKey = "docker-fixture-gateway-key";
let cookie, csrf;
async function api(path, body) {
  return fetch(base + path, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(5000),
    headers: { "content-type": "application/json", origin: base, ...(cookie ? { cookie, "x-csrf-token": csrf } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function login(key) {
  const response = await api("/api/login", { key }); assert.equal(response.status, 200);
  cookie = response.headers.get("set-cookie").split(";")[0]; csrf = (await response.json()).csrf;
}
try {
  await writeFile(join(temporary, ".env"), `DOCKER_BIND_IP=127.0.0.1\nCONSOLE_PORT=${consolePort}\nGATEWAY_PORT=${gatewayPort}\nGUI_ORIGIN=${base}\nGATEWAY_PUBLIC_URL=${apiBase}/v1\n`);
  await writeFile(join(temporary, "override.json"), JSON.stringify({ services: { "vertex-gateway": {
    image, restart: "no", healthcheck: { interval: "1s", start_period: "1s" },
  } } }));
  await compose("config", "--quiet");
  await compose("up", "-d", "--no-build");
  await ready(base + "/api/session");
  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal((await api("/api/config")).status, 401);
  const badHost = await new Promise((resolve, reject) => {
    const request = http.get(base + "/api/session", { headers: { host: "evil.example", "x-forwarded-host": new URL(base).host } }, response => {
      response.resume(); resolve(response.statusCode);
    }); request.on("error", reject);
  });
  assert.equal(badHost, 403);
  assert.equal((await fetch(base + "/api/session", { headers: { origin: "https://evil.example" } })).status, 403);
  const token = /#setup=([a-f0-9]+)/.exec(await compose("logs", "--no-color"))?.[1];
  assert.ok(token, "fresh volume supplies a bootstrap link");
  await login(token);
  const response = await api("/api/config", { revision: "new", settings: {
    authMode: "express", apiKey: "docker-fixture-api-key", gatewayKey, port: 4781, imageInput: "current-turn",
  } });
  assert.equal(response.status, 200);
  const saved = await response.json(); assert.equal(saved.status.running, true);
  assert.equal(saved.status.network.gatewayPublicUrl, apiBase + "/v1");
  assert.equal((await fetch(apiBase + "/healthz")).status, 200);
  assert.equal((await fetch(apiBase + "/v1/models")).status, 401);
  assert.equal((await fetch(apiBase + "/v1/models", { headers: { authorization: "Bearer " + gatewayKey } })).status, 200);
  const container = await compose("ps", "-q", "vertex-gateway");
  await docker(["exec", container, "node", "bin/healthcheck.mjs"]);
  const rendering = `import assert from 'node:assert/strict';
    import { stat, access } from 'node:fs/promises';
    import { prepareImageInput } from './src/image-input.mjs';
    assert.notEqual(process.getuid(), 0);
    assert.equal((await stat('/data/settings.json')).mode & 0o777, 0o600);
    for (const path of ['/app/.env', '/app/.git', '/app/runtime']) await assert.rejects(access(path));
    const result = await prepareImageInput({ messages: [{ role: 'user', content: '中文 Docker smoke test' }] }, 'all');
    assert.equal(result.metadata.pages, 1);
    assert.ok(result.payload.messages[0].content[0].image_url.url.startsWith('data:image/webp;base64,'));
    console.log('Non-root, private settings, clean image and CJK WebP rendering passed');`;
  console.log(await docker(["exec", container, "node", "--input-type=module", "-e", rendering]));
  // A separate container exercises service-name routing, as a Dockerized Tavern would.
  const peer = `import assert from 'node:assert/strict';
    assert.equal((await fetch('http://vertex-gateway:4781/v1/models', { signal: AbortSignal.timeout(5000), headers: { authorization: 'Bearer ${gatewayKey}' } })).status, 200);
    console.log('Compose service-name routing passed');`;
  console.log(await docker(["run", "--rm", "--network", project + "_default", "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true", image, "node", "--input-type=module", "-e", peer]));
  // Recreate, not merely restart: /data must survive removal of the original container.
  await compose("up", "-d", "--no-build", "--force-recreate");
  await ready(base + "/api/session"); cookie = null; csrf = null;
  assert.equal((await (await api("/api/session")).json()).setup, false);
  await login(gatewayKey);
  const restored = await (await api("/api/config")).json();
  assert.equal(restored.revision, saved.revision); assert.equal(restored.settings.imageInput, "current-turn");
  assert.equal((await (await api("/api/status")).json()).running, true);
  // Exercise the access-mode transitions in the shipped image, including keyless autostart.
  const weak = { revision: restored.revision, settings: { gatewayKeyMode: "weak", gatewayKey: "123456" } };
  assert.equal((await api("/api/config", weak)).status, 400);
  const weakResponse = await api("/api/config", { ...weak, confirmGatewayAccess: true });
  assert.equal(weakResponse.status, 200);
  const weakSaved = await weakResponse.json();
  assert.equal((await fetch(apiBase + "/v1/models")).status, 401);
  assert.equal((await fetch(apiBase + "/v1/models", { headers: { authorization: "Bearer 123456" } })).status, 200);
  await login("123456");
  const keyless = { revision: weakSaved.revision, settings: { gatewayKeyMode: "none" } };
  assert.equal((await api("/api/config", keyless)).status, 400);
  const keylessResponse = await api("/api/config", { ...keyless, confirmGatewayAccess: true });
  assert.equal(keylessResponse.status, 200);
  assert.equal((await keylessResponse.json()).settings.gatewayKeySet, false);
  await compose("up", "-d", "--no-build", "--force-recreate");
  await ready(base + "/api/session"); cookie = null; csrf = null;
  assert.equal((await (await api("/api/session")).json()).keyless, true);
  await login();
  const keylessRestored = await (await api("/api/config")).json();
  assert.equal((await (await api("/api/status")).json()).running, true);
  assert.equal(keylessRestored.settings.gatewayKeySet, false);
  assert.equal((await fetch(apiBase + "/v1/models")).status, 200);
  assert.equal((await fetch(apiBase + "/admin/events")).status, 200);
  assert.equal((await api("/api/config", { revision: keylessRestored.revision,
    settings: { gatewayKeyMode: "strict", gatewayKey } })).status, 200);
  assert.equal((await api("/api/login", {})).status, 401);
  assert.equal((await fetch(apiBase + "/v1/models")).status, 401);
  await login(gatewayKey);
  const current = await compose("ps", "-q", "vertex-gateway");
  const deadline = Date.now() + 15000;
  while (await docker(["inspect", "--format", "{{.State.Health.Status}}", current]) !== "healthy") {
    assert.ok(Date.now() < deadline, "Docker healthcheck becomes healthy"); await delay(500);
  }
  await compose("stop");
  assert.equal(await docker(["inspect", "--format", "{{.State.ExitCode}}", current]), "0");
  console.log("Docker smoke passed: setup, strict/weak/keyless auth, mapped ports, persistence, health and graceful shutdown; no inference");
} catch (error) {
  console.error(await compose("ps", "-a"));
  console.error((await compose("logs", "--no-color", "--tail", "20")).replace(/#setup=[a-f0-9]+/g, "#setup=[redacted]"));
  throw error;
} finally {
  // Only the unique test project and its synthetic volume are removed.
  try { await compose("down", "--volumes", "--remove-orphans"); }
  finally {
    if (dirname(resolve(temporary)) !== resolve(tmpdir()) || !basename(temporary).startsWith(project + "-")) throw new Error("Unsafe temporary path");
    await rm(temporary, { recursive: true, force: true });
  }
}
