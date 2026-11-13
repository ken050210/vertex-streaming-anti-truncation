import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { prepareSillyTavernRequest, restoreSillyTavernResponse } from "../src/sillytavern.mjs";
import { createGenerateHandler } from "../integrations/sillytavern/server.mjs";
import { prepareTauriTavernRequest, restoreTauriTavernResponse } from "../src/tauritavern.mjs";
import { compareVersions, createFetchInterceptor, GENERATE_PATH, PLUGIN_PATH, NATURAL_STOP_USAGE_FEATURE } from "../integrations/sillytavern/shared.js";
import { sseData } from "../src/wire.mjs";

const name = "router_emit", tag = "</tucao>";
const noise = "!} Let's end the call.!} Text is already in router_emit.!} Let's stop (looping)";
const prepared = { toolName: name, model: "gemini-4-argon", stream: true, upstreamStream: true, clientTools: false, tools: [], tucaoStop: true };
const frame = parts => ({ candidates: [{ content: { role: "model", parts } }] });
const call = functionCall => sseData(frame([{ functionCall }]));
const start = () => call({ name, willContinue: true });
const part = text => call({ partialArgs: [{ jsonPath: "$.content", stringValue: text, willContinue: true }], willContinue: true });
const end = () => call({ partialArgs: [{ jsonPath: "$.content", willContinue: false }], willContinue: false }) + sseData({ candidates: [{ finishReason: "STOP" }] });
const events = wire => wire.split("\n").filter(x => x.startsWith("data:") && !x.includes("[DONE]")).map(x => JSON.parse(x.slice(5)));
const text = wire => events(wire).flatMap(x => x.candidates ?? []).flatMap(x => x.content?.parts ?? []).filter(x => !x.thought).map(x => x.text ?? "").join("");

test("the plugin cutoff stays off unless explicitly requested", async () => {
  const content = "<tucao>第一段</tucao>正文<tucao>第二段</tucao>" + noise;
  for (const tucaoStop of [undefined, false]) {
    const result = await restoreSillyTavernResponse(new Response(start() + part(content) + end()), { ...prepared, tucaoStop });
    const output = await result.text();
    assert.equal(text(output), content);
    assert.equal(events(output).some(x => x.vertexStopAfter), false);
  }
});

test("long replies stop at every split of the second tag, discard same-chunk junk and cancel an open upstream", { timeout: 10000 }, async () => {
  const prefix = "<tucao>开场吐槽</tucao>" + ("这是正常的长正文。\n".repeat(12000)) + "<tucao>本轮结束";
  for (let split = 0; split <= tag.length; split++) {
    let cancelled = false;
    const wire = start() + prefix.match(/[\s\S]{1,3000}/g).map(part).join("") + part(tag.slice(0, split)) + part(tag.slice(split) + noise)
      + "data: this is invalid JSON after the stop\n\n";
    const upstream = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(wire)); },
      cancel() { cancelled = true; },
    }));
    const restored = await restoreSillyTavernResponse(upstream, { ...prepared });
    const output = await restored.text();
    assert.equal(text(output), prefix + tag);
    assert.equal(output.split("data: [DONE]").length - 1, 1);
    assert.equal(events(output).filter(x => x.candidates?.[0]?.finishReason === "STOP").length, 1);
    assert.ok(events(output).some(x => x.vertexStopAfter === tag));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, true);
  }
});

test("wire bytes and tag characters may all arrive separately, while ordinary text remains progressive", { timeout: 3000 }, async () => {
  let controller;
  const upstream = new Response(new ReadableStream({ start(value) { controller = value; } }));
  const restored = await restoreSillyTavernResponse(upstream, { ...prepared });
  const reader = restored.body.getReader(), decoder = new TextDecoder();
  controller.enqueue(new TextEncoder().encode(start() + part("<tucao>开场") + [...tag].map(part).join("") + part("正文😀<tucao>感想")));
  let output = "";
  while (!text(output).includes("感想")) output += decoder.decode((await reader.read()).value, { stream: true });
  for (const byte of new TextEncoder().encode([...tag].map(part).join(""))) controller.enqueue(Uint8Array.of(byte));
  for (;;) { const next = await reader.read(); if (next.done) break; output += decoder.decode(next.value, { stream: true }); }
  assert.equal(text(output), "<tucao>开场" + tag + "正文😀<tucao>感想" + tag);
});

