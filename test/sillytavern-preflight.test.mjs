import test from "node:test";
import assert from "node:assert/strict";
import { createDiagnostics, formatDiagnostic } from "../integrations/sillytavern/diagnostics-ui.js";
import { createFetchInterceptor, GENERATE_PATH, PLUGIN_PATH, PLUGIN_VERSION } from "../integrations/sillytavern/shared.js";

const identity = { id: "vertex-anti-truncation", version: "0.18.0", ready: true };
const region = "vertex-region-routing";
const usable = { ...identity, version: "0.20.0", features: [region, "stop-after-tag-pairs", "request-diagnostics"] };
const request = { model: "gemini-4-carbon", type: "regenerate", chat_completion_source: "vertexai",
  vertexai_auth_mode: "full", vertexai_service_tier: "standard", vertexai_region: "global", max_tokens: 50000,
  stream: true, messages: [{ role: "user", content: "PRIVATE-PROMPT" }] };

function client(t, status, options = {}) {
  const records = [], sent = [], probes = [];
  const { journal = () => Response.json({ records: [] }), asset = () => new Response(null, { status: 404 }), generate, ...transport } = options;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.endsWith("/vertex-installation.json") || url.endsWith("/vertex-server-receipt/installation.json")) return asset(url);
    if (url === PLUGIN_PATH + "/diagnostics") return journal();
    assert.equal(url, PLUGIN_PATH + "/status");
    probes.push(init);
    return status(init);
  });
  const context = { getRequestHeaders: () => ({ "X-CSRF-Token": "PRIVATE-TOKEN" }) };
  const ui = createDiagnostics({ context, version: PLUGIN_VERSION, path: PLUGIN_PATH, entryPoints: [] });
  const wrapped = createFetchInterceptor(async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    if (generate) return generate();
    return new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  }, { origin: "http://localhost", getMode: () => "streaming",
    getRegions: () => ({ preferred: "eu", regionFallbackEnabled: true, fallbackLocations: ["us", "global"] }),
    startReport(body, config) {
      const trace = ui.start(body, config);
      records.push(trace.record);
      return trace;
    }, ...transport });
  const send = (extra = {}, signal) => wrapped(GENERATE_PATH, { method: "POST", signal, body: JSON.stringify({ ...request, ...extra }) });
  return { send, sent, probes, reports: () => records.map(formatDiagnostic) };
}

