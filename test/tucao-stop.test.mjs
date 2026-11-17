import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createGatewayServer } from "../src/gateway.mjs";
import { buildConfig, loadConfig, settingsFromEnv } from "../src/config.mjs";
import { createSettingsStore } from "../src/settings-store.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFetchInterceptor, GENERATE_PATH, TAG_STOP_FEATURE } from "../integrations/sillytavern/shared.js";
import { sseData } from "../src/wire.mjs";
import { wrapAntiTruncationStream } from "../src/anti-truncation.mjs";
import { createTagStop } from "../src/tag-stop.mjs";

const name = "router_emit", tag = "</tucao>";
const first = "<tucao>开场" + tag, body = first + "正文😀<tucao>结束" + tag, noise = "!} unwanted tail";
const env = { VERTEX_PROJECT_ID: "fixture-project", VERTEX_ACCESS_TOKEN: "fixture-token", GATEWAY_API_KEY: "fixture-gateway-secret" };
const records = wire => wire.split("\n").filter(line => line.startsWith("data:") && !line.includes("[DONE]")).map(line => JSON.parse(line.slice(5)));
const visible = wire => records(wire).map(x => x.choices?.[0]?.delta?.content ?? "").join("");
const nativeCall = functionCall => sseData({ candidates: [{ content: { parts: [{ functionCall }] } }] });
const nativePart = stringValue => nativeCall({ willContinue: true, partialArgs: [{ jsonPath: "$.content", stringValue, willContinue: true }] });
const compatiblePart = argumentsText => sseData({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argumentsText } }] }, finish_reason: null }] });
const compatibleStart = sseData({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "fixture", type: "function", function: { name } }] }, finish_reason: null }] });

async function fixture(t, native, upstream, settings = {}) {
  const config = buildConfig({ ...await settingsFromEnv(env),
    ...(native ? { authMode: "express", apiKey: "fixture-express" } : { authMode: "custom", customBaseUrl: "https://fixture.invalid/v1", customApiKey: "fixture-custom" }),
    models: [{ id: "fixture", upstreamModel: "gemini-4-argon", mode: "streaming" }], tucaoStop: true, ...settings });
  let calls = 0;
  const events = [];
  const server = createGatewayServer(config, { logger: event => events.push(event), fetchImpl: async (url, options) => { calls++; return upstream(JSON.parse(options.body), url); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { events, calls: () => calls, post: (extra = {}) => fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: "POST", headers: { authorization: "Bearer " + env.GATEWAY_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "Synthetic input" }], stream: true, ...extra }),
  }) };
}

test("gateway native and compatible streams stop at the second tag, even with unfinished or malformed tool JSON", { timeout: 10000 }, async t => {
  for (const native of [true, false]) for (let split = 0; split <= tag.length; split++) {
    let cancelled = false;
    const prefix = body.slice(0, -tag.length);
    const wire = native
      ? nativeCall({ name, willContinue: true }) + nativePart(prefix + tag.slice(0, split)) + nativePart(tag.slice(split) + noise)
      : compatibleStart + compatiblePart('{"content":' + JSON.stringify(prefix + tag.slice(0, split)).slice(0, -1))
        + compatiblePart(JSON.stringify(tag.slice(split) + noise).slice(1, -1) + '\\q');
    const f = await fixture(t, native, () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(wire + "data: invalid after stop\n\n")); },
      cancel() { cancelled = true; },
    })));
    const response = await f.post({ stream_options: { include_usage: true } });
    assert.equal(response.status, 200);
    const output = await response.text();
    assert.equal(visible(output), body);
    assert.equal(output.split("data: [DONE]").length - 1, 1);
    assert.ok(records(output).some(x => x.router_stop_after === tag && x.choices[0].finish_reason === "stop"));
    assert.ok(!records(output).some(x => x.usage));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, true);
    assert.equal(f.calls(), 1);
  }
});

test("native gateway delivers the clipped reply before its metering tail and records only confirmed usage", { timeout: 8000 }, async t => {
  const encoder = new TextEncoder();
  for (const [wait, include, final] of [["natural", true, true], ["natural", false, true], ["250ms", true, false]]) {
    let source;
    const f = await fixture(t, true, () => new Response(new ReadableStream({ start(controller) {
      source = controller;
      source.enqueue(encoder.encode(sseData({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } })
        + nativeCall({ name, willContinue: true }) + nativePart(body + noise)));
    } })), { stopUsageWait: wait });
    const response = await f.post({ stream_options: { include_usage: include } });
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let wire = "";
    while (!wire.includes(tag)) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      wire += value;
    }
    if (final) {
      source.enqueue(encoder.encode(nativePart("hidden tail") + sseData({ candidates: [{ finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9, cachedContentTokenCount: 3, totalTokenCount: 14 } })));
      source.close();
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      wire += value;
    }
    assert.equal(visible(wire), body);
    assert.equal(wire.split("[DONE]").length - 1, 1);
    const usage = records(wire).filter(x => x.usage);
    assert.equal(usage.length, Number(final && include));
    if (usage.length) assert.equal(usage[0].usage.total_tokens, 14);
    assert.deepEqual(f.events[0].usage, final ? { promptTokens: 5, outputTokens: 9, cachedTokens: 3 } : undefined);
    assert.equal(f.calls(), 1);
  }
});