test("thoughts and real-tool arguments do not trigger the visible reply boundary", async () => {
  const raw = sseData(frame([{ text: "思考里的" + tag + tag, thought: true }]))
    + call({ name: "lookup", partialArgs: [{ jsonPath: "$.content", stringValue: "查询里的" + tag, willContinue: true }], willContinue: true })
    + call({ partialArgs: [{ jsonPath: "$.content", stringValue: tag }] })
    + call({ name, args: { content: "正常正文，只有一个结束标签" + tag } })
    + sseData({ candidates: [{ finishReason: "STOP" }] });
  const output = await (await restoreSillyTavernResponse(new Response(raw), { ...prepared, clientTools: true,
    tools: [{ type: "function", function: { name: "lookup" } }] })).text();
  assert.equal(text(output), "正常正文，只有一个结束标签" + tag);
  assert.equal(events(output).some(x => x.vertexStopAfter), false);
  assert.ok(output.includes('"name":"lookup"'));
});

test("zero or one exact closing tag preserves ordinary completion and interrupted-stream errors", async () => {
  for (const prefix of ["<tucao>仍在输出</tuca>", "<tucao>第一段</tucao>正文继续<tucao>第二段尚未结束</tuca>"]) {
    const output = await (await restoreSillyTavernResponse(new Response(start() + part(prefix) + end()), { ...prepared })).text();
    assert.equal(text(output), prefix);
    assert.equal(events(output).some(x => x.vertexStopAfter), false);
    const interrupted = await restoreSillyTavernResponse(new Response(start() + part(prefix)), { ...prepared });
    await assert.rejects(interrupted.text(), /anti_truncation_native_stream_interrupted/);
  }
});

test("buffered tool and plain responses retain the second full tag and remove everything after it", async () => {
  const body = "<tucao>开场</tucao>正文<tucao>结尾" + tag;
  for (const nativePart of [{ functionCall: { name, args: { content: body + noise } } }, { text: body + noise }]) {
    const response = Response.json({ ...frame([nativePart]), usageMetadata: { totalTokenCount: 100 } });
    const result = await (await restoreSillyTavernResponse(response, { ...prepared, stream: false, upstreamStream: false })).json();
    assert.equal(result.choices[0].message.content, body);
    assert.equal(result.vertexStopAfter, tag);
    assert.equal(result.usage, undefined);
  }
});

test("plain streaming fallback clips the second tag; anti-truncation-off responses remain unchanged", async () => {
  const wire = sseData(frame([{ text: "<tucao>开场</tucao>正文<tucao>结尾</tu" }])) + sseData(frame([{ text: "cao>" + noise }]))
    + sseData({ candidates: [{ finishReason: "STOP" }] });
  const body = "<tucao>开场</tucao>正文<tucao>结尾" + tag;
  assert.equal(text(await (await restoreSillyTavernResponse(new Response(wire), { ...prepared })).text()), body);
  const raw = { candidates: [{ ...frame([{ text: body + noise }]).candidates[0], finishReason: "STOP" }] };
  const off = await (await restoreSillyTavernResponse(Response.json(raw), { ...prepared, toolName: null, stream: false, upstreamStream: false })).json();
  assert.equal(off.choices[0].message.content, body + noise);
});