test("the Carbon failure report explains each distinct status response without a generation or a second check", async t => {
  const cases = [
    ["no status route", () => new Response("PRIVATE-ERROR", { status: 404 }), /状态检查返回 HTTP 404.*安装状态=N\/A/],
    ["sign-in required", () => new Response(null, { status: 401 }), /HTTP 401，需要登录/],
    ["forbidden", () => new Response(null, { status: 403 }), /HTTP 403，访问被拒绝/],
    ["proxy 502", () => new Response("PRIVATE-PROXY", { status: 502, headers: { "Content-Type": "text/html" } }), /HTTP=502，内容类型=HTML/],
    ["HTML with a 200", () => new Response("<form>PRIVATE-LOGIN</form>", { headers: { "Content-Type": "text/html" } }), /收到了 HTML 网页/],
    ["broken JSON", () => new Response("{PRIVATE-BODY", { headers: { "Content-Type": "application/json" } }), /响应格式错误.*不是有效的 JSON/],
    ["JSON array in place of plugin status", () => Response.json([]), /状态接口响应格式错误，应为 JSON 对象/],
    ["another plugin with the requested capability", () => Response.json({ ...usable, id: "PRIVATE-ID" }), /其他插件的标识/],
    ["empty JSON", () => Response.json({}), /未返回插件标识/],
    ["old protocol without a list", () => Response.json(identity), /已安装并加载（0.18.0），未返回功能清单/],
    ["invalid list", () => Response.json({ ...identity, features: region }), /功能清单格式无效/],
    ["too old even with the capability", () => Response.json({ ...usable, version: "0.3.0" }), /0.3.0.*至少需要 0.3.1/],
    ["unready even with the capability", () => Response.json({ ...usable, ready: false }), /尚未就绪/],
    ["invalid ready flag", () => Response.json({ ...usable, ready: "false" }), /就绪字段格式无效/],
    ["invalid version", () => Response.json({ ...usable, version: "PRIVATE-VERSION" }), /版本号格式错误/],
    ["missing version", () => Response.json({ id: identity.id }), /状态接口缺少版本号/],
    ["loaded without routing", () => Response.json({ ...identity, features: ["PRIVATE-FEATURE", "request-diagnostics"] }), /已安装并加载（0.18.0），该版本未提供区域路由功能。请更新配套服务端插件/],
    ["connection reset", () => { throw new TypeError("PRIVATE-HOST", { cause: Object.assign(new Error(), { code: "ECONNRESET" }) }); }, /未收到 HTTP 响应[\s\S]+ECONNRESET/],
  ];
  for (const [name, status, evidence] of cases) await t.test(name, async t => {
    const app = client(t, status);
    await assert.rejects(app.send(), { code: "region_routing_not_supported" });
    const [report] = app.reports();
    assert.match(report, evidence);
    assert.match(report, /酒馆请求地区=global，界面首选=eu，传给插件的地区参数=eu/);
    assert.match(report, /429 区域切换=开，配置的备用顺序=us → global/);
    assert.match(report, /未通过=vertex-region-routing/);
    assert.match(report, /生成请求=未发出/);
    assert.match(report, /本次没有服务端生成记录/);
    assert.doesNotMatch(report, /PRIVATE-|未取得同编号记录/);
    assert.equal(app.sent.length, 0);
    assert.equal(app.probes.length, 1);
    assert.equal(app.probes[0].cache, "no-store");
    assert.equal(app.probes[0].headers["X-CSRF-Token"], "PRIVATE-TOKEN");
  });
});

test("parallel generations retain their own status even if the second one finishes first, and the next request sees a recovered plugin", async t => {
  const slow = Promise.withResolvers();
  const replies = [slow.promise, Response.json({ ...identity, features: [] }), Response.json(usable)];
  const app = client(t, () => replies.shift());
  const first = app.send();
  await assert.rejects(app.send(), { code: "region_routing_not_supported" });
  slow.resolve(new Response(null, { status: 403 }));
  await assert.rejects(first, { code: "region_routing_not_supported" });
  await (await app.send()).text();
  const [a, b, c] = app.reports();
  assert.match(a, /HTTP 403/); assert.doesNotMatch(a, /0\.18\.0/);
  assert.match(b, /0\.18\.0.*未提供区域路由功能/); assert.match(b, /插件状态检查.*HTTP=200/);
  assert.doesNotMatch(b, /HTTP(?:=| )403\b/);
  assert.match(c, /生成请求=已发起/); assert.doesNotMatch(c, /未通过=/);
  assert.equal(app.probes.length, 3); assert.equal(app.sent.length, 1);
  assert.equal(app.sent[0].url, PLUGIN_PATH + "/generate");
  assert.equal(app.sent[0].body.vertexai_region, "eu");
  assert.deepEqual(app.sent[0].body.vertex_fallback_locations, ["us", "global"]);
});

test("the actual failed gate is reported when the status covers several capabilities", async t => {
  const app = client(t, () => Response.json({ ...identity, features: ["stop-after-tag-pairs"] }),
    { getTagStop: () => ({ tag: "end", count: 2 }) });
  await assert.rejects(app.send(), { code: "region_routing_not_supported" });
  assert.match(app.reports()[0], /本次检查=stop-after-tag-pairs、vertex-region-routing，未通过=vertex-region-routing/);
  assert.equal(app.probes.length, 1); assert.equal(app.sent.length, 0);
});

