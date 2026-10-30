import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { parseEnv } from "node:util";
import { loadConfig, settingsFromEnv, MODEL_ID, buildConfig, DEFAULT_SETTINGS, publicSettings } from "../src/config.mjs";

const env = { GATEWAY_API_KEY: "synthetic-local-key-for-tests", VERTEX_PROJECT_ID: "example-project", VERTEX_ACCESS_TOKEN: "synthetic-oauth-token" };

test("gateway access defaults to strict and weak/keyless modes require an explicit configuration choice", async () => {
  assert.equal((await loadConfig(env)).gatewayKeyMode, "strict");
  for (const key of ["", "123456"]) await assert.rejects(loadConfig({ ...env, GATEWAY_API_KEY: key }), /at least 16/);
  const weak = await loadConfig({ ...env, GATEWAY_KEY_MODE: "weak", GATEWAY_API_KEY: "123456" });
  assert.equal(weak.gatewayKey, "123456");
  assert.equal(weak.gatewayKeyMode, "weak");
  for (const key of ["", "has space", "x".repeat(513), "中文", "a\u0001b"]) {
    await assert.rejects(loadConfig({ ...env, GATEWAY_KEY_MODE: "weak", GATEWAY_API_KEY: key }));
  }
  await assert.rejects(loadConfig({ ...env, GATEWAY_KEY_MODE: "disabled" }), /GATEWAY_KEY_MODE/);
  for (const key of ["", env.GATEWAY_API_KEY]) {
    const settings = await settingsFromEnv({ ...env, GATEWAY_KEY_MODE: "none", GATEWAY_API_KEY: key });
    assert.equal(settings.gatewayKey, "");
    assert.equal(buildConfig(settings).gatewayKeyMode, "none");
    assert.equal(publicSettings(settings).gatewayKeySet, false);
  }
});