test("the HTTP plugin validates custom rules and stops after one complete A pair without waiting for upstream finish", { timeout: 5000 }, async t => {
  const body = "<konatan_planning~><A></A></konatan_planning~><A>正文</A>";
  let cancelled = false, calls = 0;
  const handler = createGenerateHandler({
    getPromptNames: () => ({}),
    convertGooglePrompt: messages => ({ contents: messages.map(x => ({ role: "user", parts: [{ text: x.content }] })) }),
    safetySettings: [], SECRET_KEYS: { VERTEXAI: "fixture" }, readSecret: () => "fixture-key",
  }, { fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { calls++; controller.enqueue(new TextEncoder().encode(start() + part(body + noise))); },
    cancel() { cancelled = true; },
  })) });
  const server = http.createServer(async (req, res) => {
    const bytes = []; for await (const value of req) bytes.push(value);
    req.body = JSON.parse(Buffer.concat(bytes)); req.user = { directories: {} };
    res.status = code => { res.statusCode = code; return res; }; res.json = value => res.end(JSON.stringify(value));
    await handler(req, res);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const post = rule => fetch(`http://127.0.0.1:${server.address().port}`, { method: "POST", body: JSON.stringify({
    chat_completion_source: "vertexai", model: "gemini-4-argon", stream: true, vertex_anti_truncation: "streaming",
    vertexai_auth_mode: "express", vertexai_region: "global", vertexai_express_project_id: "fixture-project", max_tokens: 2048,
    messages: [{ role: "user", content: "合成输入" }], vertex_tag_stop: rule,
  }) });
  const invalid = await post({ tag: "A", count: 0 });
  assert.equal(invalid.status, 400);
  assert.equal(calls, 0);
  const response = await post({ tag: "A", count: 1, exemptTag: "konatan_planning~" });
  assert.equal(response.status, 200);
  const output = await response.text();
  assert.equal(text(output), body);
  assert.ok(!output.includes('"error"'));
  assert.equal(output.split("data: [DONE]").length - 1, 1);
  assert.equal(cancelled, true);
  const repeated = await post({ tag: "A", count: 1 });
  assert.equal(text(await repeated.text()), "<konatan_planning~><A></A>");
  assert.equal(calls, 2);
  assert.equal(compareVersions("0.7.0", "0.6.3"), 1);
});

test("buffered SillyTavern replies honor a custom tag and count", async () => {
  const body = "<A>正文</A>";
  const raw = frame([{ functionCall: { name, args: { content: body + noise } } }]);
  const result = await (await restoreSillyTavernResponse(Response.json(raw), {
    ...prepared, stopTag: "A", stopCount: 1, stream: false, upstreamStream: false,
  })).json();
  assert.equal(result.choices[0].message.content, body);
  assert.equal(result.vertexStopAfter, "</A>");
});


const countedUsage = { promptTokenCount: 900, cachedContentTokenCount: 400, candidatesTokenCount: 18,
  thoughtsTokenCount: 7, totalTokenCount: 925 };
const stopped = { ...prepared, stopTag: "A", stopCount: 1 };

test("the cutoff emits text immediately, then a single final receipt for a separately delivered usage frame", { timeout: 3000 }, async () => {
  const encoder = new TextEncoder();
  let upstream, cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { upstream = controller; }, cancel() { cancelled = true; },
  }));
  const restored = await restoreSillyTavernResponse(response, { ...stopped, waitForStopUsage: true });
  const reader = restored.body.getReader(), decoder = new TextDecoder();
  upstream.enqueue(encoder.encode(sseData({ usageMetadata: { trafficType: "ON_DEMAND_FLEX" } }) + start() + part("<A>visible</A>hidden")));
  let wire = "";
  while (!text(wire).includes("</A>")) wire += decoder.decode((await reader.read()).value);
  assert.equal(cancelled, false);
  upstream.enqueue(encoder.encode(sseData(frame([{ text: "hidden-tail" }])) + sseData({ candidates: [{ finishReason: "STOP" }] })));
  upstream.enqueue(encoder.encode(sseData({ usageMetadata: countedUsage })));
  for (let next = await reader.read(); !next.done; next = await reader.read()) wire += decoder.decode(next.value);
  assert.equal(text(wire), "<A>visible</A>");
  assert.doesNotMatch(wire, /hidden/);
  const output = events(wire);
  const receipts = output.filter(e => e.vertexUsageReceipt);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].vertexUsageReceipt.final, true);
  assert.deepEqual(receipts[0].usageMetadata, { ...countedUsage, trafficType: "ON_DEMAND_FLEX" });
  assert.equal(output.filter(e => e.usage || e.usageMetadata).length, 1);
  assert.equal(output.flatMap(e => e.candidates || []).filter(c => c.finishReason).length, 1);
  assert.equal(wire.split("data: [DONE]").length, 2);
  assert.equal(cancelled, true);
});

