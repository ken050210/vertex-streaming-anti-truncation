import { configurationProblem, deviceEnvironment, googleProblem, HISTORY_LIMIT, networkCodes, oauthProblem, pluginFrames, requestFields, safeCode, safeVersion, systemCodes } from "./diagnostic-fields.js";
import { validVertexLocation } from "../../src/vertex-locations.mjs";
import { backendFinding, endpointProblem, probeBackend, readDiagnosticEndpoint, readPluginJournal } from "./backend-status.js";
import { PLUGIN_PATH } from "./shared.js";
import { encodingHistory } from "./optimized-input.js";

const stages = { request: "校验请求", image: "图片转换", configuration: "读取连接配置", authentication: "获取 Google 凭据",
  upstream: "请求 Vertex", restoration: "读取或还原 Vertex 回复" };
const paths = { plugin: "酒馆插件直连", tauri: "TauriTavern", paygo: "Vertex PayGo", native: "酒馆原生", prepare: "扩展准备请求" };
const states = { pending: "进行中", ok: "已结束", error: "失败", cancelled: "已取消", disconnected: "下游连接中断", interrupted: "页面已重载" };
const operations = { normal: "发送", generate: "生成", regenerate: "重新生成", swipe: "切换回复", continue: "继续",
  quiet: "后台生成", impersonate: "代写", group_chat: "群聊", connection: "检查插件连接" };
const timings = obj => Object.entries(obj ?? {}).map(([key, value]) => (stages[key] ?? key) + " " + value + "ms").join(" → ");
const formatCodes = values => values?.map(code => (systemCodes[code] ?? "") + " " + code).join("、").trim();
function headline(row) {
  const server = row.server;
  if (row.responseProblem) return "生成接口响应格式错误，" + row.responseProblem + "。";
  if (row.backendBlocked && row.backendStatus)
    return backendFinding(row.backendStatus, row.failedCheck);
  if (row.backendStatus?.startup || (row.httpStatus === 404 && row.backendStatus?.http === 404 && row.serverLookup?.http === 404))
    return backendFinding(row.backendStatus, row.failedCheck, row.backendStatus.other ?? row.serverLookup);
  if (!server && row.httpStatus >= 400 && row.httpRejection && row.httpRejection !== "具体原因=N/A")
    return "HTTP " + row.httpStatus + " · " + row.httpRejection;
  if (!server && row.code === "http_error" && row.contentType === "HTML") return "收到 HTML 错误页 · HTTP " + row.httpStatus;
  if (row.state === "cancelled") return "酒馆已取消生成";
  if (row.code === "stream_ended_without_done") return "流式连接已结束，未收到结束标记 [DONE]。";
  const setting = configurationProblem(server?.configReason ?? server?.code ?? row.code) ?? oauthProblem(server?.oauthReason);
  if (setting) return setting;
  const google = googleProblem(server?.google ?? row.google);
  if (google) return google;
  const cause = formatCodes(server?.network) || formatCodes(row.network) || server?.google?.reason || server?.google?.status ||
    row.google?.reason || row.google?.status || server?.code || row.code || states[server?.state ?? row.state];
  return [stages[server?.stage] ?? paths[row.route], cause, row.httpStatus >= 400 ? "HTTP " + row.httpStatus : ""].filter(Boolean).join(" · ");
}