test("buffered and nonstream native/compatible replies clip only when enabled, including plain fallback", async t => {
  for (const native of [true, false]) for (const plain of [true, false]) for (const stream of [true, false]) for (const enabled of [true, false]) {
    const f = await fixture(t, native, () => Response.json(native
      ? { candidates: [{ content: { parts: [plain ? { text: body + noise } : { functionCall: { name, args: { content: body + noise } } }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 } }
      : { choices: [{ index: 0, message: plain ? { role: "assistant", content: body + noise } : { role: "assistant", tool_calls: [{ id: "fixture", type: "function", function: { name, arguments: JSON.stringify({ content: body + noise }) } }] }, finish_reason: plain ? "stop" : "tool_calls" }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }),
    { tucaoStop: enabled, models: [{ id: "fixture", upstreamModel: "gemini-4-argon", mode: "buffered" }] });
    const response = await f.post({ stream, stream_options: { include_usage: true } });
    assert.equal(response.status, 200);
    const output = stream ? await response.text() : await response.json();
    assert.equal(stream ? visible(output) : output.choices[0].message.content, enabled ? body : body + noise);
    assert.equal(stream ? records(output).some(x => x.router_stop_after === tag) : output.router_stop_after === tag, enabled);
    assert.equal((stream ? records(output).find(x => x.usage)?.usage : output.usage)?.total_tokens, 20);
  }
});

test("compatible cutoff decodes JSON escapes and leaves thoughts, real tools, normal profiles and one-tag replies alone", async t => {
  const thought = sseData({ choices: [{ index: 0, delta: { reasoning_content: tag + tag } }] });
  const real = sseData({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "real", type: "function", function: { name: "lookup", arguments: JSON.stringify({ content: tag + tag }) } }] } }] });
  const args = JSON.stringify({ content: first + "正文继续" });
  const finish = sseData({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + sseData("[DONE]");
  const f = await fixture(t, false, () => new Response(thought + real + compatibleStart + compatiblePart(args) + finish));
  const output = await (await f.post({ tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }] })).text();
  assert.equal(visible(output), first + "正文继续");
  assert.ok(!records(output).some(x => x.router_stop_after));
  assert.ok(output.includes('"name":"lookup"'));
  assert.ok(output.includes('reasoning_content'));
  const escaped = await fixture(t, false, () => new Response(compatibleStart + compatiblePart(JSON.stringify({ content: body + noise }).replaceAll("<", "\\u003c")) + finish));
  assert.equal(visible(await (await escaped.post()).text()), body);
  const normal = await fixture(t, false, () => Response.json({ choices: [{ index: 0, message: { role: "assistant", content: body + noise }, finish_reason: "stop" }] }),
    { models: [{ id: "fixture", upstreamModel: "gemini-4-argon", mode: "normal" }] });
  assert.equal((await (await normal.post({ stream: false })).json()).choices[0].message.content, body + noise);
  const unfinished = wrapAntiTruncationStream(new Response(compatibleStart + compatiblePart('{"content":' + JSON.stringify(first).slice(0, -1))), name, () => {}, [], createTagStop(name));
  await assert.rejects(unfinished.text(), /anti_truncation_stream_interrupted/);
});

test("a native local stop cancels long-decode before another inference hop", async t => {
  for (const completed of [true, false]) {
    let cancelled = false;
    const f = await fixture(t, true, () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(nativeCall({ name, willContinue: true }) + nativePart(body + noise)
          + sseData({ candidates: [{ finishReason: "CONTINUATION", continuationToken: "fixture-next-hop" }] })));
        if (completed) controller.close();
      },
      cancel() { cancelled = true; },
    })), { geminiLongDecode: true, stopUsageWait: "natural" });
    assert.equal(visible(await (await f.post({ max_tokens: 70000 })).text()), body);
    await new Promise(resolve => setImmediate(resolve));
    if (!completed) assert.equal(cancelled, true);
    assert.equal(f.calls(), 1);
  }
});