test("config fixes Google hosts, model and defaults while supporting regional endpoints", async () => {
  const config = await loadConfig(env);
  assert.equal(config.model, MODEL_ID);
  assert.equal(config.port, 4781);
  assert.equal(config.timeoutMs, 600000);
  assert.equal(await config.accessToken(), env.VERTEX_ACCESS_TOKEN);
  assert.equal(config.baseUrl, "https://aiplatform.googleapis.com/v1/projects/example-project/locations/global/endpoints/openapi");
  const regional = await loadConfig({ ...env, VERTEX_LOCATION: "us-central1", PORT: "4782" });
  assert.match(regional.baseUrl, /^https:\/\/us-central1-aiplatform\.googleapis\.com\//);
  assert.equal(regional.port, 4782);
});

test("config rejects ambiguous credentials, host injection and invalid limits without echoing input", async () => {
  for (const override of [
    { GATEWAY_API_KEY: "short" }, { GATEWAY_API_KEY: "replace-me-with-a-real-key" },
    { VERTEX_PROJECT_ID: "example/../../elsewhere" }, { VERTEX_LOCATION: "https://example.com" },
    { VERTEX_ACCESS_TOKEN: "" }, { VERTEX_ACCESS_TOKEN: "contains whitespace" },
    { GOOGLE_APPLICATION_CREDENTIALS: "unused-file" }, { PORT: "0" }, { PORT: "65536" },
    { UPSTREAM_TIMEOUT_MS: "1" },
  ]) {
    await assert.rejects(loadConfig({ ...env, ...override }), error => {
      assert.equal(error.message.includes("synthetic"), false);
      return true;
    });
  }
});

test("service-account configuration accepts only Google's token exchange endpoint", async t => {
  const dir = await mkdtemp(join(tmpdir(), "vertex-stream-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "fixture.json");
  const fixture = { type: "service_account", client_email: "test@example.invalid", private_key: "unused-fixture", token_uri: "https://example.invalid/token" };
  const input = { ...env, VERTEX_ACCESS_TOKEN: "", GOOGLE_APPLICATION_CREDENTIALS: file };
  await writeFile(file, JSON.stringify(fixture));
  await assert.rejects(loadConfig(input), /Only Google's OAuth/);
  fixture.token_uri = "https://oauth2.googleapis.com/token";
  fixture.private_key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  await writeFile(file, "\uFEFF" + JSON.stringify(fixture));
  assert.equal(typeof (await loadConfig(input)).accessToken, "function");
  await writeFile(file, "not-json");
  await assert.rejects(loadConfig(input), /not valid JSON/);
});

test("Express uses an explicit global project when supplied and preserves projectless keys and tier headers", async () => {
  for (const serviceTier of ["standard", "flex", "priority"]) for (const projectId of ["", "example-project", "123456789012"]) {
    const config = await loadConfig({ GATEWAY_API_KEY: env.GATEWAY_API_KEY, VERTEX_API_KEY: "synthetic-express-key", VERTEX_SERVICE_TIER: serviceTier, VERTEX_PROJECT_ID: projectId });
    assert.equal(config.baseUrl, "https://aiplatform.googleapis.com/v1" + (projectId ? `/projects/${projectId}/locations/global` : ""));
    assert.equal(config.authMode, "express");
    assert.equal(config.nativeOnly, true);
    assert.equal(await config.accessToken(), "synthetic-express-key");
    assert.deepEqual(config.tierHeaders, serviceTier === "standard" ? {} : {
      "x-vertex-ai-llm-shared-request-type": serviceTier, "x-vertex-ai-llm-request-type": "shared",
    });
  }
  for (const override of [{ VERTEX_ACCESS_TOKEN: "also-set" }, { VERTEX_LOCATION: "us-central1" }, { VERTEX_SERVICE_TIER: "automatic" }, { VERTEX_PROJECT_ID: "example/../../elsewhere" }]) {
    await assert.rejects(loadConfig({ GATEWAY_API_KEY: env.GATEWAY_API_KEY, VERTEX_API_KEY: "synthetic-express-key", ...override }));
  }
});

test("a custom OpenAI-compatible upstream keeps its own URL and key and never uses Vertex tiers or native requests", async () => {
  const custom = { GATEWAY_API_KEY: env.GATEWAY_API_KEY, CUSTOM_UPSTREAM_URL: "https://relay.example.invalid/v1/chat/completions/", CUSTOM_UPSTREAM_API_KEY: "synthetic-relay-key" };
  const config = await loadConfig({ ...custom, VERTEX_SERVICE_TIER: "flex", VERTEX_LOCATION: "us-central1" });
  assert.equal(config.authMode, "custom");
  assert.equal(config.baseUrl, "https://relay.example.invalid/v1");
  assert.equal(await config.accessToken(), "synthetic-relay-key");
  assert.deepEqual(config.tierHeaders, {});
  assert.equal(config.nativeOnly, false);
  assert.equal((await loadConfig({ ...custom, CUSTOM_UPSTREAM_URL: "http://127.0.0.1:3000" })).baseUrl, "http://127.0.0.1:3000");
  for (const override of [
    { CUSTOM_UPSTREAM_URL: "ftp://relay.example.invalid/v1" }, { CUSTOM_UPSTREAM_URL: "https://user:pass@relay.example.invalid/v1" },
    { CUSTOM_UPSTREAM_URL: "https://relay.example.invalid/v1?key=synthetic" }, { CUSTOM_UPSTREAM_URL: "relay.example.invalid/v1" },
    { CUSTOM_UPSTREAM_API_KEY: "" }, { CUSTOM_UPSTREAM_API_KEY: "contains whitespace" }, { VERTEX_ACCESS_TOKEN: "also-set" },
  ]) {
    await assert.rejects(loadConfig({ ...custom, ...override }), error => {
      assert.equal(error.message.includes("synthetic"), false);
      return true;
    });
  }
  await assert.rejects(loadConfig({ ...custom, CUSTOM_UPSTREAM_API_KEY: "synthetic“relay”" }), { message: "CUSTOM_UPSTREAM_API_KEY must contain only visible ASCII characters" });
  const visible = publicSettings({ ...DEFAULT_SETTINGS, authMode: "custom", customBaseUrl: "https://relay.example.invalid/v1", customApiKey: "synthetic-relay-key" });
  assert.equal(visible.customApiKeySet, true);
  assert.equal(visible.customBaseUrl, "https://relay.example.invalid/v1");
  assert.equal(JSON.stringify(visible).includes("synthetic-relay-key"), false);
});

test("complete service accounts accept explicit target projects and reject invalid private keys locally", () => {
  const sa = { type: "service_account", project_id: "identity-project", client_email: "fixture@example.invalid", token_uri: "https://oauth2.googleapis.com/token",
    private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) };
  const settings = { ...DEFAULT_SETTINGS, gatewayKey: env.GATEWAY_API_KEY, projectId: "target-project", serviceAccountJson: JSON.stringify(sa) };
  for (const serviceTier of ["standard", "flex", "priority"]) {
    const config = buildConfig({ ...settings, serviceTier });
    assert.match(config.baseUrl, /projects\/target-project\/locations\/global/);
    assert.equal(config.nativeOnly, serviceTier === "flex");
  }
  assert.throws(() => buildConfig({ ...settings, serviceAccountJson: JSON.stringify({ ...sa, private_key: "not-a-key" }) }), /RSA private key/);
  assert.throws(() => buildConfig({ ...settings, location: "us-central1", serviceTier: "flex" }), /global/);
  const visible = publicSettings(settings);
  assert.equal(visible.serviceAccountJsonSet, true);
  assert.equal(visible.gatewayKeySet, true);
  for (const secret of [settings.gatewayKey, sa.private_key, sa.client_email]) assert.equal(JSON.stringify(visible).includes(secret), false);
});

test("Unicode setting defaults off and validates a strict global boolean", async () => {
  assert.equal((await loadConfig(env)).unicodeInput, false);
  assert.equal((await loadConfig({ ...env, UNICODE_INPUT: "true" })).unicodeInput, true);
  await assert.rejects(loadConfig({ ...env, UNICODE_INPUT: "1" }));
  assert.throws(() => buildConfig({ ...DEFAULT_SETTINGS, unicodeInput: "true", authMode: "access-token", projectId: env.VERTEX_PROJECT_ID,
    gatewayKey: env.GATEWAY_API_KEY, accessToken: env.VERTEX_ACCESS_TOKEN }), /toggle/);
});

test("environment errors name their variable and an unedited .env.example still loads for GUI setup", async () => {
  const missing = join(tmpdir(), "vertex-config-missing-" + process.pid);
  await assert.rejects(loadConfig({ ...env, GOOGLE_APPLICATION_CREDENTIALS: missing }), /GOOGLE_APPLICATION_CREDENTIALS, VERTEX_ACCESS_TOKEN, VERTEX_API_KEY or CUSTOM_UPSTREAM_URL/);
  await assert.rejects(loadConfig({ ...env, VERTEX_ACCESS_TOKEN: "", GOOGLE_APPLICATION_CREDENTIALS: missing }), /\(GOOGLE_APPLICATION_CREDENTIALS\)/);
  await assert.rejects(loadConfig({ ...env, GEMINI_PROMPT_RETRY_TEXT_FILE: missing }), /\(GEMINI_PROMPT_RETRY_TEXT_FILE\)/);
  const template = parseEnv(await readFile(new URL("../.env.example", import.meta.url), "utf8"));
  assert.equal((await settingsFromEnv(template)).serviceAccountJson, "");
  // The CLI names the choices when the template's credential lines are still commented out.
  await assert.rejects(loadConfig({ ...template, GATEWAY_API_KEY: env.GATEWAY_API_KEY }), { message: "Configure one upstream authentication method: GOOGLE_APPLICATION_CREDENTIALS, VERTEX_ACCESS_TOKEN, VERTEX_API_KEY or CUSTOM_UPSTREAM_URL" });
});

test("keys and tokens must be visible ASCII so every client can send them in a header", async () => {
  const gateway = "GATEWAY_API_KEY must contain only visible ASCII characters";
  const token = "VERTEX_ACCESS_TOKEN must contain only visible ASCII characters";
  for (const [override, message] of [
    [{ GATEWAY_API_KEY: "synthetic-local-key-\u201cquoted\u201d" }, gateway],
    [{ GATEWAY_API_KEY: "\u672c\u5730\u7f51\u5173\u5bc6\u94a5".repeat(3) }, gateway],
    [{ GATEWAY_API_KEY: "synthetic-local-key-caf\u00e9" }, gateway],
    [{ VERTEX_ACCESS_TOKEN: "synthetic\uff0doauth-token" }, token],
    [{ VERTEX_ACCESS_TOKEN: "synthetic\u0001oauth-token" }, token],
  ]) await assert.rejects(loadConfig({ ...env, ...override }), { message });
  await assert.rejects(loadConfig({ GATEWAY_API_KEY: env.GATEWAY_API_KEY, VERTEX_API_KEY: "\u201csynthetic-express-key\u201d" }),
    { message: "VERTEX_API_KEY must contain only visible ASCII characters" });
  // Whitespace keeps its earlier messages.
  await assert.rejects(loadConfig({ ...env, GATEWAY_API_KEY: "synthetic local key for tests" }), /at least 16 characters/);
  await assert.rejects(loadConfig({ ...env, VERTEX_ACCESS_TOKEN: "synthetic\u3000token" }), { message: "Invalid VERTEX_ACCESS_TOKEN" });
  // Settings saved before the rule are still readable; only strict validation rejects them.
  const legacy = { ...DEFAULT_SETTINGS, authMode: "access-token", projectId: env.VERTEX_PROJECT_ID, gatewayKey: "synthetic-local-key-caf\u00e9", accessToken: "synthetic\u201ctoken" };
  assert.equal(buildConfig(legacy, { requireAscii: false }).gatewayKey, legacy.gatewayKey);
  assert.throws(() => buildConfig(legacy), { message: gateway });
});
