import { deviceEnvironment, HISTORY_LIMIT, networkCodes, pluginFrames, requestFields, safeCode, safeVersion, systemCodes } from "./diagnostic-fields.js";
import { validVertexLocation } from "../../src/vertex-locations.mjs";

const stages = { request: "校验请求", image: "图片转换", configuration: "读取连接配置", authentication: "获取 Google 凭据",
  upstream: "请求 Vertex", restoration: "读取或还原 Vertex 回复" };
const paths = { plugin: "酒馆插件直连", tauri: "TauriTavern", paygo: "Vertex PayGo", native: "酒馆原生", prepare: "扩展准备请求" };
const states = { pending: "进行中", ok: "已结束", error: "失败", cancelled: "已取消", disconnected: "下游连接中断", interrupted: "页面已重载" };
const operations = { normal: "发送", generate: "生成", regenerate: "重新生成", swipe: "切换回复", continue: "继续",
  quiet: "后台生成", impersonate: "代写", group_chat: "群聊" };
const timings = obj => Object.entries(obj ?? {}).map(([key, value]) => (stages[key] ?? key) + " " + value + "ms").join(" → ");
const formatCodes = values => values?.map(code => (systemCodes[code] ?? "") + " " + code).join("、").trim();
function headline(row) {
  const server = row.server;
  if (!server && row.code === "http_error" && row.contentType === "HTML") return "收到 HTML 错误页 · HTTP " + row.httpStatus;
  if (row.state === "cancelled") return "酒馆已取消生成";
  const cause = formatCodes(server?.network) || formatCodes(row.network) || server?.google?.reason || server?.google?.status ||
    row.google?.reason || row.google?.status || server?.code || row.code || states[server?.state ?? row.state];
  return [stages[server?.stage] ?? paths[row.route], cause, row.httpStatus >= 400 ? "HTTP " + row.httpStatus : ""].filter(Boolean).join(" · ");
}

export function formatDiagnostic(row) {
  const s = row.server, env = { ...s?.client, ...row.env }, req = row.request ?? s?.request ?? {};
  const fields = (pairs) => pairs.filter(([, v]) => v != null && v !== "").map(([k, v]) => k + "=" + v).join("，");
  const attempts = s?.attempts.map(a => a.location + " " + (a.status ?? "未收到响应头") +
    (a.headersMs != null ? " @" + a.headersMs + "ms" : "") + (a.upstreamRequestId ? " #" + a.upstreamRequestId : "")).join(" → ");
  const lines = [
    "Vertex AI 抗截断 · " + headline(row), "请求编号 " + row.id, "时间 " + row.at + (row.offset ? "（" + row.offset + "）" : ""),
    ["环境", fields([["宿主", env.host], ["酒馆版本", env.tavern ?? "未取得"], ["宿主提交", env.revision], ["设备系统", env.os], ["浏览器", env.browser]])],
    ["扩展", fields([["版本", env.extension], ["构建", env.build], ["服务端插件", s?.version ?? env.backend],
      ["服务端构建", s?.build ?? env.serverBuild], ["服务端系统", s?.os ?? env.serverOS],
      ["架构", s?.arch ?? env.arch], ["Node", s?.node ?? env.node]])],
    ["操作", fields([["类型", operations[req.operation]], ["模型", req.model], ["路由", paths[row.route]], ["旁路原因", row.bypass],
      ["鉴权", req.authentication], ["等级", req.tier], ["首选地区", row.region], ["配置地区", s?.locations?.join(" → ")], ["代理 Agent", s?.proxyAgent]])],
    ["请求", fields([["消息数", req.messages], ["工具数", req.tools], ["请求字节", s?.inputBytes ?? row.inputBytes], ["最大输出", req.requestedTokens],
      ["实际输出上限", s?.outputLimit?.applied ?? row.applied], ["酒馆流式", req.stream], ["抗截断模式", row.mode], ["上游传输", s?.transport ?? row.transport],
      ["转码", row.encoding ?? s?.client?.encoding], ["转图", row.imageMode ?? s?.imageMode], ["正文工具", s?.textTool ?? row.textTool], ["分段续写", s?.outputLimit?.longDecode ?? row.longDecode],
      ["标签截停次数", s?.tagStop ? s.stopCount : row.stopCount], ["截停等待", s?.waitForUsage ?? row.waitForUsage]])],
    ["浏览器", fields([["状态", states[row.state]], ["HTTP", row.httpStatus], ["内容类型", row.contentType],
      ["宿主后端 HTTP", row.hostStatus], ["宿主响应头毫秒", row.hostHeadersMs],
      ["耗时毫秒", row.elapsedMs ?? (row.state === "pending" ? Math.max(0, Date.now() - Date.parse(row.at)) : undefined)],
      ["响应头毫秒", row.headersMs], ["首段正文毫秒", row.firstTextMs], ["最近数据毫秒", row.lastDataMs],
      ["收到字节", row.bytesReceived], ["结束标记", row.doneMarker], ["结束原因", row.finishReason], ["标签截停", row.tagStopped],
      ["事件超出诊断大小限制", row.observerLimit], ["错误", row.code], ["网络", formatCodes(row.network)]])],
    ["服务端", s ? fields([["状态", states[s.state]], ["阶段", stages[s.stage]], ["已发 HTTP", s.httpStatus], ["错误状态", s.resultStatus],
      ["错误码", s.code], ["配置原因", s.configReason], ["OAuth 超时毫秒", s.oauthTimeoutMs], ["耗时毫秒", s.elapsedMs], ["首次写出毫秒", s.firstWriteMs], ["最近写出毫秒", s.lastWriteMs],
      ["已写字节", s.bytesSent], ["超时上限毫秒", s.timeoutMs], ["OAuth HTTP", s.oauthStatus], ["异常", s.exception],
      ["网络", formatCodes(s.network)], ["上游结束原因", s.upstreamFinish], ["日志位置", s.storage === "stderr" ? "酒馆服务端控制台" : undefined]]) :
      row.route === "plugin" ? "未取得同编号记录" : undefined],
    ["服务端时间线", timings(s?.timeline)], ["Vertex 地区 / HTTP", attempts],
    ["Google", fields([["代码", s?.google?.code], ["状态", s?.google?.status ?? row.google?.status],
      ["原因", s?.google?.reason ?? row.google?.reason], ["拦截类别", s?.google?.blocked?.join(", ")]])],
    ["插件调用位置", s?.frames?.join(" ← ") ?? row.frames?.join(" ← ")],
  ];
  return lines.filter(line => typeof line === "string" || line[1]).map(line => typeof line === "string" ? line : line.join("　")).join("\n");
}

