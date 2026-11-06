import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { wrapNativeTextStream } from "../src/vertex-text-stream.mjs";
import { wrapAntiTruncationStream } from "../src/anti-truncation.mjs";
import { nativeRequestBody } from "../src/vertex-native.mjs";
import { prepareTauriTavernRequest, restoreTauriTavernResponse } from "../src/tauritavern.mjs";
import { prepareSillyTavernRequest, restoreSillyTavernResponse } from "../src/sillytavern.mjs";
import { createGatewayServer } from "../src/gateway.mjs";
import { buildConfig, DEFAULT_SETTINGS } from "../src/config.mjs";
import { sseData } from "../src/wire.mjs";
import { encodeGemini4ToolId, gemini4ToolMetadata } from "../src/gemini4.mjs";
import { prepareImageInput } from "../src/image-input.mjs";

const tool = { type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } };
const tools = [tool];
const model = "gemini-4-argon";
const usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 };
const event = parts => sseData({ candidates: [{ content: { role: "model", parts } }] });
const call = (functionCall, thoughtSignature) => event([{ functionCall, ...(thoughtSignature ? { thoughtSignature } : {}) }]);
const finish = (finishReason = "STOP") => sseData({ candidates: [{ finishReason }], usageMetadata });
const events = text => text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
const deltas = text => events(text).flatMap(event => event.choices ?? []).map(choice => choice.delta);
const nativeParts = text => events(text).flatMap(event => event.candidates ?? []).flatMap(candidate => candidate.content?.parts ?? []);
const restore = wire => wrapAntiTruncationStream(wrapNativeTextStream(new Response(wire), "router_emit", model, () => {}, true, tools), "router_emit", () => {}, tools);
const textStart = name => call({ name, willContinue: true }) + call({ partialArgs: [{ jsonPath: "$.content", stringValue: "先显示", willContinue: true }], willContinue: true });
const textEnd = () => call({ partialArgs: [{ jsonPath: "$.content", stringValue: "正文" }] });
const realStart = () => call({ id: "native-1", name: "lookup", willContinue: true }) + call({ partialArgs: [
  { jsonPath: "$.query", stringValue: "查\"询", willContinue: true },
  { jsonPath: "$.options.enabled", boolValue: false },
  { jsonPath: "$.items[0].n", numberValue: 0 },
  { jsonPath: "$.items[1]", nullValue: "NULL_VALUE" },
  { jsonPath: '$["a.b"]', stringValue: "quoted" },
  { jsonPath: "$['single']", stringValue: "key" },
], willContinue: true });
const realEnd = () => call({ partialArgs: [{ jsonPath: "$.query", stringValue: "\n天气" }], willContinue: true }) + call({}, "signature-final");
const realArgs = { query: '查"询\n天气', options: { enabled: false }, items: [{ n: 0 }, null], "a.b": "quoted", single: "key" };
const realPart = { functionCall: { id: "native-1", name: "lookup", args: realArgs }, thoughtSignature: "signature-final" };

test("mixed native calls restore text and round-trip nested args, repeated names, IDs and final signatures", async () => {
  const result = await restore(textStart("router_emit") + textEnd() + realStart() + realEnd() +
    call({ id: "native-2", name: "lookup", args: {} }) + finish()).text();
  assert.equal(deltas(result).map(delta => delta.content ?? "").join(""), "先显示正文");
  const calls = deltas(result).flatMap(delta => delta.tool_calls ?? []);
  assert.deepEqual(calls.map(call => call.index), [0, 1]);
  assert.deepEqual(JSON.parse(calls[0].function.arguments), realArgs);
  assert.equal(calls[1].function.arguments, "{}");
  assert.equal(events(result).find(event => event.router_anti_truncation).choices[0].finish_reason, "tool_calls");
  const history = nativeRequestBody({ model, messages: [{ role: "assistant", tool_calls: calls },
    ...calls.map(call => ({ role: "tool", tool_call_id: call.id, content: '{"ok":true}' }))] });
  assert.deepEqual(history.contents[0].parts[0], realPart);
  assert.deepEqual(history.contents[1].parts.map(part => part.functionResponse.id), ["native-1", "native-2"]);
  assert.deepEqual(history.contents[1].parts[0].functionResponse.response, { ok: true });
});

