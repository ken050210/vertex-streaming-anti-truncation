import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { loadConfig, MODEL_ID, buildConfig, DEFAULT_SETTINGS, publicSettings } from "../src/config.mjs";

const env = { GATEWAY_API_KEY: "synthetic-local-key-for-tests", VERTEX_PROJECT_ID: "example-project", VERTEX_ACCESS_TOKEN: "synthetic-oauth-token" };

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

test("Express API keys use a projectless global endpoint and explicit service-tier headers", async () => {
  for (const serviceTier of ["standard", "flex", "priority"]) {
    const config = await loadConfig({ GATEWAY_API_KEY: env.GATEWAY_API_KEY, VERTEX_API_KEY: "synthetic-express-key", VERTEX_SERVICE_TIER: serviceTier });
    assert.equal(config.baseUrl, "https://aiplatform.googleapis.com/v1");
    assert.equal(config.authMode, "express");
    assert.equal(config.nativeOnly, true);
    assert.equal(await config.accessToken(), "synthetic-express-key");
    assert.deepEqual(config.tierHeaders, serviceTier === "standard" ? {} : {
      "x-vertex-ai-llm-shared-request-type": serviceTier, "x-vertex-ai-llm-request-type": "shared",
    });
  }
  for (const override of [{ VERTEX_ACCESS_TOKEN: "also-set" }, { VERTEX_LOCATION: "us-central1" }, { VERTEX_SERVICE_TIER: "automatic" }]) {
    await assert.rejects(loadConfig({ GATEWAY_API_KEY: env.GATEWAY_API_KEY, VERTEX_API_KEY: "synthetic-express-key", ...override }));
  }
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