test("tag stop defaults on, preserves legacy opt-outs and persists custom rules through the settings store", async t => {
  const defaults = await loadConfig(env);
  assert.equal(defaults.tucaoStop, true);
  assert.equal(defaults.stopTag, "tucao");
  assert.equal(defaults.stopCount, 2);
  assert.equal((await loadConfig({ ...env, TUCAO_STOP: "true" })).tucaoStop, true);
  assert.equal((await loadConfig({ ...env, TUCAO_STOP: "false" })).tucaoStop, false);
  assert.equal((await loadConfig({ ...env, TUCAO_STOP: "true", TAG_STOP: "false" })).tucaoStop, false);
  const custom = await loadConfig({ ...env, TAG_STOP: "true", STOP_TAG: "A", STOP_COUNT: "1", STOP_EXEMPT_TAG: "plan~", STOP_USAGE_WAIT: "250ms", UNICODE_INPUT: "recent" });
  assert.equal(custom.stopUsageWait, "250ms");
  assert.equal(custom.unicodeInput, "recent");
  await assert.rejects(loadConfig({ ...env, STOP_USAGE_WAIT: "invalid" }), /STOP_USAGE_WAIT/);
  assert.equal(custom.stopExemptTag, "plan~");
  assert.equal(custom.stopTag, "A");
  assert.equal(custom.stopCount, 1);
  await assert.rejects(loadConfig({ ...env, TUCAO_STOP: "yes" }), /TUCAO_STOP/);
  await assert.rejects(loadConfig({ ...env, STOP_COUNT: "1.5" }), /STOP_COUNT/);
  await assert.rejects(loadConfig({ ...env, STOP_TAG: "<A>" }), { code: "invalid_tag_stop" });
  assert.throws(() => buildConfig({ tucaoStop: "true", gatewayKeyMode: "none" }), /toggle/);
  const directory = await mkdtemp(join(tmpdir(), "tucao-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createSettingsStore({ directory, env });
  const initial = await store.load();
  const saved = await store.save({ ...initial.settings, tucaoStop: true, stopTag: "A", stopCount: 1, stopExemptTag: "plan~" }, initial.revision);
  assert.equal((await store.load()).settings.stopExemptTag, "plan~");
  assert.equal((await store.load()).settings.tucaoStop, true);
  assert.equal((await store.load()).settings.stopTag, "A");
  assert.equal((await store.load()).settings.stopCount, 1);
  const { stopTag, stopCount, ...legacy } = initial.settings;
  await store.save({ ...legacy, tucaoStop: false }, saved.revision);
  const migrated = (await store.load()).settings;
  assert.equal(migrated.tucaoStop, false);
  assert.equal(migrated.stopTag, "tucao");
  assert.equal(migrated.stopCount, 2);
});

test("the extension requires the cutoff feature only when opted in and sends the explicit setting", async () => {
  let enabled = false, supported = false, sent, count = 0;
  const intercept = createFetchInterceptor(async (_url, init) => { sent = JSON.parse(init.body); count++; return new Response('{}'); }, {
    origin: "https://fixture.invalid", getMode: () => "streaming", getTagStop: () => enabled ? { tag: "A", count: 1 } : null,
    ensureBackend: async feature => { assert.equal(feature, TAG_STOP_FEATURE); return supported; },
  });
  const init = { method: "POST", body: JSON.stringify({ chat_completion_source: "vertexai", model: "gemini-4-argon", messages: [] }) };
  await intercept(GENERATE_PATH, init);
  assert.equal(sent.vertex_tag_stop, undefined);
  enabled = true;
  await assert.rejects(intercept(GENERATE_PATH, init), /tag_stop_not_supported/);
  assert.equal(count, 1);
  supported = true;
  await intercept(GENERATE_PATH, init);
  assert.deepEqual(sent.vertex_tag_stop, { tag: "A", count: 1 });
  assert.equal(sent.vertex_tucao_stop, undefined);
});

test("gateway applies custom tag/count to native and compatible streaming and buffered replies", async t => {
  const prefix = "<konatan_planning~><A></A></konatan_planning~></A><a>wrong case</a><A>正文</A>";
  for (const native of [true, false]) for (const stream of [true, false]) {
    const f = await fixture(t, native, () => stream ? new Response(native
      ? nativeCall({ name, willContinue: true }) + [...prefix + noise].map(nativePart).join("")
      : compatibleStart + [...JSON.stringify({ content: prefix + noise })].map(compatiblePart).join(""))
      : Response.json(native
        ? { candidates: [{ content: { parts: [{ functionCall: { name, args: { content: prefix + noise } } }] }, finishReason: "STOP" }] }
        : { choices: [{ message: { role: "assistant", content: prefix + noise }, finish_reason: "stop" }] }),
    { stopTag: "A", stopCount: 1, stopExemptTag: "konatan_planning~", models: [{ id: "fixture", upstreamModel: "gemini-4-argon", mode: stream ? "streaming" : "buffered" }] });
    const response = await f.post({ stream });
    assert.equal(response.status, 200);
    assert.equal(stream ? visible(await response.text()) : (await response.json()).choices[0].message.content, prefix);
  }
});
