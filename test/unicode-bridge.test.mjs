import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { prepareUnicodeInput } from "../src/unicode-input.mjs";

test("Tavern bridge reads the live user floor, preserves custom parameters and sends only to the local router", async () => {
  const calls = [], response = new Response('unchanged SSE');
  const original = async (...args) => { calls.push(args); return response; };
  const chat = [{ is_user: true, mes: 'older' }, { is_user: true, mes: '最新😀' }, { is_system: true, is_user: true, mes: 'ignored system' }];
  const host = { location: { origin: 'http://127.0.0.1:8000', href: 'http://127.0.0.1:8000/' },
    SillyTavern: { getContext: () => ({ chat }) }, fetch: original, addEventListener() {} };
  host.parent = host.top = host;
  const iframe = { location: { origin: 'null', href: 'about:srcdoc' }, parent: host, top: host, fetch: original, addEventListener() {} };
  const context = vm.createContext({ window: iframe, URL, Request, mockLoadYaml: async () => ({ parse: JSON.parse }) });
  const code = (await readFile(new URL('../integrations/sillytavern-unicode-floor.js', import.meta.url), 'utf8')).replace(/\}\)\(\);\s*$/, '})(mockLoadYaml);');
  vm.runInContext(code, context);
  const body = { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:4781/v1',
    messages: [{ role: 'system', content: '引用最新😀' }, { role: 'user', content: '最新😀' }, { role: 'user', content: 'preset tail' }],
    custom_include_body: JSON.stringify([{ thinking: { type: 'disabled' } }, { temperature: 0.5 }]) };
  const init = { method: 'POST', body: JSON.stringify(body), headers: { 'x-test': 'unchanged' } };
  assert.equal(await host.fetch('/api/backends/chat-completions/generate', init), response);
  const posted = JSON.parse(calls[0][1].body), custom = JSON.parse(posted.custom_include_body);
  assert.equal(custom.router_unicode_input.user_floor, '最新😀');
  assert.equal(custom.temperature, 0.5);
  assert.deepEqual(custom.thinking, { type: 'disabled' });
  assert.deepEqual(posted.messages, body.messages);
  assert.equal(calls[0][1].headers, init.headers);
  assert.equal(init.body, JSON.stringify(body));
  const routed = prepareUnicodeInput({ messages: posted.messages, ...custom }, true, 65536);
  assert.equal(routed.metadata.occurrences, 2);
  assert.equal(routed.payload.messages[2].content, 'preset tail');
  assert.equal(routed.payload.router_unicode_input, undefined);
  chat.push({ is_user: true, mes: ['next ', { text: 'floor' }] });
  await host.fetch(new Request('http://127.0.0.1:8000/api/backends/chat-completions/generate', init));
  assert.equal(JSON.parse(JSON.parse(calls[1][1].body).custom_include_body).router_unicode_input.user_floor, 'next floor');
  for (const custom_url of ['https://example.com/v1', 'http://127.0.0.1:5000/v1', 'http://127.0.0.1:4781/wrong']) {
    const other = { ...init, body: JSON.stringify({ ...body, custom_url }) };
    await host.fetch('/api/backends/chat-completions/generate', other);
    assert.equal(calls.at(-1)[1], other);
  }
  await host.fetch('/unrelated', init);
  assert.equal(calls.at(-1)[1], init);
  await assert.rejects(host.fetch('/api/backends/chat-completions/generate', { ...init, body: JSON.stringify({ ...body, custom_include_body: 'invalid' }) }), /YAML is invalid/);
  vm.runInContext(code, context); // replaces its own hook without nesting
  host.__gatewayUnicodeFloorBridge__.dispose();
  assert.equal(host.fetch, original);
});
