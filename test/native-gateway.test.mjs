import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createGatewayServer } from "../src/gateway.mjs";
import { buildConfig, DEFAULT_SETTINGS, MODEL_ID } from "../src/config.mjs";

const payload = { model: MODEL_ID, messages: [{ role: "user", content: "fixture prompt" }], max_tokens: 512 };
const sse = value => "data: " + JSON.stringify(value) + "\n\n";
async function fixture(t, authMode, serviceTier, stream = false, options = {}) {
  const events = [], requests = [];
  const config = buildConfig({ ...DEFAULT_SETTINGS, authMode, serviceTier, projectId: "example-project", gatewayKey: "synthetic-gateway-fixture-key", accessToken: "synthetic-token", apiKey: "synthetic-express-key", ...options });
  const server = createGatewayServer(config, { logger: e => events.push(e), fetchImpl: async (url, request) => {
    const body = JSON.parse(request.body); requests.push({ url, headers: request.headers, body });
    const name = body.tools?.[0]?.functionDeclarations?.[0]?.name;
    const part = name ? { functionCall: { name, args: { content: "fixture answer" } } } : { text: '{"ok":true}' };
    const native = { candidates: [{ content: { parts: [part] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 20, trafficType: "ON_DEMAND_" + serviceTier.toUpperCase() } };
    return stream ? new Response(sse(native)) : Response.json(native);
  } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: "POST", headers: { authorization: "Bearer " + config.gatewayKey, "content-type": "application/json" }, body: JSON.stringify({ ...payload, stream, ...body }),
  });
  return { post, requests, events };
}

test("Express and full-mode tiers reach the correct native URLs with correct auth, preserving restoration and actual tier", async t => {
  for (const authMode of ["express", "access-token"]) for (const tier of ["flex", "priority"]) for (const stream of [false, true]) {
    const f = await fixture(t, authMode, tier, stream);
    const response = await f.post({}); assert.equal(response.status, 200);
    const body = await response.text(); assert.match(body, /fixture answer/);
    if (stream) assert.match(body, /\[DONE\]/);
    else assert.equal(JSON.parse(body).router_anti_truncation.restored, true);
    const request = f.requests[0];
    if (authMode === "express") {
      assert.match(request.url, /^https:\/\/aiplatform.googleapis.com\/v1\/publishers/);
      assert.equal(request.headers["x-goog-api-key"], "synthetic-express-key");
      assert.equal(request.headers.authorization, undefined);
    } else {
      assert.match(request.url, /\/projects\/example-project\/locations\/global\/publishers/);
      assert.equal(request.headers.authorization, "Bearer synthetic-token");
    }
    assert.equal(request.headers["x-vertex-ai-llm-shared-request-type"], tier);
    assert.equal(request.headers["x-vertex-ai-llm-request-type"], "shared");
    assert.equal(request.url.includes("synthetic"), false);
    assert.equal(request.body.safetySettings, undefined);
    assert.equal(f.events[0].serviceTier, tier);
    assert.equal(f.events[0].trafficType, "ON_DEMAND_" + tier.toUpperCase());
    for (const secret of ["fixture prompt", "fixture answer", "synthetic-token", "synthetic-express-key"]) assert.equal(JSON.stringify(f.events).includes(secret), false);
  }
});

test("native-only routes reject lossy fields before inference and never fall back to a different tier", async t => {
  const f = await fixture(t, "express", "flex");
  for (const extra of [{ unsupported: true }, { messages: [{ role: "user", content: "test", name: "extra metadata" }] },
    { functions: [{ name: "legacy" }] }, { parallel_tool_calls: true }, { logprobs: true }, { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/image" } }] }] }]) {
    const response = await f.post(extra); assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "unsupported_native_fields");
  }
  assert.equal(f.requests.length, 0);
});

test("native JSON output and real tools bypass the wrapper; plain responses work with anti-truncation disabled", async t => {
  const json = await fixture(t, "express", "standard");
  const result = await (await json.post({ response_format: { type: "json_object" } })).json();
  assert.equal(result.choices[0].message.content, '{"ok":true}');
  assert.equal(json.requests[0].body.generationConfig.responseMimeType, "application/json");
  assert.equal(json.events[0].antiTruncation.restored, false);
  const tool = await fixture(t, "express", "flex", true);
  const wire = await (await tool.post({ tools: [{ type: "function", function: { name: "real_tool", parameters: { type: "object" } } }] })).text();
  assert.match(wire, /real_tool/); assert.match(wire, /tool_calls/); assert.match(wire, /\[DONE\]/);
  assert.equal(tool.requests[0].body.toolConfig?.functionCallingConfig?.streamFunctionCallArguments, undefined);
  const plain = await fixture(t, "express", "standard", true, { antiTruncation: false });
  const plainWire = await (await plain.post({})).text();
  assert.match(plainWire, /content/); assert.match(plainWire, /\[DONE\]/);
  assert.equal(plain.requests[0].body.tools, undefined);
});

test("strict native schemas preserve constraints, validate completed output and reject unsupported keywords before auth", async t => {
  let output = '{"ok":true}', calls = 0, auth = 0;
  const events = [];
  const config = buildConfig({ ...DEFAULT_SETTINGS, authMode: "express", serviceTier: "standard",
    gatewayKey: "synthetic-gateway-fixture-key", apiKey: "synthetic-express-key" });
  config.accessToken = async () => { auth++; return "synthetic-express-key"; };
  const server = createGatewayServer(config, { logger: row => events.push(row), fetchImpl: async (url, request) => {
    calls++;
    const body = JSON.parse(request.body);
    assert.equal(body.generationConfig.responseJsonSchema.additionalProperties, false);
    return Response.json({ candidates: [{ content: { parts: [{ text: output }] }, finishReason: "STOP" }] });
  } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const post = schema => fetch("http://127.0.0.1:" + server.address().port + "/v1/chat/completions", { method: "POST",
    headers: { authorization: "Bearer " + config.gatewayKey, "content-type": "application/json" },
    body: JSON.stringify({ ...payload, response_format: { type: "json_schema", json_schema: { name: "fixture", strict: true, schema } } }) });
  const invalid = await post({ type: "string", pattern: "x" });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.param, "/response_format/json_schema/schema/pattern");
  assert.equal(calls, 0); assert.equal(auth, 0);
  const schema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };
  const good = await post(schema); assert.equal(good.status, 200); await good.text();
  assert.equal(events.at(-1).responseIntegrity.outcome, "complete");
  output = '{"ok":true,"extra":"private-schema-output"}';
  const bad = await post(schema); assert.equal(bad.status, 502);
  assert.equal((await bad.json()).error.code, "schema_validation_failed");
  assert.equal(events.at(-1).responseIntegrity.outcome, "error");
  assert.equal(JSON.stringify(events).includes("private-schema-output"), false);
});
