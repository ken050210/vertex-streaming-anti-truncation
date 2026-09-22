"use strict";
const $ = id => document.getElementById(id);
const authNames = { "service-account": "完整模式 · 服务账号", express: "快速模式 · API Key", "access-token": "临时 OAuth 令牌" };
const tierNames = { standard: "Standard", flex: "Flex", priority: "Priority" };
const pageNames = { overview: "总览", connection: "连接配置", models: "模型与版本", events: "请求日志", test: "连接测试" };
const modeNames = { normal: "正常", buffered: "非流式抗截断", streaming: "流式抗截断" };
const state = { csrf: null, config: null, status: null, events: [], dirty: false, page: "overview", probe: null, timer: null,
  models: [], catalog: null, selected: new Set() };
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let toastTimer;
function toast(message) { $("toast").textContent = message; $("toast").hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4000); }
function errorMessage(message) {
  const messages = {
    "Invalid local access key": "本地访问密钥不正确。", "Please sign in": "登录已过期，请重新登录。",
    "Invalid VERTEX_PROJECT_ID": "请填写有效的 Google Cloud 项目 ID。", "Invalid VERTEX_API_KEY": "请输入快速模式 API Key。",
    "Invalid VERTEX_ACCESS_TOKEN": "请输入有效的 OAuth Access Token。", "Invalid PORT": "端口必须在 1–65535 之间。",
    "Service account must contain a valid RSA private key": "服务账号中没有有效的 RSA 私钥，请导入完整 JSON。",
    "vertex service account secret is not valid JSON": "服务账号 JSON 格式无效，请检查是否复制完整。",
    "Only Google's OAuth token endpoint is allowed": "服务账号的 token_uri 必须是 Google 官方 OAuth 地址。",
    "Set GATEWAY_API_KEY to a random value of at least 16 characters": "请设置至少 16 字符、不含空格的本地网关密钥。",
    "Configuration changed; reload before saving": "配置已被其他页面修改，请先放弃当前修改并重新加载。",
    "Port is unavailable; the running service has not been changed": "端口已被占用，当前服务保持原状，请更换端口。",
    "Gateway and console must use different ports": "API 端口不能与控制台端口相同。",
    "Requests are still running; wait before stopping the gateway": "仍有请求进行中，请等回复完成后再停止网关。",
    "Express, Flex and Priority require the global location": "Express、Flex 和 Priority 需要使用 global 地区。",
    "Too many attempts; try again in a minute": "尝试次数过多，请在一分钟后重试。",
    "unsupported_native_schema": "Schema 含无法保留的约束，请检查错误中的参数路径。",
    "schema_validation_failed": "模型输出没有符合所需 Schema，请检查输出约束或重试。",
    "empty_completion": "模型没有返回正文或工具调用。",
    "missing_finish_reason": "上游回复缺少结束原因。",
    "upstream_http_error": "上游拒绝了请求，请检查凭据、模型权限、额度及所选档位。",
    "unsupported_native_fields": "此请求含原生接口无法保留的字段，请改用标准服务账号模式或移除不支持的字段。",
    "Invalid upstream Gemini model ID": "请输入有效的 Gemini 上游模型 ID，例如 gemini-3.7-flash。",
    "Invalid public model ID": "客户端模型名称限 160 字符，可用中文、字母、数字、点、短横线、下划线及 @；不能包含空格。",
    "Model IDs must be unique": "客户端模型名称重复，请给每个版本使用不同名称。",
    "Model list must contain at most 100 entries": "最多可保存 100 个模型版本。",
    "Invalid model mode": "请选择有效的模型模式。",
    "Select a saved model before testing": "请先保存并选择一个模型版本。",
    "Model list authentication failed; check the selected credentials": "获取目录的鉴权失败，请检查当前所选凭据。",
    "Unable to fetch the model catalog; check the connection": "无法连接 Google 模型目录，请检查网络后重试。",
    "Model listing was cancelled or timed out": "目录拉取已取消或超时，请重试。",
  };
  if (message?.startsWith("Express model listing is unavailable")) return `当前 Express API Key 无法读取模型目录（${message.match(/HTTP \d+/)?.[0] || "访问受限"}）。可以手动添加模型 ID，或改用服务账号拉取；已保存的模型不受影响。`;
  if (message?.startsWith("Vertex model listing failed")) return `Google 模型目录返回 ${message.match(/HTTP \d+/)?.[0] || "错误"}，请检查鉴权与 API 权限，或手动添加模型 ID。`;
  return messages[message] || message || "操作失败，请重试。";
}
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json", "x-csrf-token": state.csrf || "" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/login") showLogin();
    throw new Error(errorMessage(result.error?.message || result.error?.code));
  }
  return result;
}
function setError(id, message) { $(id).textContent = message || ""; $(id).hidden = !message; }
async function action(button, fn, errorId = "global-error") {
  const controls = ["form-error", "models-error", "discovery-error"].includes(errorId)
    ? [...document.querySelectorAll("#settings-form input,#settings-form button,#settings-form select,#settings-form textarea,#page-models input,#page-models select,#page-models button")].map(el => [el, el.disabled]) : [];
  for (const [el] of controls) el.disabled = true;
  const previous = button.textContent; button.disabled = true; button.textContent = "处理中…";
  setError(errorId, "");
  try { await fn(); } catch (error) { setError(errorId, error.message); $(errorId).scrollIntoView({ block: "nearest" }); }
  finally { for (const [el, disabled] of controls) el.disabled = disabled; button.disabled = false; button.textContent = previous; if (controls.length) updateDraft(false); }
}
function showPage(page) {
  state.page = page;
  for (const key of Object.keys(pageNames)) $("page-" + key).hidden = key !== page;
  document.querySelectorAll("[data-page]").forEach(b => b.setAttribute("aria-current", b.dataset.page === page ? "page" : "false"));
  $("page-title").textContent = pageNames[page];
  $("main").focus({ preventScroll: true }); window.scrollTo({ top: 0 });
}
function showLogin() {
  state.csrf = null; clearInterval(state.timer); state.probe?.abort();
  $("login-view").hidden = false; $("app-view").hidden = true;
  for (const id of ["gateway-key", "service-account", "api-key", "access-token"]) $(id).value = "";
  state.dirty = false;
}
function draft() {
  return { authMode: document.querySelector('[name="authMode"]:checked').value,
    serviceTier: document.querySelector('[name="serviceTier"]:checked').value,
    projectId: $("project-id").value.trim(), location: $("location").value.trim(),
    gatewayKey: $("gateway-key").value.trim(), serviceAccountJson: $("service-account").value.trim(),
    apiKey: $("api-key").value.trim(), accessToken: $("access-token").value.trim(),
    port: Number($("port").value), timeoutMs: Number($("timeout").value) * 1000, antiTruncation: true, models: state.models.map(m => ({ ...m })) };
}
function updateDraft(dirty = true) {
  if (dirty) state.dirty = true;
  const d = draft(); const forcedGlobal = d.authMode === "express" || d.serviceTier !== "standard";
  if (forcedGlobal) $("location").value = "global";
  $("location").disabled = forcedGlobal;
  $("project-id").required = d.authMode !== "express";
  $("project-optional").hidden = d.authMode !== "express";
  $("project-help").textContent = d.authMode === "express" ? "快速模式由 API Key 确定项目；这里可选填备注。" : "填写目标 Google Cloud 项目 ID，可与服务账号所属项目不同。";
  $("credential-service").hidden = d.authMode !== "service-account";
  $("credential-express").hidden = d.authMode !== "express";
  $("credential-token").hidden = d.authMode !== "access-token";
  $("preview-auth").textContent = authNames[d.authMode]; $("preview-tier").textContent = tierNames[d.serviceTier];
  $("preview-location").textContent = $("location").value || "—"; $("preview-port").textContent = d.port || "—";
  $("tier-help").textContent = d.serviceTier === "standard" ? "使用标准档位，不自动升级服务等级。" : d.serviceTier === "flex"
    ? "Flex 使用原生接口，响应等待可能更长。账户和模型须支持该档位；失败时不会自动切换为 Standard。"
    : "Priority 使用优先按量服务，按对应档位计费。实际是否使用 Priority 请查看请求日志中的上游档位。";
  if (d.authMode === "express" && d.serviceTier !== "standard") $("tier-help").textContent += " Express 的档位可用性由上游决定。";
  $("draft-label").textContent = state.dirty ? "有未应用的修改" : "配置已同步";
  $("models-draft-label").textContent = state.dirty ? "有未应用的修改" : "配置已同步";
  $("models-count").textContent = state.models.length + " 个版本";
  $("discard-button").disabled = !state.dirty;
  $("models-discard").disabled = !state.dirty;
  updateSelection();
}
function fillConfig() {
  const c = state.config.settings;
  for (const name of ["authMode", "serviceTier"]) document.querySelector(`[name="${name}"][value="${c[name]}"]`).checked = true;
  for (const [id, name] of [["project-id", "projectId"], ["location", "location"], ["port", "port"]]) $(id).value = c[name];
  $("timeout").value = c.timeoutMs / 1000;
  state.models = c.models.map(m => ({ ...m })); renderModels();
  for (const [id, name] of [["gateway-key", "gatewayKey"], ["service-account", "serviceAccountJson"], ["api-key", "apiKey"], ["access-token", "accessToken"]]) {
    $(id).value = ""; $(id).placeholder = c[name + "Set"] ? "已保存 · 留空保留，输入则替换" : ({ gatewayKey: "至少 16 字符，或生成随机密钥", serviceAccountJson: "粘贴完整的服务账号 JSON，或导入文件", apiKey: "输入 Vertex Express API Key", accessToken: "输入短期 Google OAuth 令牌" })[name];
  }
  $("service-file").value = "";
  state.dirty = false; $("saved-badge").textContent = state.config.saved ? "已保存到本机" : "尚未保存";
  updateDraft(false);
}
function renderStatus() {
  const s = state.status, c = state.config.settings, current = s.active;
  const ready = Boolean(c.gatewayKeySet && (c.authMode === "service-account" ? c.serviceAccountJsonSet : c.authMode === "express" ? c.apiKeySet : c.accessTokenSet));
  const label = s.running ? "运行中" : ready ? "已停止" : "待配置";
  $("rail-status").textContent = label; $("rail-lamp").className = "lamp " + (s.running ? "" : "idle");
  $("metric-status").textContent = label; $("metric-active").textContent = s.running ? s.activeRequests + " 个进行中的请求" : "本地 API 尚未监听";
  $("metric-requests").textContent = s.requests; $("metric-restored").textContent = s.restored;
  $("metric-tier").textContent = tierNames[current?.serviceTier || c.serviceTier];
  $("metric-traffic").textContent = "最近实际上游：" + (s.lastTrafficType || "尚无记录");
  $("runtime-badge").textContent = s.running ? "●  API ONLINE" : "●  " + label;
  $("runtime-badge").className = "badge " + (s.running ? "go" : "hold");
  $("runtime-title").textContent = s.running ? "网关已就绪" : ready ? "网关已停止" : "连接你的 Vertex 项目";
  $("runtime-description").textContent = s.error ? errorMessage(s.error) : s.running ? "本地接口正在监听。上游凭据与模型可用性以实际请求结果为准。" : ready ? "配置已保存，启动后即可接收客户端请求。" : "填写凭据并保存，即可向本地网关发送请求。";
  $("start-button").hidden = s.running || !ready; $("stop-button").hidden = !s.running; $("stop-button").disabled = s.activeRequests > 0; $("setup-button").hidden = ready;
  $("endpoint").textContent = `http://127.0.0.1:${current?.port || c.port}/v1`;
  $("overview-auth").textContent = current ? authNames[current.authMode] : "未启动";
  $("overview-project").textContent = (current || c).authMode === "express" ? "Express · 由 API Key 确定" : (current || c).projectId || "—";
  $("overview-location").textContent = (current || c).location;
  const models = s.running ? s.models : c.models;
  $("overview-anti").textContent = models.length + " 个独立版本";
  $("rail-models").textContent = models.length + " 个" + (s.running ? "已应用" : state.config.saved ? "已保存" : "默认") + "版本";
  for (const id of ["client-model", "probe-model"]) {
    const select = $(id), rows = id === "probe-model" ? s.models : models;
    const options = rows.map(m => `<option value="${esc(m.id)}">${esc(m.id)} · ${modeNames[m.mode]}</option>`).join("") || '<option value="">尚无已应用的模型</option>';
    if (select.innerHTML !== options) { const value = select.value; select.innerHTML = options; if (rows.some(m => m.id === value)) select.value = value; }
  }
  $("model-id").textContent = $("client-model").value;
  updateProbeModel();
}
function updateProbeModel() {
  const row = state.status?.models.find(m => m.id === $("probe-model").value);
  $("probe-model-help").textContent = row ? `${row.upstreamModel} · ${modeNames[row.mode]}` + (row.mode === "buffered" ? " · 完整回复到齐后交付正文。" : "") : "请先在模型与版本中保存配置。";
  $("probe-button").disabled = !row || !$("probe-consent").checked || Boolean(state.probe);
  $("probe-model").disabled = Boolean(state.probe);
  $("probe-stream").disabled = Boolean(state.probe);
}
function renderModels() {
  $("model-rows").innerHTML = state.models.length ? state.models.map((m, i) => `<div class="model-row" data-row="${i}">
    <label>客户端模型名称<input data-field="id" value="${esc(m.id)}" maxlength="160" spellcheck="false" aria-label="模型 ${i + 1} 的客户端名称"></label>
    <label>上游模型 ID<input data-field="upstreamModel" value="${esc(m.upstreamModel)}" maxlength="180" spellcheck="false" aria-label="模型 ${i + 1} 的上游 ID"></label>
    <label>传输模式<select data-field="mode" aria-label="模型 ${i + 1} 的传输模式">${Object.entries(modeNames).map(([v, label]) => `<option value="${v}"${v === m.mode ? " selected" : ""}>${label}</option>`).join("")}</select></label>
    <button class="btn ghost remove-model" data-remove="${i}" aria-label="移除模型 ${i + 1}">移除</button></div>`).join("") : '<div class="empty-state"><strong>还没有模型版本</strong><p>从目录选择或手动添加。保存空列表后，客户端将没有可选模型。</p></div>';
}
function updateSelection() {
  $("add-selected").disabled = !state.selected.size;
  $("add-selected").textContent = state.selected.size ? `添加 ${state.selected.size} 个模型的所选版本` : "添加所选模型的版本";
}
function renderCatalog() {
  if (state.catalog === null) return;
  const search = $("catalog-search").value.trim().toLowerCase();
  const visible = state.catalog.filter(m => (m.id + " " + m.displayName).toLowerCase().includes(search));
  $("catalog-list").innerHTML = visible.map(m => `<label class="catalog-option"><input type="checkbox" data-catalog="${esc(m.id)}"${state.selected.has(m.id) ? " checked" : ""}><span><strong class="mono">${esc(m.id)}</strong><small>${esc(m.displayName)}</small></span></label>`).join("") || '<div class="empty-state"><strong>没有匹配的 Gemini 模型</strong><p>尝试其他搜索词，或手动填写模型 ID。</p></div>';
  updateSelection();
}
function addModels(upstreams) {
  const modes = [...document.querySelectorAll('[name="newMode"]:checked')].map(el => el.value);
  if (!modes.length) throw new Error("请至少勾选一种版本。");
  const next = state.models.map(m => ({ ...m })); let added = 0, skipped = 0;
  for (const raw of upstreams) {
    const id = raw.trim().replace(/^(?:google\/|publishers\/google\/models\/)/, "");
    if (!/^gemini-[a-z0-9][a-z0-9._-]{0,126}(?:@[a-z0-9-]{1,32})?$/.test(id) || id.includes("..")) throw new Error(errorMessage("Invalid upstream Gemini model ID"));
    for (const mode of modes) {
      const upstreamModel = "google/" + id;
      if (next.some(m => m.upstreamModel === upstreamModel && m.mode === mode)) { skipped++; continue; }
      const base = id + ({ normal: "", buffered: "-antitruncation-nonstream", streaming: "-antitruncation-stream" })[mode];
      let alias = base.slice(0, 150), suffix = 2;
      while (next.some(m => m.id === alias)) alias = base.slice(0, 150) + "-" + suffix++;
      next.push({ id: alias, upstreamModel, mode }); added++;
    }
  }
  if (next.length > 100) throw new Error(errorMessage("Model list must contain at most 100 entries"));
  state.models = next; renderModels(); if (added) updateDraft();
  toast(`已添加 ${added} 个版本${skipped ? `，跳过 ${skipped} 个已有版本` : ""}。保存后生效。`);
}
function integrityBadge(result) {
  if (!result) return "";
  const names = { complete: "完整结束", length: "达到长度上限", content_filter: "内容受限 / 拒绝", tool_calls: "工具调用完成",
    incomplete: "响应未完整结束", empty: "没有有效输出", error: "响应失败", cancelled: "客户端已取消" };
  return '<small>' + esc(names[result.outcome] || "尚未确认") + (result.hasReasoning && !result.hasContent && !result.hasToolCalls ? " · 仅思考无正文" : "") + '</small>';
}
function eventTable(events) {
  if (!events.length) return '<div class="empty-state"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7 4h18v24H7zM11 10h10M11 15h10M11 20h6"/></svg><strong>暂无请求记录</strong><p>向网关发送请求后，传输与还原状态会显示在这里。</p></div>';
  return '<div class="table-wrap"><table><thead><tr><th>时间 / 请求</th><th>模型版本</th><th>状态</th><th>传输</th><th>正文还原</th><th>请求 / 实际档位</th><th>耗时</th></tr></thead><tbody>' + events.map(e => {
    const a = e.antiTruncation || {};
    const recovered = a.restored === true ? "已还原" : a.restored === false ? "未还原 / 跳过" : "未确认";
    const transport = a.transport === "tool-transport-native-streaming" ? "原生参数流" : a.transport === "tool-transport-buffered" ? "完整还原" : e.stream ? "SSE 流式" : "普通响应";
    const success = e.status >= 200 && e.status < 300;
    return `<tr><td><span class="mono">${esc(new Date(e.at).toLocaleTimeString("zh-CN", { hour12: false }))}</span><small title="${esc(e.requestId)}">${esc(e.requestId.slice(0, 8))}</small></td><td><span class="mono">${esc(e.model || "—")}</span><small>${esc(modeNames[e.mode] || "")}</small></td><td><span class="badge ${success ? "go" : "stop"}">${e.status}</span>${e.code ? `<small class="error-code">${esc(e.code)}</small>` : ""}${integrityBadge(e.responseIntegrity)}</td><td>${transport}<small>${esc(a.finishReason || "—")}</small></td><td><span class="badge ${a.restored ? "go" : ""}">${recovered}</span><small>${a.streamDone === true ? "流已结束" : a.streamDone === false ? "流未完成" : ""}</small></td><td>${esc(tierNames[e.serviceTier] || "Standard")}<small>${esc(e.trafficType || "上游未报告")}</small></td><td class="mono">${(e.latencyMs / 1000).toFixed(2)} s</td></tr>`;
  }).join("") + "</tbody></table></div>";
}
function renderEvents() {
  $("recent-events").innerHTML = eventTable(state.events.slice(0, 4));
  const filter = $("event-filter").value;
  $("all-events").innerHTML = eventTable(state.events.filter(e => filter === "all" || (filter === "failed" ? e.status >= 400 : e.antiTruncation?.restored === true)));
}
async function refresh() {
  const [status, events] = await Promise.all([api("/api/status"), api("/api/events")]);
  state.status = status; state.events = events.events; renderStatus(); renderEvents();
  setError("global-error", "");
}
async function enter() {
  state.config = await api("/api/config"); fillConfig(); await refresh();
  $("login-key").value = ""; $("login-view").hidden = true; $("app-view").hidden = false;
  showPage(state.config.saved || state.config.settings.gatewayKeySet ? "overview" : "connection");
  clearInterval(state.timer);
  state.timer = setInterval(() => { if (!document.hidden && state.csrf) refresh().catch(e => setError("global-error", e.message)); }, 5000);
}
$("login-form").addEventListener("submit", e => { e.preventDefault(); action(e.submitter, async () => { state.csrf = (await api("/api/login", { key: $("login-key").value })).csrf; await enter(); }, "login-error"); });
document.querySelectorAll("[data-page],[data-go]").forEach(b => b.addEventListener("click", () => showPage(b.dataset.page || b.dataset.go)));
$("settings-form").addEventListener("input", () => updateDraft());
$("settings-form").addEventListener("change", () => updateDraft());
async function saveConfiguration() {
  const result = await api("/api/config", { settings: draft(), revision: state.config.revision });
  state.config = result; fillConfig(); await refresh(); toast("配置已保存并应用，网关正在运行。");
  setError("form-error", ""); setError("models-error", "");
}
async function discardConfiguration() {
  state.config = await api("/api/config"); fillConfig(); setError("form-error", ""); setError("models-error", ""); toast("已重新加载保存的配置。");
}
$("settings-form").addEventListener("submit", e => { e.preventDefault(); action($("save-button"), saveConfiguration, "form-error"); });
$("validate-button").addEventListener("click", e => action(e.currentTarget, async () => { await api("/api/validate", { settings: draft() }); toast("本地配置校验通过，未调用 Google。"); }, "form-error"));
$("discard-button").addEventListener("click", e => action(e.currentTarget, discardConfiguration, "form-error"));
$("models-save").addEventListener("click", e => action(e.currentTarget, saveConfiguration, "models-error"));
$("models-discard").addEventListener("click", e => action(e.currentTarget, discardConfiguration, "models-error"));
$("discover-button").addEventListener("click", e => action(e.currentTarget, async () => {
  const result = await api("/api/models/discover", { settings: draft() });
  state.catalog = result.models; state.selected.clear(); renderCatalog();
  $("catalog-status").textContent = `${new Date(result.fetchedAt).toLocaleTimeString("zh-CN", { hour12: false })} 已拉取 · ${result.models.length} 个 Gemini 模型`;
}, "discovery-error"));
$("catalog-search").addEventListener("input", renderCatalog);
$("catalog-list").addEventListener("change", e => {
  const id = e.target.dataset.catalog; if (!id) return;
  if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
  updateSelection();
});
$("add-selected").addEventListener("click", e => action(e.currentTarget, () => {
  addModels([...state.selected]); state.selected.clear(); renderCatalog();
}, "discovery-error"));
$("add-manual").addEventListener("click", e => action(e.currentTarget, () => { addModels([$("manual-model").value]); $("manual-model").value = ""; }, "discovery-error"));
$("manual-model").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("add-manual").click(); } });
$("model-rows").addEventListener("input", e => {
  const field = e.target.dataset.field, row = e.target.closest("[data-row]");
  if (!field || !row) return;
  state.models[Number(row.dataset.row)][field] = e.target.value; updateDraft();
});
$("model-rows").addEventListener("click", e => {
  const button = e.target.closest("[data-remove]"); if (!button) return;
  const index = Number(button.dataset.remove), removed = state.models[index];
  state.models.splice(index, 1); renderModels(); updateDraft(); toast(`已从草稿移除 ${removed.id}，保存后生效。`);
  $("model-rows").querySelectorAll("input")[Math.min(index, state.models.length - 1) * 2]?.focus();
});
$("client-model").addEventListener("change", () => { $("model-id").textContent = $("client-model").value; });
$("probe-model").addEventListener("change", updateProbeModel);
$("service-file").addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    if (file.size > 128 * 1024) throw new Error("JSON 文件不能超过 128 KB。");
    const raw = (await file.text()).replace(/^\uFEFF/, ""); let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error("文件不是有效的 JSON。"); }
    if (parsed.type !== "service_account" || !parsed.private_key || !parsed.client_email) throw new Error("请导入完整的服务账号 JSON。");
    $("service-account").value = raw;
    if (!$("project-id").value && parsed.project_id) $("project-id").value = parsed.project_id;
    updateDraft(); toast("服务账号已载入表单，保存后生效。");
  } catch (error) { setError("form-error", error.message); } finally { e.target.value = ""; }
});
$("service-account").addEventListener("change", () => { try { const v = JSON.parse($("service-account").value); if (!$("project-id").value && v.project_id) { $("project-id").value = v.project_id; updateDraft(); } } catch { /* Save shows a safe validation message. */ } });
$("generate-key").addEventListener("click", () => { $("gateway-key").value = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join(""); updateDraft(); toast("已生成新密钥，请复制后保存配置。"); });
async function copy(text) { try { await navigator.clipboard.writeText(text); toast("已复制到剪贴板。"); } catch { toast("复制失败，请手动选择文本复制。"); } }
$("copy-key").addEventListener("click", () => $("gateway-key").value ? copy($("gateway-key").value) : toast("已保存的密钥不回显。需要更换时，请生成新密钥。"));
document.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", () => copy($(b.dataset.copy).textContent)));
$("refresh-button").addEventListener("click", e => action(e.currentTarget, refresh));
$("start-button").addEventListener("click", e => action(e.currentTarget, async () => { await api("/api/start", {}); await refresh(); toast("网关已启动。"); }));
$("stop-button").addEventListener("click", e => action(e.currentTarget, async () => { await api("/api/stop", {}); await refresh(); toast("网关已停止，控制台仍可使用。"); }));
$("logout-button").addEventListener("click", e => action(e.currentTarget, async () => { await api("/api/logout", {}); showLogin(); }));
$("event-filter").addEventListener("change", renderEvents);
$("probe-consent").addEventListener("change", updateProbeModel);
$("probe-cancel").addEventListener("click", () => state.probe?.abort());
$("probe-button").addEventListener("click", async () => {
  if (!$("probe-consent").checked || state.probe) return;
  state.probe = new AbortController(); $("probe-button").disabled = true; $("probe-consent").checked = false; $("probe-cancel").hidden = false;
  updateProbeModel();
  $("probe-output").textContent = ""; $("probe-status").textContent = "请求中…"; $("probe-meta").innerHTML = ""; setError("probe-error", "");
  let text = "", usage, finish, restored, done = false, reads = 0, firstAt, lastAt;
  const started = performance.now();
  try {
    const stream = $("probe-stream").checked;
    const response = await fetch("/api/probe", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": state.csrf }, body: JSON.stringify({ confirm: true, stream, model: $("probe-model").value }), signal: state.probe.signal });
    if (!response.ok) { const body = await response.json(); throw new Error(`HTTP ${response.status} · ` + errorMessage(body.error?.message || body.error?.code)); }
    if (stream) {
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
      for (;;) {
        const result = await reader.read(); if (result.done) { buffer += decoder.decode(); break; }
        buffer += decoder.decode(result.value, { stream: true }); let match, hasContent = false;
        while ((match = /\r\n\r\n|\n\n/.exec(buffer))) {
          const raw = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
          const data = raw.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
          if (!data) continue; if (data === "[DONE]") { done = true; continue; }
          const chunk = JSON.parse(data); if (chunk.error) throw new Error("上游流式响应返回错误。");
          for (const choice of chunk.choices || []) { if (choice.delta?.content) { text += choice.delta.content; hasContent = true; } if (choice.finish_reason) finish = choice.finish_reason; }
          if (chunk.usage) usage = chunk.usage;
          if (chunk.router_anti_truncation) restored = chunk.router_anti_truncation.restored;
        }
        if (hasContent) { reads++; firstAt ??= performance.now(); lastAt = performance.now(); $("probe-output").textContent = text; }
      }
      if (!done) throw new Error("流已中断，未收到结束标志。");
    } else {
      const body = await response.json(); text = body.choices?.[0]?.message?.content || ""; finish = body.choices?.[0]?.finish_reason;
      usage = body.usage; restored = body.router_anti_truncation?.restored;
    }
    $("probe-output").textContent = text || "上游未返回可显示正文。";
    $("probe-status").textContent = finish === "stop" && text ? "请求完成" : "检查结束原因";
    const meta = { "请求 ID": response.headers.get("x-request-id"), "结束原因": finish || "未知", "正文还原": restored === true ? "已还原" : restored === false ? "未还原 / 跳过" : "未确认", "实际上游档位": usage?.traffic_type || "上游未报告", "耗时": ((performance.now() - started) / 1000).toFixed(2) + " s", ...(stream ? { "含正文读取次数": reads, "正文到达跨度": ((lastAt || 0) - (firstAt || 0)).toFixed(0) + " ms" } : {}) };
    $("probe-meta").innerHTML = Object.entries(meta).map(([k,v]) => `<div><dt>${esc(k)}</dt><dd class="mono">${esc(v)}</dd></div>`).join("");
  } catch (error) { $("probe-status").textContent = error.name === "AbortError" ? "已取消" : "测试失败"; setError("probe-error", error.name === "AbortError" ? "请求已取消。" : error.message); }
  finally { state.probe = null; $("probe-cancel").hidden = true; $("probe-button").disabled = true; await refresh().catch(() => {}); }
});
function applyTheme(theme) { document.documentElement.dataset.theme = theme; $("theme-button").textContent = theme === "dark" ? "浅色主题" : "深色主题"; }
try { applyTheme(localStorage.getItem("vertex-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")); } catch { applyTheme("light"); }
$("theme-button").addEventListener("click", () => { const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; applyTheme(theme); try { localStorage.setItem("vertex-theme", theme); } catch { /* Theme remains usable. */ } });
window.addEventListener("beforeunload", e => { if (state.dirty || state.probe) { e.preventDefault(); e.returnValue = ""; } });
(async () => {
  const setup = new URLSearchParams(location.hash.slice(1)).get("setup");
  if (setup) history.replaceState(null, "", location.pathname);
  try {
    const session = await api("/api/session");
    if (session.setup) { $("login-title").textContent = "首次设置"; $("login-description").textContent = "请打开启动终端中的首次设置链接，或输入链接中的设置密钥。"; }
    if (session.authenticated) { state.csrf = session.csrf; await enter(); }
    else if (setup) { state.csrf = (await api("/api/login", { key: setup })).csrf; await enter(); }
  } catch (error) { setError("login-error", error.message); }
})();