test("multi-region alone requires support while global without fallback can generate through the same server", async t => {
  let selected = "us";
  const app = client(t, () => Response.json({ ...identity, features: [] }), {
    getRegions: () => ({ preferred: selected, regionFallbackEnabled: false, fallbackLocations: ["eu"] }) });
  await assert.rejects(app.send(), { code: "region_routing_not_supported" });
  selected = "global";
  await (await app.send()).text();
  const [failed, successful] = app.reports();
  assert.match(failed, /429 区域切换=关.*需要区域路由的原因=多区域 us/);
  assert.match(successful, /生成请求=已发起/);
  assert.equal(app.probes.length, 1); assert.equal(app.sent.length, 1);
  assert.equal(app.sent[0].body.vertex_fallback_locations, undefined);
});

test("the reported Carbon request shape includes an omitted region, an empty fallback order and 407733 original bytes", async t => {
  const app = client(t, () => new Response(null, { status: 404 }), {
    getRegions: () => ({ regionFallbackEnabled: true, fallbackLocations: [] }), journal: () => new Response(null, { status: 404 }) });
  const body = { ...request, vertexai_region: undefined, messages: [{ role: "user", content: "" }] };
  body.messages[0].content = "q".repeat(407733 - Buffer.byteLength(JSON.stringify(body)));
  await assert.rejects(app.send(body), { code: "region_routing_not_supported" });
  const [report] = app.reports();
  assert.match(report, /重新生成.*gemini-4-carbon.*service-account.*standard/);
  assert.match(report, /消息数=1，工具数=0，请求字节=407733，最大输出=50000，酒馆流式=true/);
  assert.match(report, /酒馆请求地区=未指定，界面首选=未指定，传给插件的地区参数=未指定，429 区域切换=开，配置的备用顺序=无/);
  assert.match(report, /备用安装检查.*HTTP=404/);
  assert.match(report, /酒馆没有提供配套服务端插件接口.*安装配套服务端插件.*enableServerPlugins.*重启酒馆/);
  assert.match(report, /server\/vertex-anti-truncation.*酒馆根目录的 plugins\/.*config\.yaml.*enableServerPlugins 设为 true/);
  assert.doesNotMatch(report, /qqqq|已安装并加载/);
  assert.equal(app.sent.length, 0);
});

test("a journal that identifies the installed plugin can confirm installation behind a broken status route but cannot authorize generation", async t => {
  const app = client(t, () => new Response(null, {status:404}), {
    journal: () => Response.json({ id: identity.id, version: "0.20.1", records: [{ message: "PRIVATE-OLD-LOG" }] }) });
  await assert.rejects(app.send(), { code: "region_routing_not_supported" });
  const [report] = app.reports();
  assert.match(report, /已安装并加载（0.20.1），已由日志接口确认。状态检查返回 HTTP 404/);
  assert.match(report, /未通过=vertex-region-routing/);
  assert.match(report, /备用安装检查.*HTTP=200.*已核对配套插件标识/);
  assert.doesNotMatch(report, /PRIVATE-|未声明本次需要的功能/);
  assert.equal(app.sent.length, 0);
});

test("stopping a generation while the plugin check is in flight never dispatches a generation or reports a capability failure", async t => {
  const waiting = Promise.withResolvers(), controller = new AbortController();
  const app = client(t, () => waiting.promise);
  const result = app.send({}, controller.signal);
  controller.abort(new DOMException("Stopped", "AbortError"));
  waiting.resolve(Response.json(usable));
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(app.sent.length, 0);
  assert.match(app.reports()[0], /状态=已取消，生成请求=未发出/);
  assert.doesNotMatch(app.reports()[0], /未通过=/);
});