test("grace expires on a silent upstream and never promotes an earlier complete-looking snapshot", { timeout: 3000 }, async () => {
  let cancelled = false;
  // A real finish with no new counts is insufficient to confirm an interim snapshot.
  const response = new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(sseData({ usageMetadata: countedUsage }) +
      sseData(frame([{ text: "<A>ok</A>" }])) + sseData({ candidates: [{ finishReason: "STOP" }] }))); },
    cancel() { cancelled = true; },
  }));
  const wire = await (await restoreSillyTavernResponse(response, { ...stopped, waitForStopUsage: true })).text();
  assert.equal(cancelled, true);
  assert.equal(text(wire), "<A>ok</A>");
  const output = events(wire);
  assert.ok(output.every(e => !e.usage && !e.usageMetadata));
  assert.deepEqual(output.find(e => e.vertexUsageReceipt).vertexUsageReceipt, { final: false, usageMetadata: countedUsage });
});

test("a failing tail cannot undo a clipped reply and cancelling the reader ends the wait", async () => {
  for (const waitForStopUsage of [true, "natural"]) for (const abort of [false, true]) {
    let upstream, cancelled = false;
    const input = new Response(new ReadableStream({ start(c) { upstream = c; }, cancel() { cancelled = true; } }));
    const result = await restoreSillyTavernResponse(input, { ...stopped, waitForStopUsage });
    const reader = result.body.getReader(), decoder = new TextDecoder();
    upstream.enqueue(new TextEncoder().encode(sseData(frame([{ text: "<A>ok</A>" }]))));
    let wire = "";
    while (!text(wire).includes("</A>")) wire += decoder.decode((await reader.read()).value);
    if (abort) {
      await reader.cancel();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(cancelled, true);
    } else {
      upstream.error(new Error("tail disconnected"));
      for (let next = await reader.read(); !next.done; next = await reader.read()) wire += decoder.decode(next.value);
      assert.equal(events(wire).find(e => e.vertexUsageReceipt).vertexUsageReceipt.final, false);
      assert.ok(wire.includes("data: [DONE]"));
    }
  }
});