// Short fingerprint of the loaded entry points, including manual edits. Works on HTTP LAN installations.
function fingerprint(parts) {
  let hash = 2166136261;
  for (const part of parts) for (const char of String(part)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function requestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

export function createDiagnostics({ context, path, version, direct, entryPoints }) {
  const env = { host: direct ? "TauriTavern" : "SillyTavern", ...deviceEnvironment(navigator.userAgent), extension: version,
    build: fingerprint([...entryPoints, createDiagnostics, formatDiagnostic]) };
  const active = new Map(), rows = new Map(), previews = new Map();
  const storage = context.accountStorage;
  const scopeKey = "vertex-anti-truncation.diagnostic-scope";
  const scope = storage?.getItem(scopeKey) || requestId();
  if (storage && !storage.getItem(scopeKey)) storage.setItem(scopeKey, scope);
  const key = scopeKey + "." + scope;
  const stored = () => {
    try { return JSON.parse(localStorage.getItem(key) ?? "[]"); } catch { return []; }
  };
  for (const row of stored()) rows.set(row.id, row);
  let panel, list, output, include, provider, note, alerts, lookup, selectedId, ready = true;
  function keep(row) {
    rows.set(row.id, row);
    saveHistory();
  }
  function saveHistory() {
    const records = [...rows.values()].sort((a, b) => b.at.localeCompare(a.at));
    const errors = records.filter(r => r.state !== "ok").slice(0, HISTORY_LIMIT);
    const lastOK = records.find(r => r.state === "ok");
    const kept = lastOK ? [...errors, lastOK] : errors;
    for (const id of rows.keys()) if (!kept.some(r => r.id === id)) { rows.delete(id); previews.delete(id); }
    // Merge with other tabs of the same account before saving.
    const all = new Map([...stored(), ...kept].map(r => [r.id, r]));
    const sorted = [...all.values()].sort((a, b) => b.at.localeCompare(a.at));
    const save = sorted.filter(r => r.state !== "ok").slice(0, HISTORY_LIMIT);
    const success = sorted.find(r => r.state === "ok");
    try { localStorage.setItem(key, JSON.stringify(success ? [...save, success] : save)); } catch { /* Current tab retains the report. */ }
  }
  const available = () => [...active.values(), ...rows.values()].sort((a, b) => b.at.localeCompare(a.at));
  function display() {
    const row = active.get(list.value) ?? rows.get(list.value);
    if (selectedId !== row?.id) { include.checked = false; provider.open = false; selectedId = row?.id; }
    output.hidden = !row;
    const extra = previews.get(row?.id);
    provider.hidden = !extra;
    provider.querySelector("pre").textContent = extra ?? "";
    output.value = row ? formatDiagnostic(row) + (extra && include.checked ? "\nGoogle 说明　" + extra : "") : "";
    panel.querySelector("[data-copy]").hidden = !row;
  }
  function render() {
    if (!panel?.open) return;
    const selected = list.value, records = available();
    list.replaceChildren(...records.map(row => new Option(new Date(row.at).toLocaleTimeString() + " · " +
      (operations[row.request?.operation ?? row.server?.request?.operation] ?? "生成") + " · " + (row.request?.model ?? row.server?.request?.model ?? "") + " · " + headline(row), row.id)));
    if (records.some(row => row.id === selected)) list.value = selected;
    list.hidden = !records.length;
    note.textContent = records.length ? "" : "暂无请求记录";
    display();
  }
  async function loadServer() {
    if (!ready || direct) return;
    if (lookup) return lookup;
    lookup = (async () => {
      try {
        const response = await fetch(path + "/diagnostics", { cache: "no-store", headers: context.getRequestHeaders(), signal: AbortSignal.timeout(2000) });
        if (!response.ok) throw Error();
        const data = await response.json();
        let reconciled = false;
        for (const server of data.records) {
          const row = active.get(server.id) ?? rows.get(server.id);
          if (row) {
            if (rows.has(row.id) && server.state !== "pending" && row.server?.state !== server.state) reconciled = true;
            if (server.state !== "pending" || !row.server || row.server.state === "pending") row.server = server;
          }
          else if (server.state !== "pending") rows.set(server.id, { id: server.id, at: server.at, state: server.state, route: "plugin", server });
        }
        if (reconciled) saveHistory();
        render();
        if (data.storage && panel?.open) note.textContent = "服务端日志文件暂时无法读取，已显示可用记录。";
      } catch { if (panel?.open) note.textContent = "服务端记录暂时不可用，已显示本机记录。"; }
      finally { lookup = null; }
    })();
    return lookup;
  }
  async function copy(row, button, extra = false) {
    if (!row) return;
    const text = () => formatDiagnostic(row) + (extra && previews.get(row.id) ? "\nGoogle 说明　" + previews.get(row.id) : "");
    const pending = row.route === "plugin" && (!row.server || row.server.state === "pending" || row.state === "pending") ? loadServer() : null;
    try {
      if (pending && navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": pending.then(() => new Blob([text()], { type: "text/plain" })) })]);
      } else { await pending; await navigator.clipboard.writeText(text()); }
      button.textContent = "已复制";
    } catch {
      // Keep the fallback in the visible chat bar even if the connections drawer is closed.
      let area = button.parentElement.querySelector("textarea");
      if (!area) { area = document.createElement("textarea"); area.readOnly = true; area.rows = 5; area.setAttribute("aria-label", "手动复制错误报告"); button.parentElement.append(area); }
      area.hidden = false; area.value = text(); area.focus(); area.select(); button.textContent = "手动复制";
    }
  }
  function notify(row) {
    if (!alerts || row.request?.operation === "quiet") return;
    // Keep a button bound to its own report even if another generation fails.
    const bar = document.createElement("div");
    bar.className = "vertex-error-bar";
    const label = document.createElement("span");
    label.textContent = headline(row);
    const button = document.createElement("button");
    button.type = "button"; button.className = "menu_button"; button.textContent = "复制错误报告";
    button.onclick = () => copy(row, button);
    const close = document.createElement("button");
    close.type = "button"; close.className = "menu_button"; close.textContent = "关闭"; close.onclick = () => bar.remove();
    bar.append(label, button, close); alerts.prepend(bar);
    while (alerts.children.length > 3) alerts.lastChild.remove();
  }
  function start(body, { mode, imageMode, unicodeMode, signal }) {
    const id = requestId(), at = new Date(), began = performance.now();
    const row = { id, at: at.toISOString(), offset: "UTC" + (at.getTimezoneOffset() > 0 ? "−" : "+") +
      String(Math.floor(Math.abs(at.getTimezoneOffset()) / 60)).padStart(2, "0") + ":" + String(Math.abs(at.getTimezoneOffset()) % 60).padStart(2, "0"),
      state: "pending", route: "prepare", env: { ...env }, request: requestFields(body), mode, imageMode,
      encoding: unicodeMode === true ? "unicode" : unicodeMode ? safeCode(String(unicodeMode).replaceAll("-", "_")) : "off",
      region: validVertexLocation(body.vertexai_region) ? body.vertexai_region : undefined,
      inputBytes: new Blob([JSON.stringify(body)]).size, bytesReceived: 0 };
    active.set(id, row);
    render();
    const elapsed = () => Math.round(performance.now() - began);
    const abort = () => {
      if (row.doneMarker) return finish("ok");
      if (signal.reason?.name === "TimeoutError") return finish("error", "browser_timeout");
      finish("cancelled", signal.reason === "Clicked stop button" ? "tavern_stop" : "request_aborted");
    };
    function finish(state, code) {
      if (row.state !== "pending") return;
      signal?.removeEventListener("abort", abort);
      row.state = state; row.code = code; row.elapsedMs = elapsed();
      active.delete(id); keep(row); render();
      if (state === "error") { notify(row); if (row.route === "plugin" && !row.server) void loadServer(); }
    }
    signal?.addEventListener("abort", abort, { once: true });
    return { record: row, elapsed, finish, preview(text) { previews.set(id, text); },
      thrown(error, fallback) {
        row.network = networkCodes(error);
        row.frames = pluginFrames(error);
        const code = safeCode(error.code) ?? (/^(?:plugin_not_ready|input_encoding_conflict|(?:paygo|image_input|region_routing|tag_stop|transport_tool_name|meow_compat|natural_stop_usage)_[a-z_]+)$/.test(error.message) ? safeCode(error.message) : undefined);
        finish(signal?.aborted ? "cancelled" : "error", code ?? fallback);
      } };
  }
  return { start, backend(data) {
    if (!data) return;
    ready = data.features?.includes("request-diagnostics");
    Object.assign(env, { backend: data.version, serverBuild: data.environment?.build, serverOS: data.environment?.os,
      arch: data.environment?.arch, node: data.environment?.node });
  }, mount(parent) {
    panel = document.createElement("details");
    panel.className = "vertex-diagnostic-panel";
    panel.innerHTML = '<summary>最近请求</summary><div class="vertex-fields"><select aria-label="选择请求"></select><small role="status"></small><textarea aria-label="诊断报告" rows="7" readonly hidden></textarea><details hidden><summary>Google 返回的说明</summary><pre></pre><label><input type="checkbox"> 复制时附上这段说明</label></details><button type="button" class="menu_button" data-copy>复制报告</button><button type="button" class="menu_button" data-refresh>刷新记录</button></div>';
    parent.append(panel);
    list = panel.querySelector("select"); output = panel.querySelector("textarea"); note = panel.querySelector("small");
    provider = panel.querySelector("details"); include = provider.querySelector("input");
    const button = panel.querySelector("[data-copy]");
    list.onchange = () => { include.checked = false; provider.open = false; button.textContent = "复制报告"; display(); };
    include.onchange = display;
    button.onclick = () => copy(active.get(list.value) ?? rows.get(list.value), button, include.checked);
    panel.ontoggle = () => { if (panel.open) { render(); void loadServer(); } };
    panel.querySelector("[data-refresh]").onclick = () => { render(); void loadServer(); };
    alerts = document.createElement("div"); alerts.id = "vertex-generation-errors"; alerts.setAttribute("aria-live", "polite");
    (document.querySelector("#send_form") ?? parent).before(alerts);
    fetch("/version", { signal: AbortSignal.timeout(3000) }).then(r => r.json()).then(data => {
      env.tavern = safeVersion(direct ? data.tauriVersion ?? data.pkgVersion : data.pkgVersion);
      if (/^[a-f0-9]{6,40}$/i.test(data.gitRevision ?? "")) env.revision = data.gitRevision;
      for (const row of active.values()) Object.assign(row.env, { tavern: env.tavern, revision: env.revision });
    }).catch(() => {});
  } };
}