export function formatDiagnostic(row) {
  const s = row.server, env = { ...s?.client, ...row.env }, req = row.request ?? s?.request ?? {};
  const b = row.backendStatus, routing = row.routing, install = b?.installation;
  const fields = (pairs) => pairs.filter(([, v]) => v != null && v !== "").map(([k, v]) => k + "=" + v).join("，");
  const attempts = s?.attempts?.map(a => a.location + " " + (a.status ?? "未收到响应头") +
    (a.headersMs != null ? " @" + a.headersMs + "ms" : "") + (a.upstreamRequestId ? " #" + a.upstreamRequestId : "")).join(" → ");
  const log = row.serverLookup;
  const missing = row.dispatched === false ? "浏览器尚未发出生成请求，本次没有服务端生成记录。" :
    log === "unsupported" ? "本次状态检查显示插件未声明请求日志功能。" :
    log?.result === "ok" ? "已查询，未找到同编号记录" + (log.storage ? "（服务端日志文件无法读取）" : "") :
    log ? "查询服务端记录失败，" + (endpointProblem(log) ?? "日志接口未返回记录列表") : "未取得同编号记录";
  const lines = [
    "Vertex AI 抗截断 · " + headline(row),
    "请求编号 " + row.id, "时间 " + row.at + (row.offset ? "（浏览器时区 " + row.offset + "）" : ""),
    ["环境", fields([["宿主", env.host], ["酒馆版本", env.tavern ?? "未取得"], ["宿主提交", env.revision], ["设备系统", env.os], ["浏览器", env.browser]])],
    ["扩展", fields([["版本", env.extension], ["构建", env.build], ["服务端插件", s?.version ?? b?.version ?? env.backend],
      ["服务端构建", s?.build ?? b?.build ?? env.serverBuild], ["服务端系统", s?.os ?? b?.os ?? env.serverOS],
      ["架构", s?.arch ?? b?.arch ?? env.arch], ["Node", s?.node ?? b?.node ?? env.node]])],
    ["配套服务端", b ? backendFinding(b, row.failedCheck, b.other ?? log) : s?.version ? "已由本次服务端记录确认加载（" + s.version + "）。" :
      row.probePhase ? "未取得此次自动检查结果" : row.route === "plugin" && row.state === "error" ? "此报告未保存服务端插件检查结果" : undefined],
    ["插件状态检查", b && fields([["接口", "GET " + PLUGIN_PATH + "/status"], ["检查时机", row.probePhase], ["时间", b.at], ["耗时毫秒", b.elapsedMs],
      ["HTTP", b.http ?? "未收到"], ["内容类型", b.type], ["发生重定向", b.redirected], ["网络", formatCodes(b.network)],
      ["就绪声明", b.identified ? b.ready ?? "未提供" : undefined], ["最低兼容版本", b.minimumVersion],
      ["本次检查", row.backendChecks?.join("、")], ["未通过", row.failedCheck],
      ["已识别功能", b.identified ? b.features?.join("、") || (b.features ? "无" : b.invalidFeatures ? "格式无效" : "未提供") : undefined]])],
    ["一键安装记录", install && fields([["HTTP", install.evidence.http ?? "未收到"], ["安装时版本", install.version], ["安装时间", install.at],
      ["结果", install.version ? "前后端安装完成" : endpointProblem(install.evidence) ?? "无效返回"],
      ["服务端文件回执", install.file ? install.file.result === "ok" ? "与本次安装一致" : endpointProblem(install.file) ?? "无效返回" : install.linked === false ? "本次安装未创建文件链接" : undefined]])],
    ["备用安装检查", b?.other && fields([["接口", "GET " + PLUGIN_PATH + "/diagnostics"], ["HTTP", b.other.http ?? "未收到"],
      ["内容类型", b.other.type], ["耗时毫秒", b.other.elapsedMs], ["结果", [b.other.identified && "已核对配套插件标识", endpointProblem(b.other)].filter(Boolean).join("，")
        || (b.other.result === "legacy-log" ? "收到旧格式记录列表，接口未声明插件标识" : "响应未标明配套插件")]])],
    ["操作", fields([["类型", operations[req.operation]], ["模型", req.model], ["路由", paths[row.route]], ["旁路原因", row.bypass],
      ["鉴权", req.authentication], ["等级", req.tier], ["首选地区", routing ? undefined : row.region], ["配置地区", s?.locations?.join(" → ")], ["代理 Agent", s?.proxyAgent]])],
    ["区域设置", routing && fields([["酒馆请求地区", routing.input], ["界面首选", routing.preferred], ["传给插件的地区参数", routing.effective],
      ["429 区域切换", routing.fallback ? "开" : "关"], ["配置的备用顺序", routing.locations], ["需要区域路由的原因", routing.reason]])],
    ["请求", fields([["消息数", req.messages], ["工具数", req.tools], ["请求字节", s?.inputBytes ?? row.inputBytes], ["最大输出", req.requestedTokens],
      ["实际输出上限", s?.outputLimit?.applied ?? row.applied], ["酒馆流式", req.stream], ["抗截断模式", row.mode], ["上游传输", s?.transport ?? row.transport],
      ["转码", row.encoding ?? s?.client?.encoding], ["自动选中格式", row.selectedFormat ?? s?.client?.selectedFormat], ["转图", row.imageMode ?? s?.imageMode], ["正文工具", s?.textTool ?? row.textTool], ["分段续写", s?.outputLimit?.longDecode ?? row.longDecode],
      ["标签截停次数", s?.tagStop ? s.stopCount : row.stopCount], ["截停等待", s?.waitForUsage ?? row.waitForUsage]])],
    ["浏览器", fields([["状态", states[row.state]], ["生成请求", row.dispatched == null ? undefined : row.dispatched ? "已发起" : "未发出"], ["HTTP", row.httpStatus], ["内容类型", row.contentType],
      ["宿主后端 HTTP", row.hostStatus], ["宿主响应头毫秒", row.hostHeadersMs],
      ["耗时毫秒", row.elapsedMs ?? (row.state === "pending" ? Math.max(0, Date.now() - Date.parse(row.at)) : undefined)],
      ["响应头毫秒", row.headersMs], ["首段正文毫秒", row.firstTextMs], ["最近数据毫秒", row.lastDataMs],
      ["收到字节", row.bytesReceived], ["结束标记", row.doneMarker], ["结束原因", row.finishReason], ["标签截停", row.tagStopped],
      ["事件超出诊断大小限制", row.observerLimit], ["错误", row.code], ["HTTP 拒绝详情", row.httpRejection], ["网络", formatCodes(row.network)]])],
    ["服务端", s ? fields([["状态", states[s.state]], ["阶段", stages[s.stage]], ["已发 HTTP", s.httpStatus], ["错误状态", s.resultStatus],
      ["错误码", s.code], ["配置原因", s.configReason], ["OAuth 超时毫秒", s.oauthTimeoutMs], ["耗时毫秒", s.elapsedMs], ["首次写出毫秒", s.firstWriteMs], ["最近写出毫秒", s.lastWriteMs],
      ["已写字节", s.bytesSent], ["超时上限毫秒", s.timeoutMs], ["OAuth HTTP", s.oauthStatus], ["异常", s.exception],
      ["网络", formatCodes(s.network)], ["上游结束原因", s.upstreamFinish], ["日志位置", s.storage === "stderr" ? "酒馆服务端控制台" : undefined]]) :
      row.route === "plugin" && req.operation !== "connection" ? missing : undefined],
    ["服务端请求编号", (row.replyIdState || s?.idSource) && fields([["响应头", row.replyIdState], ["返回编号", row.replyId ?? s?.id],
      ["编号来源", s?.idSource === "server" ? "服务端生成" : s?.idSource === "request" ? "沿用请求头" : undefined]])],
    ["首次日志查询", row.firstLookup && fields([["HTTP", row.firstLookup.http ?? "未收到"], ["内容类型", row.firstLookup.type],
      ["结果", endpointProblem(row.firstLookup) ?? (row.firstLookup.result === "ok" ? "已返回记录列表" : "日志接口未返回有效记录")]])],
    ["酒馆版本检查", env.versionProblem],
    ["服务端时间线", timings(s?.timeline)], ["Vertex 地区 / HTTP", attempts],
    ["Google", fields([["代码", s?.google?.code], ["状态", s?.google?.status ?? row.google?.status],
      ["原因", s?.google?.reason ?? row.google?.reason], ["OAuth 原因", s?.oauthReason], ["拦截类别", s?.google?.blocked?.join(", ")]])],
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
  let panel, list, output, include, provider, note, quickCopy, manualCopy, lastErrorText, connectionStatus, latestFailure, lookup, selectedId, hostVersion;
  const pendingProbes = new Map();
  const getHeaders = () => context.getRequestHeaders();
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
  function statusChanged(text) {
    lastErrorText.hidden = !latestFailure || text.includes(quickCopy.title);
  }
  function render() {
    if (!panel) return;
    const records = available();
    const failed = records.find(row => [row.state, row.server?.state].some(state => state === "error" || state === "disconnected"));
    if (failed?.id !== latestFailure?.id) {
      quickCopy.textContent = "复制错误报告";
      manualCopy.hidden = true;
    }
    latestFailure = failed;
    quickCopy.hidden = !failed;
    quickCopy.title = failed ? headline(failed) : "";
    lastErrorText.textContent = failed ? "最近错误　" + quickCopy.title : "";
    statusChanged(connectionStatus.textContent);
    panel.hidden = !failed && !active.size;
    if (!panel.open || panel.hidden) return;
    const selected = list.value;
    list.replaceChildren(...records.map(row => new Option(new Date(row.at).toLocaleTimeString() + " · " +
      (operations[row.request?.operation ?? row.server?.request?.operation] ?? "生成") + " · " + (row.request?.model ?? row.server?.request?.model ?? "") + " · " + headline(row), row.id)));
    if (records.some(row => row.id === selected)) list.value = selected;
    list.hidden = !records.length;
    note.textContent = records.length ? "" : "暂无请求记录";
    display();
  }
  async function loadServer() {
    if (direct) return;
    if (lookup) return lookup;
    lookup = (async () => {
      const { evidence, data } = await readPluginJournal(path, getHeaders);
      if (evidence.result !== "ok") {
        if (panel?.open) note.textContent = "服务端记录暂时不可用，已显示本机记录。";
        return evidence;
      }
      if (data.storage === "unavailable") evidence.storage = true;
      let reconciled = false;
      for (const server of data.records) {
        if (typeof server?.id !== "string" || typeof server.at !== "string" || !Object.hasOwn(states, server.state)) {
          evidence.result = "records";
          continue;
        }
        const exact = active.get(server.id) ?? rows.get(server.id);
        let row = exact;
        if (server.idSource === "server" && !exact?.request) {
          const matches = available().filter(r => r.request && r.replyId === server.id);
          if (matches.length === 1) {
            row = matches[0];
            if (exact && exact !== row) rows.delete(server.id);
          }
        }
        if (row) {
          if (rows.has(row.id) && server.state !== "pending" && row.server?.state !== server.state) reconciled = true;
          if (server.state !== "pending" || !row.server || row.server.state === "pending") row.server = server;
        }
        else if (server.state !== "pending") {
          rows.set(server.id, { id: server.id, at: server.at, state: server.state, route: "plugin", server });
          reconciled = true;
        }
      }
      if (reconciled) saveHistory();
      render();
      if (evidence.storage && panel?.open) note.textContent = "服务端日志文件暂时无法读取，已显示可用记录。";
      return evidence;
    })().finally(() => { lookup = null; });
    return lookup;
  }
  async function collectServer(row) {
    if (row.route !== "plugin" || row.dispatched === false || (row.server && row.server.state !== "pending" && row.state !== "pending")) return;
    if (row.backendStatus?.features && !row.backendStatus.features.includes("request-diagnostics")) row.serverLookup = "unsupported";
    else {
      row.serverLookup = await loadServer();
      row.firstLookup ??= row.serverLookup;
    }
    if (rows.has(row.id)) saveHistory();
  }
  async function copy(row, button, extra = false) {
    if (!row) return;
    const text = () => formatDiagnostic(row) + (extra && previews.get(row.id) ? "\nGoogle 说明　" + previews.get(row.id) : "");
    const pending = Promise.all([pendingProbes.get(row.id), hostVersion, collectServer(row)]);
    try {
      if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": pending.then(() => new Blob([text()], { type: "text/plain" })) })]);
      } else { await pending; await navigator.clipboard.writeText(text()); }
      if (row.id === (button === quickCopy ? latestFailure?.id : list.value)) {
        button.textContent = "已复制";
        manualCopy.hidden = true;
      }
    } catch {
      await pending;
      manualCopy.hidden = false; manualCopy.value = text(); manualCopy.focus(); manualCopy.select();
      if (row.id === (button === quickCopy ? latestFailure?.id : list.value)) button.textContent = "手动复制";
    }
  }
  function start(body, { mode, imageMode, unicodeMode, signal, choiceId }) {
    const id = requestId(), at = new Date(), began = performance.now();
    const row = { id, at: at.toISOString(), offset: "UTC" + (at.getTimezoneOffset() > 0 ? "−" : "+") +
      String(Math.floor(Math.abs(at.getTimezoneOffset()) / 60)).padStart(2, "0") + ":" + String(Math.abs(at.getTimezoneOffset()) % 60).padStart(2, "0"),
      state: "pending", route: "prepare", dispatched: false, env: { ...env }, request: requestFields(body), mode, imageMode,
      encoding: unicodeMode === true ? "unicode" : unicodeMode ? safeCode(String(unicodeMode).replaceAll("-", "_")) : "off",
      selectedFormat: choiceId ? encodingHistory(context.accountStorage).find(entry => String(entry.id) === choiceId)?.format : undefined,
      region: validVertexLocation(body.vertexai_region) ? body.vertexai_region : undefined,
      inputBytes: new Blob([JSON.stringify(body)]).size, bytesReceived: 0 };
    active.set(id, row);
    if (hostVersion && !env.tavern && !env.versionProblem) void hostVersion.then(() => {
      Object.assign(row.env, { tavern: env.tavern, revision: env.revision, versionProblem: env.versionProblem });
      if (rows.has(id)) saveHistory();
      render();
    });
    render();
    const elapsed = () => Math.round(performance.now() - began);
    function inspectBackend(beforeSend) {
      if (row.backendStatus) return row.backendStatus;
      if (pendingProbes.has(id)) return pendingProbes.get(id);
      row.probePhase = beforeSend ? "发出生成请求前" : "生成失败后";
      const probeSignal = beforeSend ? signal : undefined;
      const check = probeBackend(getHeaders, beforeSend, probeSignal, true).then(result => {
        row.backendStatus = result;
        pendingProbes.delete(id);
        if (rows.has(id)) saveHistory();
        render();
        return result;
      });
      pendingProbes.set(id, check);
      return check;
    }
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
      if (state === "error") {
        if (row.route === "plugin" && row.dispatched && !row.server?.version && !row.backendStatus) void inspectBackend(false);
        void Promise.all([pendingProbes.get(id), collectServer(row)]).then(render);
      }
    }
    signal?.addEventListener("abort", abort, { once: true });
    return { record: row, elapsed, finish, preview(text) { previews.set(id, text); },
      async supportsBackend(feature) {
        const name = feature ?? "base";
        (row.backendChecks ??= []).push(name);
        const info = await inspectBackend(true);
        signal?.throwIfAborted();
        const supported = info.result === "ok" && (!feature || info.features?.includes(feature) === true);
        if (!supported) row.failedCheck = name;
        return supported;
      },
      backendMessage() { return backendFinding(row.backendStatus, row.failedCheck); },
      thrown(error, fallback) {
        if (signal?.aborted) return abort();
        row.network = networkCodes(error);
        row.frames = pluginFrames(error);
        const code = safeCode(error.code) ?? (/^(?:plugin_not_ready|input_encoding_conflict|(?:paygo|image_input|region_routing|tag_stop|transport_tool_name|meow_compat|natural_stop_usage)_[a-z_]+)$/.test(error.message) ? safeCode(error.message) : undefined);
        finish("error", code ?? fallback);
      } };
  }
  return { start, statusChanged, async connectionChecked(info, manual) {
    if (info.result === "ok") {
      if (info.features?.includes("request-diagnostics")) await loadServer();
    } else {
      await hostVersion;
      // A startup check must not replace the request the user came back to copy.
      if (!manual && latestFailure) return;
      keep({ id: requestId(), at: info.at, state: "error", route: "plugin", request: { operation: "connection" },
        env: { ...env }, backendBlocked: true, backendStatus: info, probePhase: manual ? "手动检查插件连接" : "加载插件时", dispatched: false });
      render();
    }
  }, mount(parent, actions) {
    connectionStatus = parent.querySelector(".vertex-antitruncation-status");
    quickCopy = Object.assign(document.createElement("button"), { type: "button", className: "menu_button", textContent: "复制错误报告", hidden: true });
    quickCopy.onclick = () => copy(latestFailure, quickCopy);
    actions.append(quickCopy);
    lastErrorText = document.createElement("small");
    manualCopy = Object.assign(document.createElement("textarea"), { readOnly: true, rows: 5, hidden: true });
    manualCopy.setAttribute("aria-label", "手动复制错误报告");
    parent.append(lastErrorText, manualCopy);
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
    render();
    hostVersion = readDiagnosticEndpoint("/version", () => ({}), 3000).then(({ evidence, data }) => {
      if (evidence.result === "ok") {
        env.tavern = safeVersion(direct ? data?.tauriVersion ?? data?.pkgVersion : data?.pkgVersion);
        if (/^[a-f0-9]{6,40}$/i.test(data?.gitRevision ?? "")) env.revision = data.gitRevision;
      }
      if (!env.tavern) env.versionProblem = endpointProblem(evidence) ?? "酒馆未报告版本号";
    });
  } };
}