test("natural waiting streams the cutoff, then reads one request through EOF on native, PayGo and TauriTavern", { timeout: 8000 }, async () => {
  const origin = "http://localhost";
  const paygo = "/api/plugins/vertex-paygo/native-gemini/generate";
  const payload = { chat_completion_source: "vertexai", model: "gemini-4-argon", stream: true,
    messages: [{ role: "user", content: "fixture" }], max_tokens: 30000 };
  for (const route of ["native", "paygo", "tauri"]) {
    let upstream, cancelled = false, calls = 0;
    const intercept = createFetchInterceptor(async (url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      const response = new Response(new ReadableStream({ start(c) { upstream = c; }, cancel() { cancelled = true; } }));
      if (route === "native") {
        assert.equal(url, PLUGIN_PATH + "/generate");
        assert.equal(body.vertex_wait_for_stop_usage, "natural");
        const request = prepareSillyTavernRequest({ body }, {
          getPromptNames: () => ({}), convertGooglePrompt: () => ({ contents: [] }), safetySettings: [],
        });
        return restoreSillyTavernResponse(response, request);
      }
      assert.equal(url, route === "paygo" ? paygo : GENERATE_PATH);
      assert.equal(body.vertex_wait_for_stop_usage, undefined);
      return response;
    }, { origin, getMode: () => "streaming", getWaitForStopUsage: () => "natural",
      getTagStop: () => ({ tag: "A", count: 1 }),
      direct: route === "tauri" ? { prepare: prepareTauriTavernRequest, restore: restoreTauriTavernResponse } : null });

    const response = await intercept(route === "paygo" ? paygo : GENERATE_PATH, { method: "POST", body: JSON.stringify(payload) });
    const reader = response.body.getReader(), decoder = new TextDecoder();
    const send = event => upstream.enqueue(new TextEncoder().encode(sseData(event)));
    send(frame([{ text: "<A>visible</A>discarded" }]));
    let wire = "";
    while (!text(wire).includes("</A>")) wire += decoder.decode((await reader.read()).value);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(cancelled, false, route);
    send({ candidates: [{ index: 0, content: { parts: [{ text: "discarded" }] } }] });
    send(frame([{ text: "discarded", thought: true }, { functionCall: { name: "discarded", args: {} } }]));
    send({ candidates: [{ finishReason: "STOP" }], usageMetadata: countedUsage });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, false, route);
    const finalUsage = { ...countedUsage, cachedContentTokenCount: 425 };
    send({ usageMetadata: finalUsage });
    upstream.close();
    for (let next = await reader.read(); !next.done; next = await reader.read()) wire += decoder.decode(next.value);
    assert.equal(calls, 1);
    assert.equal(text(wire), "<A>visible</A>");
    assert.doesNotMatch(wire, /discarded/);
    assert.deepEqual(events(wire).filter(x => x.vertexUsageReceipt).map(x => x.vertexUsageReceipt), [{ final: true, usageMetadata: finalUsage }]);
    assert.equal(wire.split("data: [DONE]").length, 2);
  }
});

test("a post-cutoff usage-only frame is final only with a confirming finish and no more generated content", async () => {
  const clipped = sseData({ usageMetadata: { trafficType: "ON_DEMAND_FLEX" } }) + sseData(frame([{ text: "<A>visible</A>" }]));
  const metering = sseData({ usageMetadata: countedUsage });
  const finish = sseData({ candidates: [{ finishReason: "STOP" }] });
  for (const [tail, final] of [[metering + finish, true], [metering, false],
    [metering + sseData(frame([{ text: "discarded" }])) + finish, false],
    [metering + sseData({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "discarded" }] } }] }), false]]) {
    const wire = await (await restoreSillyTavernResponse(new Response(clipped + tail), { ...stopped, waitForStopUsage: "natural" })).text();
    assert.doesNotMatch(wire, /discarded/);
    const [receipt] = events(wire).filter(e => e.vertexUsageReceipt);
    assert.equal(receipt.vertexUsageReceipt.final, final);
    assert.equal(receipt.usageMetadata?.cachedContentTokenCount, final ? 400 : undefined);
    assert.equal(receipt.vertexUsageReceipt.usageMetadata.trafficType, "ON_DEMAND_FLEX");
  }
});

test("natural wait requires a capable streaming backend and cannot trigger paid long-decode continuations after the tag", async () => {
  const payload = { chat_completion_source: "vertexai", model: "gemini-4-argon", stream: true,
    messages: [{ role: "user", content: "fixture" }], max_tokens: 130000 };
  const intercept = createFetchInterceptor(() => assert.fail("old backend must not receive a generation"), {
    origin: "http://localhost", getMode: () => "streaming", getWaitForStopUsage: () => "natural",
    getTagStop: () => ({ tag: "A", count: 1 }), ensureBackend: feature => feature !== NATURAL_STOP_USAGE_FEATURE,
  });
  await assert.rejects(intercept(GENERATE_PATH, { method: "POST", body: JSON.stringify(payload) }), /natural_stop_usage_not_supported/);
  const request = prepareSillyTavernRequest({ body: { ...payload, vertex_anti_truncation: "streaming", vertex_long_decode: true,
    vertex_wait_for_stop_usage: "natural", vertex_tag_stop: { tag: "A", count: 1 } } }, {
    getPromptNames: () => ({}), convertGooglePrompt: () => ({ contents: [] }), safetySettings: [],
  });
  assert.equal(request.outputLimit.longDecode, true);
  assert.equal(request.waitForStopUsage, false);
});