test("tools-only native reply and valueless string terminator preserve real calls", async () => {
  const wire = call({ name: "lookup", partialArgs: [{ jsonPath: "$.query", stringValue: "天气", willContinue: true }], willContinue: true }) +
    call({ partialArgs: [{ jsonPath: "$.query" }] }) + finish();
  const result = await restore(wire).text();
  assert.equal(deltas(result).flatMap(delta => delta.tool_calls ?? []).length, 1);
  assert.equal(deltas(result).flatMap(delta => delta.tool_calls ?? [])[0].function.arguments, '{"query":"天气"}');
  assert.equal(events(result).find(event => event.router_anti_truncation).router_anti_truncation.restored, false);
});

test("a signature on the removed text tool is not reassigned to a different function", async () => {
  for (const signature of [undefined, "real-signature"]) {
    const prepared = prepareTauriTavernRequest(body, "streaming");
    const wire = call({ name: prepared.toolName, args: { content: "正文" } }, "text-only-signature") +
      call({ id: "native-1", name: "lookup", args: {} }, signature) + call({ id: "native-2", name: "lookup", args: {} }) + finish();
    const result = await (await restoreTauriTavernResponse(new Response(wire), prepared)).text();
    const calls = nativeParts(result).filter(part => part.functionCall);
    assert.equal(calls[0].thoughtSignature, signature ?? "skip_thought_signature_validator");
    assert.equal(calls[1].thoughtSignature, undefined);
    assert.equal(result.includes("text-only-signature"), false);
  }
});

test("unfinished client calls never reach the client on truncation, safety stop or broken streams", async () => {
  for (const reason of ["MAX_TOKENS", "SAFETY"]) {
    const result = await restore(textStart("router_emit") + textEnd() + realStart() + finish(reason)).text();
    assert.equal(deltas(result).some(delta => delta.tool_calls), false);
    assert.equal(events(result).find(event => event.choices?.[0]?.finish_reason).choices[0].finish_reason,
      reason === "MAX_TOKENS" ? "length" : "content_filter");
  }
  await assert.rejects(restore(realStart() + finish()).text(), /incomplete_args/);
  await assert.rejects(restore(realStart()).text(), /stream_interrupted/);
  for (const invalid of [{ jsonPath: "$.query", numberValue: 3 }, { jsonPath: "$.x" },
    { jsonPath: "$.x", boolValue: false, willContinue: true }, { jsonPath: "$.items[9]", stringValue: "gap" }]) {
    await assert.rejects(restore(realStart() + call({ partialArgs: [invalid] }) + finish()).text(), /invalid_partial_args/);
  }
  await assert.rejects(restore(realStart() + call({ name: "another", args: {} }) + finish()).text(), /unexpected_call/);
  await assert.rejects(restore(realStart() + call({ id: "other-id" }) + finish()).text(), /unexpected_call/);
});

