// Tavern Helper script: pass the latest real chat floor to the local router.
// No encoding, output interception, credentials, storage or chat/preset edits.
(function (loadYaml) {
  'use strict';
  const gatewayPort = '4781'; // Match the gateway port if you change its configuration.
  loadYaml ||= async owner => (await import(new URL('/lib.js', owner.location.href).href)).yaml;
  const hosts = [];
  for (const host of [window, window.parent, window.top]) {
    // Tavern Helper runs in srcdoc/about:blank: its location.origin may be null
    // while its parent is accessible under the inherited same-origin policy.
    try { if (host && !hosts.includes(host)) { void host.location.href; hosts.push(host); } } catch (_) { /* cross-origin */ }
  }
  const owner = hosts.find(host => host.SillyTavern?.getContext) || hosts.at(-1);
  if (!owner) return;
  const apiName = '__gatewayUnicodeFloorBridge__';
  owner[apiName]?.dispose();
  const patches = [];
  let disposed = false;
  let yamlPromise;
  function asText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : item?.text ?? item?.content ?? '').join('');
    if (value && typeof value === 'object') return String(value.text ?? value.content ?? '');
    return value == null ? '' : String(value);
  }
  function currentFloor() {
    const chats = [];
    const add = value => { if (Array.isArray(value) && !chats.includes(value)) chats.push(value); };
    for (const host of hosts) { try { add(host.SillyTavern?.getContext?.()?.chat); } catch (_) {} }
    if (!chats.length) for (const host of hosts) { try { add(host.context?.chat); } catch (_) {} }
    if (!chats.length) for (const host of hosts) { try { add(host.chat); } catch (_) {} }
    const chat = chats[0] || [];
    for (let index = chat.length - 1; index >= 0; index--) {
      const floor = chat[index];
      if (!floor || floor.is_system === true) continue;
      if (typeof floor.is_user === 'boolean' ? floor.is_user : String(floor.role || '').toLowerCase() === 'user') {
        return asText(floor.mes ?? floor.content ?? floor.message ?? floor.text ?? '');
      }
    }
    return '';
  }
  function targetsRouter(body) {
    if (body?.chat_completion_source !== 'custom') return false;
    try {
      const url = new URL(body.custom_url);
      return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        && url.port === gatewayPort && /^\/v1\/?$/.test(url.pathname);
    } catch (_) { return false; }
  }
  async function processBody(raw) {
    let body;
    try { body = JSON.parse(raw); } catch (_) { return raw; }
    if (!targetsRouter(body)) return raw;
    const floor = currentFloor();
    // No inferred final-user fallback. The router reports missing floor on opt-in models.
    if (!floor) return raw;
    const yaml = await (yamlPromise ||= loadYaml(owner));
    let parsed;
    try { parsed = body.custom_include_body ? yaml.parse(body.custom_include_body) : {}; }
    catch (_) { throw new Error('Gateway Unicode: custom request-body YAML is invalid'); }
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    const merged = Array.isArray(parsed) ? Object.assign({}, ...parsed.filter(object)) : object(parsed) ? { ...parsed } : {};
    merged.router_unicode_input = { user_floor: floor };
    return JSON.stringify({ ...body, custom_include_body: JSON.stringify(merged) });
  }
  for (const host of hosts) {
    if (typeof host.fetch !== 'function') continue;
    const original = host.fetch;
    const wrapped = async function (input, init) {
      const request = typeof input === 'object' && input !== null && typeof input.clone === 'function' && typeof input.text === 'function';
      let url;
      try { url = new URL(request ? input.url : String(input), host.location.href); } catch (_) { return original.call(this, input, init); }
      const method = String(init?.method || (request ? input.method : 'GET')).toUpperCase();
      if (disposed || method !== 'POST' || url.origin !== host.location.origin || url.pathname !== '/api/backends/chat-completions/generate') return original.call(this, input, init);
      const raw = typeof init?.body === 'string' ? init.body : request && init?.body === undefined ? await input.clone().text() : null;
      if (raw === null) return original.call(this, input, init);
      const body = await processBody(raw);
      if (body === raw) return original.call(this, input, init);
      return original.call(this, input, { ...init, body });
    };
    host.fetch = wrapped;
    patches.push({ host, original, wrapped });
  }
  const api = { dispose() {
    disposed = true;
    for (const patch of patches) if (patch.host.fetch === patch.wrapped) patch.host.fetch = patch.original;
    if (owner[apiName] === api) delete owner[apiName];
  } };
  owner[apiName] = api;
  window.addEventListener('pagehide', api.dispose, { once: true });
})();
