import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, MODEL_ID } from "../src/config.mjs";

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
  await writeFile(file, "\uFEFF" + JSON.stringify(fixture));
  assert.equal(typeof (await loadConfig(input)).accessToken, "function");
  await writeFile(file, "not-json");
  await assert.rejects(loadConfig(input), /not valid JSON/);
});