test("a failed ordinary generation automatically collects status after the failure without resending", async t => {
  const app = client(t, () => Response.json(usable), {
    getRegions: () => ({}), generate: () => new Response("<html>PRIVATE-ERROR</html>", {status:502, headers: {"content-type":"text/html"}}),
    journal: () => new Response(null, {status:403}),
  });
  const reply = await app.send();
  await reply.text();
  await new Promise(resolve => setImmediate(resolve));
  const [report] = app.reports();
  assert.match(report, /检查时机=生成失败后/);
  assert.match(report, /生成请求=已发起，HTTP=502，内容类型=HTML/);
  assert.match(report, /首次日志查询.*HTTP=403/);
  assert.doesNotMatch(report, /PRIVATE-|本次没有服务端生成记录/);
  assert.equal(app.probes.length, 1); assert.equal(app.sent.length, 1);
});

test("the copied evidence distinguishes the cause of equal HTTP statuses without exposing error messages, realms or addresses", async t => {
  const json = body => Response.json(body, { status: 403 });
  const html = text => new Response(text, { status: 403, headers: { "content-type": "text/html" } });
  const cases = [
    ["CSRF rejection", () => json({ error: { code: "csrf_token_invalid", message: "PRIVATE-PROMPT" } }), /CSRF 令牌无效（csrf_token_invalid）/],
    ["policy rejection", () => json({ error: { code: "access_policy_denied", message: "PRIVATE-PROMPT" } }), /访问策略拒绝（access_policy_denied）/],
    ["OAuth scope in an error string", () => json({ error: "insufficient_scope", error_description: "PRIVATE-PROMPT" }), /insufficient_scope/],
    ["more specific nested reason", () => json({ error: { status: "PERMISSION_DENIED", details: [
      { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "IP_ADDRESS_BLOCKED", metadata: { address: "PRIVATE-ADDRESS" } }] } }), /PERMISSION_DENIED.*IP_ADDRESS_BLOCKED/],
    ["host whitelist page", () => html("<h1>Forbidden</h1>Access from this host is not allowed. This attempt has been logged. PRIVATE-ADDRESS"), /主机名白名单/],
    ["IP whitelist page", () => html("<p>add your IP address to the\n whitelist or disable whitelist mode</p>PRIVATE-ADDRESS"), /IP 白名单/],
    ["basic challenge", () => new Response(null, { status: 401, headers: { "www-authenticate": 'Basic realm="PRIVATE-REALM"' } }), /认证方式 Basic/],
    ["standard Bearer challenge", () => new Response(null, { status: 403, headers: {
      "www-authenticate": 'Bearer realm="PRIVATE, error=invalid_token", error="insufficient_scope", error_description="PRIVATE-DETAIL"' } }), /insufficient_scope.*认证方式 Bearer/],
    ["unknown private identifier", () => json({ error: { code: "my_private_passphrase", message: "PRIVATE-PROMPT" } }), /原因码未识别/],
    ["truncated JSON", () => new Response('{"error":', { status: 403, headers: { "content-type": "application/json" } }), /HTTP 403.*错误正文不是有效的 JSON/],
    ["200 with an error envelope", () => Response.json({ error: { reason: "session_expired" } }), /session_expired/],
    ["200 with a top-level reason", () => Response.json({ code: "auth_required" }), /auth_required/],
    ["large error", () => json({ error: { message: "q".repeat(20000), code:"csrf_token_invalid" } }), /HTTP 403.*错误正文超过/],
  ];
  for (const [name, status, expected] of cases) await t.test(name, async t => {
    const app = client(t, status, { journal: () => Response.json({ code:"route_not_found" },{status:404}) });
    await assert.rejects(app.send(), { code: "region_routing_not_supported" });
    const [report] = app.reports();
    assert.match(report, expected);
    assert.match(report, /备用安装检查.*route_not_found/);
    assert.doesNotMatch(report, /PRIVATE-|my_private_passphrase|qqqq/);
    if (name === "standard Bearer challenge") assert.doesNotMatch(report, /invalid_token/);
    assert.equal(app.sent.length, 0);
  });
});