const body = { chat_completion_source: "vertexai", model, stream: true, tools, tool_choice: "auto", vertex_anti_truncation: "streaming",
  messages: [{ role: "user", content: [{ type: "text", text: "看图查资料" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }] };
const adapters = { getPromptNames: () => ({}), safetySettings: [], convertGooglePrompt: messages => ({ contents: nativeRequestBody({ model, messages }).contents }) };

for (const [host, imageMode] of [["ST", "off"], ["ST", "current-turn"], ["TT", "off"]]) test(`${host} (text-to-image: ${imageMode}) delivers text before a client tool completes, then preserves its complete native part`, async () => {
  const { payload } = await prepareImageInput(body, imageMode);
  const prepared = host === "TT" ? prepareTauriTavernRequest(body, "streaming")
    : prepareSillyTavernRequest({ body: { ...payload, vertex_image_input: imageMode } }, adapters);
  const sent = host === "TT" ? JSON.parse(prepared.body.custom_include_body) : prepared.body;
  assert.equal(sent.toolConfig.functionCallingConfig.streamFunctionCallArguments, true);
  assert.deepEqual(sent.tools[0].functionDeclarations.map(tool => tool.name), ["lookup", prepared.toolName]);
  if (host === "TT") assert.deepEqual(prepared.body.messages[0], body.messages[0]);
  else assert.deepEqual(sent.contents[0].parts.filter(part => part.inlineData).map(part => part.inlineData.mimeType),
    imageMode === "off" ? ["image/png"] : ["image/webp", "image/png"]);
  let source;
  const upstream = new Response(new ReadableStream({ start(controller) { source = controller; } }));
  const encoder = new TextEncoder();
  source.enqueue(encoder.encode(textStart(prepared.toolName)));
  const response = host === "TT" ? await restoreTauriTavernResponse(upstream, prepared) : await restoreSillyTavernResponse(upstream, prepared);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let received = "";
  while (!nativeParts(received).some(part => part.text)) received += decoder.decode((await reader.read()).value);
  assert.equal(nativeParts(received).map(part => part.text ?? "").join(""), "先显示");
  assert.equal(nativeParts(received).some(part => part.functionCall), false);
  source.enqueue(encoder.encode(textEnd() + realStart() + realEnd() + finish()));
  source.close();
  for (let read = await reader.read(); !read.done; read = await reader.read()) received += decoder.decode(read.value);
  assert.equal(nativeParts(received).map(part => part.text ?? "").join(""), "先显示正文");
  assert.deepEqual(nativeParts(received).filter(part => part.functionCall), [realPart]);
  assert.deepEqual(events(received).find(event => event.usageMetadata).usageMetadata, usageMetadata);
});

test("TT buffered responses keep tools, and the next request preserves native history and images", async () => {
  const prepared = prepareTauriTavernRequest({ ...body, stream: false }, "buffered");
  const response = await restoreTauriTavernResponse(new Response(textStart(prepared.toolName) + textEnd() + realStart() + realEnd() + finish()), prepared);
  const completion = await response.json();
  assert.equal(completion.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(completion.responseContent.parts.at(-1), realPart);
  // TT stores provider-native parts beside its canonical OpenAI tool calls.
  const history = [{ ...completion.choices[0].message, native: { gemini: { content: completion.responseContent } } },
    { role: "tool", tool_call_id: completion.choices[0].message.tool_calls[0].id, content: '{"ok":true}' }];
  const next = prepareTauriTavernRequest({ ...body, messages: [...body.messages, ...history] }, "streaming");
  assert.deepEqual(next.body.messages.slice(0, -1), [...body.messages, ...history]);
  assert.equal(JSON.parse(next.body.custom_include_body).toolConfig.functionCallingConfig.streamFunctionCallArguments, true);
});

test("Argon tool metadata round-trips without Buffer or process", () => {
  const originalBuffer = globalThis.Buffer, originalProcess = globalThis.process;
  let result;
  try {
    globalThis.Buffer = undefined;
    globalThis.process = undefined;
    // Node 22's Response itself needs Buffer. Exercise the browser-safe codec
    // synchronously here; the tests above cover its integration with TT streams.
    result = gemini4ToolMetadata(encodeGemini4ToolId({ functionCall: { id: "调用-1" }, thoughtSignature: "签名😀" }));
  } finally {
    globalThis.Buffer = originalBuffer;
    globalThis.process = originalProcess;
  }
  assert.deepEqual(result, { id: "调用-1", signature: "签名😀" });
});

test("gateway native streaming keeps images and tool results through an aliased Argon model", async t => {
  const requests = [];
  const config = buildConfig({ ...DEFAULT_SETTINGS, authMode: "access-token", accessToken: "synthetic-token", projectId: "example-project",
    gatewayKey: "synthetic-gateway-key", models: [{ id: "argon-stream", upstreamModel: model, mode: "streaming" }] });
  const server = createGatewayServer(config, { logger: () => {}, fetchImpl: async (url, init) => {
    const sent = JSON.parse(init.body); requests.push(sent);
    assert.match(url, /:streamGenerateContent/);
    assert.equal(sent.toolConfig.functionCallingConfig.streamFunctionCallArguments, true);
    return new Response(requests.length === 1 ? textStart("router_emit") + textEnd() + realStart() + realEnd() + finish()
      : call({ name: "router_emit", args: { content: "工具完成" } }) + finish());
  } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const post = messages => fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: "POST",
    headers: { authorization: "Bearer " + config.gatewayKey, "content-type": "application/json" },
    body: JSON.stringify({ model: "argon-stream", stream: true, tools, messages }) });
  const response = await post(body.messages);
  assert.equal(response.status, 200);
  const first = await response.text();
  const calls = deltas(first).flatMap(delta => delta.tool_calls ?? []).map(({ index, ...call }) => call);
  assert.equal(events(first)[0].model, "argon-stream");
  assert.equal(calls.length, 1);
  const second = await post([...body.messages, { role: "assistant", content: "先显示正文", tool_calls: calls },
    { role: "tool", tool_call_id: calls[0].id, content: '{"ok":true}' }]);
  assert.equal(second.status, 200);
  assert.equal(deltas(await second.text()).map(delta => delta.content ?? "").join(""), "工具完成");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].contents.flatMap(turn => turn.parts).find(part => part.functionCall), realPart);
  assert.deepEqual(requests[1].contents.flatMap(turn => turn.parts).find(part => part.functionResponse).functionResponse,
    { id: "native-1", name: "lookup", response: { ok: true } });
  assert.equal(requests[1].contents[0].parts[1].inlineData.mimeType, "image/png");
});