test("an HTTP rejection can confirm the responding plugin's identity but cannot grant its advertised capability", async t => {
  const app = client(t, () => Response.json({ ...usable, error:{code:"service_unavailable"} }, {status:503}),
    { journal: () => assert.fail("the status response already identified the plugin") });
  await assert.rejects(app.send(), { code: "region_routing_not_supported" });
  const [report] = app.reports();
  assert.match(report,/已安装并加载（0.20.0）.*HTTP 503.*service_unavailable/);
  assert.match(report,/生成请求=未发出/);
  assert.equal(app.sent.length, 0);
});

test("a status envelope carrying an error cannot authorize a generation even with success HTTP, identity, ready and capabilities", async t => {
  const app = client(t, () => Response.json({ ...usable, error: { code: "policy_denied" } }));
  await assert.rejects(app.send(), { code: "region_routing_not_supported" });
  assert.match(app.reports()[0], /已安装并加载.*状态接口报告错误。policy_denied/);
  assert.equal(app.sent.length, 0);
});

test("breaking an error body preserves the known HTTP failure and the independent journal rejection", async t => {
  const app = client(t, () => new Response(new ReadableStream({ pull(c) { c.error(new TypeError("PRIVATE-SOCKET")); } }),
    {status:403,headers:{"content-type":"application/json"}}), { journal: () => Response.json({error:"invalid_token"},{status:401}) });
  await assert.rejects(app.send(), {code:"region_routing_not_supported"});
  const [report] = app.reports();
  assert.match(report,/HTTP 403.*读取错误正文时中断/);
  assert.match(report,/备用安装检查.*HTTP=401.*invalid_token/);
  assert.doesNotMatch(report,/PRIVATE-SOCKET/);
});

test("a rejection of the generation itself retains its cause separately from a successful status check", async t => {
  const app = client(t, () => Response.json(usable), { generate: () => new Response(
    "<pre>ForbiddenError: Invalid CSRF token. Please refresh the page and try again.</pre>PRIVATE-ADDRESS", {
      status:403,headers:{"content-type":"text/html"} }) });
  const response = await app.send();
  assert.match(await response.text(), /PRIVATE-ADDRESS/);
  const [report] = app.reports();
  assert.match(report,/插件状态检查.*HTTP=200/);
  assert.match(report,/生成请求=已发起，HTTP=403.*HTTP 拒绝详情=酒馆提示 CSRF 令牌无效/);
  assert.doesNotMatch(report,/PRIVATE-/);
  assert.equal(app.sent.length, 1);
});

test("the fallback journal preserves both plugin identity and its rejection reason", async t => {
  for (const status of [200, 503]) await t.test(String(status), async t => {
    const app = client(t, () => new Response(null, { status: 404 }), {
      journal: () => Response.json({ ...identity, records: [], error: { code: "service_unavailable", message: "PRIVATE-LOG" } }, { status }),
    });
    await assert.rejects(app.send(), { code: "region_routing_not_supported" });
    const [report] = app.reports();
    assert.match(report, /已安装并加载（0.18.0），已由日志接口确认/);
    assert.match(report, /备用安装检查.*已核对配套插件标识.*service_unavailable/);
    assert.doesNotMatch(report, /PRIVATE-LOG/);
    assert.equal(app.sent.length, 0);
  });
});

test("code-only plugin rejections identify the connection setting without a server journal", async t => {
  for (const [name, payload, expected] of [
    ["nested missing account", { error: { code: "vertex_service_account_missing" } }, /保存并选择服务账号 JSON/],
    ["top-level Express project", { code: "express_project_required" }, /填写 API Key 所属的项目 ID/],
    ["configuration stage", { error: { code: "vertex_configuration_failed" } }, /Vertex 连接设置有误/],
  ]) await t.test(name, async t => {
    const app = client(t, () => Response.json(usable), {
      generate: () => Response.json(payload, { status: 400 }),
      journal: () => new Response(null, { status: 404 }),
    });
    const response = await app.send();
    await response.text();
    const [report] = app.reports();
    assert.match(report.split("\n")[0], expected);
    const browser = report.split("\n").find(line => line.startsWith("浏览器　"));
    assert.match(browser, expected);
    assert.ok(browser.includes("错误=" + (payload.error?.code ?? payload.code)));
    assert.doesNotMatch(report, /原因码未识别/);
    assert.equal(app.sent.length, 1);
  });
});

test("a JSON array returned by the journal identifies the response format error in the report", async t => {
  const app = client(t, () => new Response(null, { status: 404 }), { journal: () => Response.json(["PRIVATE-LOG"]) });
  await assert.rejects(app.send(), { code: "region_routing_not_supported" });
  const [report] = app.reports();
  assert.match(report, /备用安装检查.*日志接口响应格式错误，应为包含 records 字段的 JSON 对象/);
  assert.doesNotMatch(report, /无效返回|PRIVATE-LOG/);
});

test("an explicit journal error with an empty list never claims a successful search for a dispatched request", async t => {
  const app = client(t, () => Response.json(usable), {
    generate: () => new Response(null, { status: 502 }),
    journal: () => Response.json({ ...identity, records: [], error: { code: "session_expired" } }),
  });
  await (await app.send()).text();
  await new Promise(resolve => setImmediate(resolve));
  const [report] = app.reports();
  assert.match(report, /查询服务端记录失败.*session_expired/);
  assert.match(report, /首次日志查询.*HTTP=200.*session_expired/);
  assert.doesNotMatch(report, /已查询，未找到同编号记录/);
  assert.equal(app.sent.length, 1);
});

test("an unreachable plugin distinguishes live installer evidence, historical records and a frontend-only installation", async t => {
  const receipt = { id: identity.id, version: PLUGIN_VERSION, installedAt: "2026-11-26T00:00:00.000Z", linked: true };
  const missing = () => new Response(null, { status: 404 });
  const scenarios = [
    ["frontend only", null, null, /安装配套服务端插件.*酒馆根目录 config\.yaml.*enableServerPlugins 设为 true.*重启酒馆.*安装状态=N\/A/],
    ["server file present", receipt, receipt, /服务端插件文件已安装.*enableServerPlugins[\s\S]*服务端文件回执=与本次安装一致/],
    ["server file removed", receipt, null, /服务端插件的安装文件回执缺失.*重新安装/],
    ["old linked file", receipt, { ...receipt, version: "0.18.0" }, /服务端文件回执=前后端安装批次不同/],
    ["filesystem without links", { ...receipt, linked: false }, null, /安装状态=N\/A[\s\S]*本次安装未创建文件链接/],
    ["corrupt installation data", { id: identity.id, version: 7 }, null, /安装回执字段格式错误/],
  ];
  for (const [name, historical, live, expected] of scenarios) await t.test(name, async t => {
    const app = client(t, missing, { journal: missing, asset: url => {
      const data = url.endsWith("/vertex-installation.json") ? historical : live;
      return data ? Response.json(data) : missing();
    } });
    await assert.rejects(app.send(), error => error.code === "region_routing_not_supported");
    assert.match(app.reports()[0], expected);
    assert.equal(app.sent.length, 0);
  });
});

test("the startup error identifies the failed component in the displayed error and copied report", async t => {
  const app = client(t, () => Response.json({ ...identity, ready: false, startup: { phase: "tavern-prompts", code: "ERR_MODULE_NOT_FOUND" },
    error: { code: "plugin_startup_failed", message: "PRIVATE-FILE" } }, { status: 503 }));
  await assert.rejects(app.send(), /初始化失败.*导入酒馆 prompt-converters\.js.*ERR_MODULE_NOT_FOUND/);
  assert.match(app.reports()[0], /初始化失败.*导入酒馆 prompt-converters\.js.*ERR_MODULE_NOT_FOUND/);
  assert.doesNotMatch(app.reports()[0], /PRIVATE-/);
  assert.equal(app.sent.length, 0);
});
