"use strict";
const $ = id => document.getElementById(id);
const authNames = { "service-account": "完整模式 · 服务账号", express: "快速模式 · API Key", "access-token": "临时 OAuth 令牌", custom: "自定义上游 · OpenAI 兼容" };
const tierNames = { standard: "Standard", flex: "Flex", priority: "Priority" };
const pageNames = { overview: "总览", connection: "连接配置", models: "模型与版本", events: "请求日志", test: "连接测试" };
const modeNames = { normal: "正常", buffered: "非流式抗截断", streaming: "流式抗截断" };
const transportNames = { "tool-transport-native-streaming": "原生参数流", "tool-transport-buffered": "完整还原", "tool-transport": "非流式还原",
  "tool-transport-buffered-fields": "兼容接口回退（可能等全文）", "existing-tools": "跳过：旧版 functions", "tool-choice": "跳过：指定工具调用",
  "structured-output": "跳过：结构化输出", "multiple-candidates": "跳过：多候选", "tool-history": "跳过：旧版 function 历史", unknown: "未知" };
const consoleDown = "无法连接本地控制台，请确认控制台进程仍在运行。";
const replyInterrupted = "回复中途中断（网关已断开连接），请按请求 ID 在请求日志查看错误码。";
const state = { csrf: null, config: null, status: null, events: [], dirty: false, page: "overview", probe: null, timer: null,
  models: [], catalog: null, selected: new Set(), forcedGlobal: false, userLocation: "global", pendingDraft: null, refreshError: null, rendered: {} };
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const upstreamHost = url => { try { return new URL(url).host; } catch { return url; } };
let toastTimer;
function toast(message) { $("toast").textContent = message; $("toast").hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4000); }
function errorMessage(message) {
  const catalogFailed = "Google 模型目录返回异常，未应用部分列表，可重试或手动添加模型 ID。";
  const messages = {
    "Add at least one additional account before enabling rotation": "请先添加至少一个附加账号，再启用轮询。",
    "Accounts must all use Vertex or all use custom upstreams": "主账号与附加账号须同为 Vertex 或同为自定义上游，请调整账号的鉴权方式。",
    "Invalid ACCOUNT_TIMEOUT_MS": "单账号超时须为 1–1800 秒。",
    "Invalid ACCOUNT_FAILURE_THRESHOLD": "连续失败阈值须为 1–100 次。",
    "Invalid ACCOUNT_COOLDOWN_MS": "恢复等待时间须为 1–3600 秒。",
    "account_timeout": "此账号超过单账号超时限制。",
    "accounts_unavailable": "所有账号都在恢复等待中，请稍后重试。",
    "Invalid local access key": "本地访问密钥不正确。", "Please sign in": "登录已过期，请重新登录。",
    "Invalid VERTEX_PROJECT_ID": "请填写有效的 Google Cloud 项目 ID。", "Invalid VERTEX_API_KEY": "请输入快速模式 API Key。",
    "Invalid VERTEX_ACCESS_TOKEN": "请输入有效的 OAuth Access Token。", "Invalid PORT": "端口必须在 1–65535 之间。",
    "Service account must contain a valid RSA private key": "服务账号中没有有效的 RSA 私钥，请导入完整 JSON。",
    "vertex service account secret is not valid JSON": "服务账号 JSON 格式无效，请检查是否复制完整。",
    "Only Google's OAuth token endpoint is allowed": "服务账号的 token_uri 必须是 Google 官方 OAuth 地址。",
    "Set GATEWAY_API_KEY to a random value of at least 16 characters": "请设置 16–512 个可见 ASCII 字符、不含空格的随机本地网关密钥，可用“生成随机密钥”。",
    "GATEWAY_API_KEY must contain only visible ASCII characters": "本地网关密钥只能包含可见 ASCII 字符（英文字母、数字和半角符号），请检查是否混入中文引号或全角字符，并在连接配置中更换后保存。",
    "VERTEX_API_KEY must contain only visible ASCII characters": "Express API Key 只能包含可见 ASCII 字符，请检查是否混入中文引号或全角字符，并在连接配置中重新粘贴后保存。",
    "VERTEX_ACCESS_TOKEN must contain only visible ASCII characters": "OAuth Access Token 只能包含可见 ASCII 字符，请检查是否混入中文引号或全角字符，并在连接配置中重新粘贴后保存。",
    "Invalid CUSTOM_UPSTREAM_URL": "请填写有效的上游地址：以 http:// 或 https:// 开头，不含账号密码、? 和 #，例如 https://relay.example.com/v1。",
    "Invalid CUSTOM_UPSTREAM_API_KEY": "请输入上游 API Key，不能含空格。",
    "CUSTOM_UPSTREAM_API_KEY must contain only visible ASCII characters": "上游 API Key 只能包含可见 ASCII 字符，请检查是否混入中文引号或全角字符，并在连接配置中重新粘贴后保存。",
    "Unable to reach the custom upstream; check its URL and the connection": "无法连接自定义上游，请检查上游地址和网络后重试。",
    "Configuration changed; reload before saving": "配置已被其他页面修改，请先放弃当前修改并重新加载。",
    "Configuration is being edited by another process": "配置正在被另一个进程保存，请稍后重试。",
    "Port is unavailable; the running service has not been changed": "端口已被占用，当前服务保持原状，请更换端口。",
    "Gateway and console must use different ports": "API 端口不能与控制台端口相同。",
    "Requests are still running; wait before stopping the gateway": "仍有请求进行中，请等回复完成后再停止网关。",
    "Express, Flex and Priority require the global location": "Express、Flex 和 Priority 需要使用 global 地区。",
    "express_project_required": "快速模式使用 Gemini 4 Argon 需要填写 API Key 所属的项目 ID。请在连接配置中补填并保存，以指定 global 地区。",
    "Too many attempts; try again in a minute": "尝试次数过多，请在一分钟后重试。",
    "unsupported_native_schema": "Schema 含无法保留的约束，请检查错误中的参数路径。",
    "schema_validation_failed": "模型输出没有符合所需 Schema，请检查输出约束或重试。",
    "empty_completion": "模型没有返回正文或工具调用。",
    "missing_finish_reason": "上游回复缺少结束原因。",
    "upstream_http_error": "上游拒绝了请求，请检查凭据、模型权限、额度及所选档位。",
    "unsupported_native_fields": "此请求含原生接口无法保留的字段，请改用标准服务账号模式或移除不支持的字段。",
    "Invalid upstream Gemini model ID": "请输入有效的 Gemini 上游模型 ID，例如 gemini-3.7-flash。从自定义上游切回 Vertex 时，不符合这种写法的上游模型名需要先改掉。",
    "Invalid custom upstream model name": "上游模型名不能为空，不能含换行等控制字符，最长 200 个字符。",
    "Invalid public model ID": "客户端模型名称限 160 字符，可用中文、字母、数字、点、短横线、下划线及 @；不能包含空格。",
    "Model IDs must be unique": "客户端模型名称重复，请给每个版本使用不同名称。",
    "Model list must contain at most 100 entries": "最多可保存 100 个模型版本。",
    "Invalid model enabled setting": "模型的启用状态必须是开或关。",
    "Invalid compatibility toggle": "兼容功能的开关必须是开或关。",
    "Enter custom text before enabling prompt retry": "请先填写自定义文本，再开启提示词提交失败重试。",
    "Prompt retry text must be at most 192000 UTF-8 bytes": "重试文本不能超过 192000 个 UTF-8 字节。",
    "prompt_submission_failed": "上游仍未接受提示词（The prompt could not be submitted），请调整提示词后重试。",
    "model_disabled": "该模型版本已停用，请先在模型与版本中启用并保存。",
    "Invalid model mode": "请选择有效的模型模式。",
    "Select a saved model before testing": "请先保存并选择一个模型版本。",
    "Model list authentication failed; check the selected credentials": "获取目录的鉴权失败，请检查当前所选凭据。",
    "Unable to fetch the model catalog; check the connection": "无法连接 Google 模型目录，请检查网络后重试。",
    "Model listing was cancelled or timed out": "目录拉取已取消或超时，请重试。",
    "Invalid model catalog response": catalogFailed,
    "Model catalog response is too large": catalogFailed,
    "Invalid model catalog pagination": catalogFailed,
    "Model catalog exceeded the page limit; no partial list was applied": catalogFailed,
    "Invalid VERTEX_LOCATION": "地区格式无效：须以小写字母开头，只含小写字母、数字和短横线，例如 us-central1。",
    "Invalid UPSTREAM_TIMEOUT_MS": "上游超时须为 1–1800 秒之间的整数（环境变量 UPSTREAM_TIMEOUT_MS 以毫秒计，为 1000–1800000）。",
    "Prompt retry error matches must list 1-32 texts of at most 500 characters": "触发重试的上游错误最多 32 行，每行不超过 500 个字符。",
    "vertex service account secret must contain type, client_email, private_key and an HTTPS token_uri": "请粘贴 type 为 service_account 的完整服务账号 JSON；gcloud 登录生成的用户凭据不能用。",
    "Invalid service tier": "服务等级无效，请在连接配置中重新选择并保存。",
    "Invalid authentication mode": "鉴权方式无效，请在连接配置中重新选择并保存。",
    "Invalid image input mode": "图片输入模式无效，请重新选择。",
    "Unicode and image input are mutually exclusive": "Unicode 输入转码与图片输入不能同时开启。",
    "Another operation is in progress": "另一个操作正在进行，请稍后重试。",
    "Cannot lock configuration": "无法锁定配置文件，请检查状态目录的写入权限后重试。",
    "Local operation failed; check file permissions and port availability": "本机操作失败，请检查状态目录的文件权限以及端口是否可用。",
    "Saved configuration is invalid; the existing file was preserved": "已保存的配置文件无效，原文件已保留。请修正或移走状态目录中的 settings.json 后刷新页面。",
    "Cannot read saved configuration": "无法读取已保存的配置，请检查状态目录的读取权限。",
    "Session verification failed": "会话校验失败，请刷新页面后重试。",
    "Start the gateway first": "网关未运行，请先在总览启动网关。",
    "A paid test must be explicitly requested": "请先勾选同意发送测试请求。",
    "The gateway did not respond in time": "本地网关在超时时间内没有响应。稍后可在请求日志查看这次请求的结果。",
    "Cannot reach the local gateway": "控制台连接不上本地网关，请在总览确认网关正在运行。",
    "Unable to read the Google service-account file (GOOGLE_APPLICATION_CREDENTIALS)": "无法读取 GOOGLE_APPLICATION_CREDENTIALS 指向的服务账号文件。",
    "Configure exactly one upstream authentication method: GOOGLE_APPLICATION_CREDENTIALS, VERTEX_ACCESS_TOKEN, VERTEX_API_KEY or CUSTOM_UPSTREAM_URL": "GOOGLE_APPLICATION_CREDENTIALS、VERTEX_ACCESS_TOKEN、VERTEX_API_KEY 和 CUSTOM_UPSTREAM_URL 只能设置其中一个。",
    "Unable to read the prompt retry text file (GEMINI_PROMPT_RETRY_TEXT_FILE)": "无法读取 GEMINI_PROMPT_RETRY_TEXT_FILE 指向的重试文本文件。",
    "credential_error": "凭据无效或无法换取访问令牌：检查密钥/令牌是否含中文引号、全角字符等非 ASCII 字符，服务账号 JSON 是否被删除或停用，系统时间，以及到 oauth2.googleapis.com 的网络。",
    "upstream_unreachable": "无法连接上游：请检查网络、代理和 DNS；使用自定义上游时再核对上游地址。",
    "upstream_protocol_error": "上游回复格式异常或中途断开，可以重试；反复出现时请在请求日志查看详情。",
    "upstream_stream_error": "上游在流式回复中返回了错误，可以重试；若附带 Google 的错误信息，请据此检查。",
    "native_stream_error": "上游原生流式回复返回了错误，可以重试；若附带 Google 的错误信息，请据此检查。",
    "invalid_finish_reason": "上游回复的结束原因无法识别，可以重试；反复出现时请记下请求 ID 排查。",
    "upstream_timeout":"超过上游超时仍未完成，请重试，或在连接配置中调高上游超时。",
    "image_render_failed": "本地图片渲染或编码失败，不是 Google 的问题。可以重试，或关闭图片输入。",
    "image_renderer_unavailable": "本机无法加载图片渲染组件或字体，请重新安装依赖，或关闭图片输入。",
    "image_input_too_large": "转成图片后的请求超过大小上限，请缩短对话，或改用“当前轮转图”。",
    "image_input_unsupported_characters": "文本含图片字体无法显示的字符（如部分表情或控制字符），请删除这些字符或关闭图片输入。",
    "image_input_conflict": "Unicode 输入转码与图片输入不能同时开启。",
    "unicode_input_too_large": "Unicode 转码后请求超过大小上限，请缩短内容或关闭 Unicode 输入转码。",
    "unicode_floor_required": "已开启 Unicode 输入转码，但请求没有附带 router_unicode_input.user_floor（最新用户楼层原文）。请让客户端附带该字段，或关闭 Unicode 输入转码。",
    "gateway_port_changed": "网关端口已更改，旧端口不再接受请求，请改用新端口。",
    "request_too_large": "请求超过 8 MiB 上限。",
    "empty_upstream_stream": "上游流式回复为空。",
    "client_disconnected": "客户端已断开连接。",
    "upstream_body_limit": "上游回复超过大小上限。",
    "invalid_upstream_json": "上游回复不是有效的 JSON。",
    "upstream_error_object": "上游返回了错误对象。",
    "invalid_upstream_completion": "上游回复不是有效的补全结果。",
  };
  const envPrefix = "Environment settings were ignored: ";
  if (message?.startsWith(envPrefix)) return "已忽略环境变量中的设置：" + errorMessage(message.slice(envPrefix.length)) + "请在连接配置中填写并保存；保存后控制台改用保存的配置。";
  const toggle = /^Invalid (UNICODE_INPUT|HIDE_UNAVAILABLE_MODELS|GEMINI_PREFILL_TO_USER|GEMINI_LONG_DECODE|GEMINI_PROMPT_RETRY_ENABLED)$/.exec(message || "");
  if (toggle) return `环境变量 ${toggle[1]} 只能是 true 或 false。`;
  if (message?.startsWith("anti_truncation_")) return `抗截断正文还原失败（${message}），可以重试，或用正常版本对比。`;
  if (message?.startsWith("Express model listing is unavailable")) return `当前 Express API Key 无法读取模型目录（${message.match(/HTTP \d+/)?.[0] || "访问受限"}）。可以手动添加模型 ID，或改用服务账号拉取；已保存的模型不受影响。`;
  if (message?.startsWith("Custom upstream model listing failed")) return `自定义上游的模型列表返回 ${message.match(/HTTP \d+/)?.[0] || "错误"}，请检查上游地址和 API Key，或手动添加模型 ID。`;
  if (message?.startsWith("Vertex model listing failed")) return `Google 模型目录返回 ${message.match(/HTTP \d+/)?.[0] || "错误"}，请检查鉴权与 API 权限，或手动添加模型 ID。`;
  // Integrity and protocol codes without their own entry keep the raw code visible.
  if (!messages[message] && /^[a-z][a-z0-9_]*$/.test(message || "")) return `网关返回错误码 ${message}，可以重试；反复出现时请记下错误码和请求 ID 排查。`;
  return messages[message] || message || "操作失败，请重试。";
}
async function request(path, body, signal, retried = false) {
  let response;
  try {
    response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", signal,
      headers: body === undefined ? {} : { "content-type": "application/json", "x-csrf-token": state.csrf || "" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch (error) { throw error.name === "AbortError" ? error : new Error(consoleDown); }
  // Only the console's own 401 means the session is gone: /api/probe relays Google's 401 unchanged,
  // and an expired logout is handled by its caller so the confirmed discard still applies.
  if (response.status === 401 && !["/api/login", "/api/logout"].includes(path) &&
      (await response.clone().json().catch(() => ({}))).error?.message === "Please sign in") showLogin(true);
  // A sign-in in another tab replaces the shared session cookie; adopt its token and retry once.
  // The token check runs before anything is saved, started or sent upstream.
  if (response.status === 403 && !retried && (await response.clone().json().catch(() => ({}))).error?.message === "Session verification failed" &&
      await renewSession()) return request(path, body, signal, true);
  return response;
}
async function api(path, body) {
  const response = await request(path, body);
  let result;
  try { result = await response.json(); } catch { throw new Error(response.ok ? "控制台返回了无法识别的内容，请刷新页面。" : `控制台返回 HTTP ${response.status}，请刷新页面后重试。`); }
  if (!response.ok) throw new Error(errorMessage(result.error?.message || result.error?.code));
  return result;
}
async function renewSession() {
  const session = await api("/api/session");
  if (session.authenticated) { state.csrf = session.csrf; return true; }
  showLogin(true); return false;
}
function setError(id, message) { message ||= ""; if ($(id).textContent !== message) $(id).textContent = message; $(id).hidden = !message; }
async function action(button, fn, errorId = "global-error") {
  const controls = ["form-error", "models-error", "discovery-error"].includes(errorId)
    ? [...document.querySelectorAll("#settings-form input,#settings-form button,#settings-form select,#settings-form textarea,#page-models input,#page-models select,#page-models button")].map(el => [el, el.disabled]) : [];
  for (const [el] of controls) el.disabled = true;
  // innerHTML keeps the aria-hidden arrow spans that textContent would flatten into the name.
  const previous = button.innerHTML; button.disabled = true; button.textContent = "处理中…"; button.setAttribute("aria-busy", "true");
  setError(errorId, "");
  try { await fn(); } catch (error) { setError(errorId, error.message); $(errorId).scrollIntoView({ block: "nearest" }); }
  finally { for (const [el, disabled] of controls) el.disabled = disabled; button.disabled = false; button.innerHTML = previous; button.removeAttribute("aria-busy"); if (controls.length) updateDraft(false); }
}
function showPage(page) {
  state.page = page;
  for (const key of Object.keys(pageNames)) $("page-" + key).hidden = key !== page;
  document.querySelectorAll("[data-page]").forEach(b => b.setAttribute("aria-current", b.dataset.page === page ? "page" : "false"));
  $("page-title").textContent = pageNames[page];
  $("main").focus({ preventScroll: true }); window.scrollTo({ top: 0 });
}
function showLogin(expired) {
  if (!$("app-view").hidden) {
    // A lost session keeps the unapplied draft for the next sign-in, without credentials.
    if (expired && state.dirty) {
      const { gatewayKey, serviceAccountJson, apiKey, accessToken, customApiKey, ...settings } = draft();
      state.pendingDraft = { settings, revision: state.config.revision, userLocation: state.userLocation };
    } else state.pendingDraft = null;
    state.dirty = Boolean(state.pendingDraft);
  }
  state.csrf = null; clearInterval(state.timer); state.probe?.abort();
  $("login-view").hidden = false; $("app-view").hidden = true;
  for (const id of ["gateway-key", "service-account", "api-key", "access-token", "custom-api-key"]) $(id).value = "";
  setError("login-error", expired ? "登录已过期，请重新登录。" + (state.pendingDraft ? "未应用的修改会在登录后恢复，凭据需重新输入。" : "") : "");
  $("login-key").focus();
  // Setup may have finished in this tab since load, so ask again which key the card should request.
  api("/api/session").then(session => loginCopy(session.setup)).catch(() => {});
}
function loginCopy(setup) {
  $("login-title").textContent = setup ? "首次设置" : "进入本地控制台";
  $("login-description").textContent = setup ? "请打开启动终端中的首次设置链接，或输入链接中的设置密钥。" : "输入网关密钥，管理你的上游连接。";
}
const credentialFields = { "service-account": ["serviceAccountJson", "服务账号 JSON"], express: ["apiKey", "Express API Key"], "access-token": ["accessToken", "OAuth 令牌"], custom: ["customApiKey", "自定义上游 API Key"] };
// Other modes' credentials stored in settings.json. Before the first save they come from the
// environment, and that save already keeps only the selected mode's credential.
const otherCredentials = authMode => state.config?.saved ? Object.entries(credentialFields)
  .filter(([mode, [name]]) => mode !== authMode && state.config.settings[name + "Set"]).map(([, field]) => field) : [];
function draft() {
  const authMode = document.querySelector('[name="authMode"]:checked').value;
  const clear = $("clear-other").checked ? otherCredentials(authMode).map(([name]) => name) : [];
  // Text left in a hidden credential panel must not replace another mode's stored credential; null deletes it.
  const credential = (id, mode) => authMode === mode ? $(id).value.trim() : clear.includes(credentialFields[mode][0]) ? null : "";
  return { authMode,
    serviceTier: document.querySelector('[name="serviceTier"]:checked').value,
    projectId: $("project-id").value.trim(), location: $("location").value.trim(),
    gatewayKey: $("gateway-key").value.trim(), serviceAccountJson: credential("service-account", "service-account"),
    apiKey: credential("api-key", "express"), accessToken: credential("access-token", "access-token"),
    customBaseUrl: $("custom-base-url").value.trim(), customApiKey: credential("custom-api-key", "custom"),
    port: Number($("port").value), timeoutMs: Number($("timeout").value) * 1000, antiTruncation: true, models: state.models.map(m => ({ ...m })),
    accountRotationEnabled: $("account-rotation").checked, accounts: accountDraft(),
    accountTimeoutMs: Number($("account-timeout").value) * 1000, accountFailureThreshold: Number($("account-failures").value), accountCooldownMs: Number($("account-cooldown").value) * 1000,
    unicodeInput: $("unicode-input").checked, imageInput: $("image-input").value, hideUnavailableModels: $("hide-unavailable").checked, geminiPrefillToUser: $("prefill-to-user").checked,
    geminiLongDecode: $("long-decode").checked, geminiPromptRetryEnabled: $("prompt-retry-enabled").checked, geminiPromptRetryText: $("prompt-retry-text").value,
    geminiPromptRetryMatches: retryMatches() };
}
function accountDraft() {
  return [...$("account-list").children].map(row => Object.fromEntries([["id", row.dataset.id],
    ...[...row.querySelectorAll("[data-field]")].map(input => [input.dataset.field, input.value.trim()])]));
}
function addAccount(account) {
  const row = document.createElement("fieldset");
  row.className = "account-row"; row.dataset.id = account.id;
  row.innerHTML = `<legend>附加账号</legend><div class="form-grid">
    <label class="field">账号名称<input data-field="name" maxlength="80" required></label>
    <label class="field">鉴权方式<select data-field="authMode">${Object.entries(authNames).map(([value, name]) => `<option value="${value}">${name}</option>`).join("")}</select></label>
    <label class="field" data-vertex>项目 ID<input data-field="projectId" maxlength="128" spellcheck="false"></label>
    <label class="field" data-vertex>地区<input data-field="location" spellcheck="false"></label>
    <label class="field" data-custom>上游地址<input data-field="customBaseUrl" type="url" placeholder="https://relay.example.com/v1" spellcheck="false"></label>
    </div><label class="field"><span data-credential-label>凭据</span><textarea data-field="credential" rows="3" spellcheck="false" autocomplete="off"></textarea></label>
    <button class="btn small-button" type="button">移除账号</button>`;
  for (const input of row.querySelectorAll("[data-field]")) input.value = account[input.dataset.field] || "";
  const mode = row.querySelector('[data-field="authMode"]'), secret = row.querySelector('[data-field="credential"]');
  secret.placeholder = account.credentialSet ? "已保存 · 留空保留，输入则替换" : "输入此账号的凭据";
  function showFields() {
    row.querySelectorAll("[data-vertex]").forEach(el => { el.hidden = mode.value === "custom"; });
    row.querySelector("[data-custom]").hidden = mode.value !== "custom";
    row.querySelector('[data-field="customBaseUrl"]').disabled = mode.value !== "custom";
    row.querySelector("[data-credential-label]").textContent = credentialFields[mode.value][1];
  }
  mode.addEventListener("change", () => { secret.value = ""; secret.placeholder = "鉴权方式已更改，请重新输入凭据"; showFields(); });
  row.querySelector("button").addEventListener("click", () => { row.remove(); $("add-account").disabled = false; updateDraft(); });
  $("account-list").append(row); showFields();
  $("add-account").disabled = $("account-list").children.length >= 19;
}
function retryMatches() {
  const lines = $("prompt-retry-matches").value.split("\n").map(line => line.trim()).filter(Boolean);
  return lines.length ? lines : null;
}
function updateRetryText() {
  const text = $("prompt-retry-text").value, bytes = new TextEncoder().encode(text).length;
  const chars = [...text], ascii = chars.filter(c => c.codePointAt(0) < 128).length;
  const estimate = Math.ceil(ascii / 4 + (chars.length - ascii) * 1.5);
  $("retry-text-count").textContent = chars.length.toLocaleString() + " 字符 · " + bytes.toLocaleString() + " / 192,000 UTF-8 字节 · 粗估 " + estimate.toLocaleString() + " tokens（非 Google 计数）";
  const error = bytes > 192000 ? "文本超过 192000 字节，请缩短后保存。" :
    $("prompt-retry-enabled").checked && !text.trim() ? "请填写自定义文本，或关闭重试。" : "";
  const lines = retryMatches() || [];
  fieldError("prompt-retry-text", "retry-text-error", error);
  fieldError("prompt-retry-matches", "retry-matches-error", lines.length > 32 || lines.some(line => line.length > 500) ? "最多 32 行，每行不超过 500 个字符。" : "");
  $("prompt-retry-enabled").disabled = !text.trim() && !$("prompt-retry-enabled").checked;
}
// Rewrite an alert only when its text changes, so typing does not re-announce it.
function fieldError(fieldId, errorId, error) {
  if ($(errorId).textContent === error) return;
  $(errorId).textContent = error;
  $(fieldId).setCustomValidity(error);
  $(fieldId).setAttribute("aria-invalid", String(Boolean(error)));
}
function updateDraft(dirty = true) {
  if (dirty) state.dirty = true;
  const d = draft(); const forcedGlobal = d.authMode === "express" || d.serviceTier !== "standard";
  // Keep the region the user chose while Express, Flex or Priority forces global.
  if (forcedGlobal !== state.forcedGlobal) {
    if (forcedGlobal) state.userLocation = $("location").value; else $("location").value = state.userLocation;
    state.forcedGlobal = forcedGlobal;
  }
  if (forcedGlobal) $("location").value = "global";
  const custom = d.authMode === "custom";
  // Hidden fields must not block saving through their own browser validation.
  $("location").disabled = forcedGlobal || custom;
  $("project-id").required = !["express", "custom"].includes(d.authMode);
  $("project-optional").hidden = d.authMode !== "express";
  $("project-help").textContent = d.authMode === "express" ? "填写 API Key 所属的项目 ID 或项目编号，以明确使用 global 地区。Gemini 4 Argon 必填。" : "填写目标 Google Cloud 项目 ID，可与服务账号所属项目不同。";
  $("credential-service").hidden = d.authMode !== "service-account";
  $("credential-express").hidden = d.authMode !== "express";
  $("credential-token").hidden = d.authMode !== "access-token";
  $("vertex-fields").hidden = custom; $("credential-custom").hidden = !custom; $("tier-options").hidden = custom; $("tier-help-card").hidden = custom;
  const others = otherCredentials(d.authMode);
  $("clear-other-row").hidden = !others.length;
  $("clear-other-label").textContent = "保存时删除其他鉴权方式已保存的凭据：" + others.map(([, label]) => label).join("、");
  $("preview-auth").textContent = authNames[d.authMode]; $("preview-tier").textContent = custom ? "不适用" : tierNames[d.serviceTier];
  $("preview-location-label").textContent = custom ? "上游" : "地区";
  $("preview-location").textContent = (custom ? upstreamHost(d.customBaseUrl) : d.authMode === "express" && !d.projectId ? "由 Express 决定" : $("location").value) || "—"; $("preview-port").textContent = d.port || "—";
  $("tier-help").textContent = d.serviceTier === "standard" ? "使用标准档位，不自动升级服务等级。" : d.serviceTier === "flex"
    ? "Flex 使用原生接口，响应等待可能更长。账户和模型须支持该档位；失败时不会自动切换为 Standard。"
    : "Priority 使用优先按量服务，按对应档位计费。实际是否使用 Priority 请查看请求日志中的上游档位。";
  if (d.authMode === "express" && d.serviceTier !== "standard") $("tier-help").textContent += " Express 的档位可用性由上游决定。";
  if (custom) $("tier-help").textContent = "自定义上游不使用 Vertex 的服务等级和地区，计费和可用模型由上游决定。它没有 Vertex 原生参数流，流式抗截断改走兼容接口，正文可能等上游写完后一次到达。";
  $("draft-label").textContent = state.dirty ? "有未应用的修改" : "配置已同步";
  $("models-draft-label").textContent = state.dirty ? "有未应用的修改" : "配置已同步";
  $("models-count").textContent = state.models.length + " 个版本";
  $("discard-button").disabled = !state.dirty;
  $("models-discard").disabled = !state.dirty;
  updateRetryText();
  updateSelection();
}
function fillConfig(c = state.config.settings) {
  const saved = state.config.settings;
  for (const name of ["authMode", "serviceTier"]) {
    // An unknown value (for example a mistyped VERTEX_SERVICE_TIER) falls back to the first option.
    const radios = [...document.querySelectorAll(`[name="${name}"]`)];
    (radios.find(el => el.value === c[name]) || radios[0]).checked = true;
  }
  for (const [id, name] of [["project-id", "projectId"], ["location", "location"], ["port", "port"], ["custom-base-url", "customBaseUrl"]]) $(id).value = c[name];
  $("timeout").value = c.timeoutMs / 1000;
  $("account-rotation").checked = c.accountRotationEnabled === true;
  $("account-timeout").value = (c.accountTimeoutMs ?? 60000) / 1000;
  $("account-failures").value = c.accountFailureThreshold ?? 2;
  $("account-cooldown").value = (c.accountCooldownMs ?? 60000) / 1000;
  $("account-list").replaceChildren(); $("add-account").disabled = false;
  for (const account of c.accounts || []) addAccount(account);
  $("unicode-input").checked = c.unicodeInput === true;
  $("image-input").value = c.imageInput || "off";
  $("hide-unavailable").checked = c.hideUnavailableModels !== false;
  $("prefill-to-user").checked = c.geminiPrefillToUser !== false;
  $("long-decode").checked = c.geminiLongDecode === true;
  $("prompt-retry-enabled").checked = c.geminiPromptRetryEnabled === true;
  $("prompt-retry-text").value = c.geminiPromptRetryText || "";
  $("prompt-retry-matches").value = (c.geminiPromptRetryMatches || []).join("\n");
  state.models = c.models.map(m => ({ ...m })); renderModels();
  for (const [id, name] of [["gateway-key", "gatewayKey"], ["service-account", "serviceAccountJson"], ["api-key", "apiKey"], ["access-token", "accessToken"], ["custom-api-key", "customApiKey"]]) {
    $(id).value = ""; $(id).placeholder = saved[name + "Set"] ? (state.config.saved ? "已保存 · 留空保留，输入则替换" : "已从环境变量导入 · 留空沿用，输入则替换") : ({ gatewayKey: "至少 16 个可见 ASCII 字符，或生成随机密钥",serviceAccountJson: "粘贴完整的服务账号 JSON，或导入文件", apiKey: "输入 Vertex Express API Key", accessToken: "输入短期 Google OAuth 令牌", customApiKey: "输入上游 API Key" })[name];
  }
  $("service-file").value = ""; $("clear-other").checked = false;
  state.dirty = false; $("saved-badge").textContent = state.config.saved ? "已保存到本机" : "尚未保存";
  state.forcedGlobal = false;
  updateDraft(false);
}
const isReady = c => Boolean(c.gatewayKeySet && c[credentialFields[c.authMode]?.[0] + "Set"]);
function renderStatus() {
  const s = state.status, c = state.config.settings, current = s.active;
  $("account-status").textContent = s.accounts?.length ? "运行状态：" + s.accounts.map(a => `${a.name}：${a.cooldownRemainingMs > 0 ? `等待 ${Math.ceil(a.cooldownRemainingMs / 1000)} 秒` : "参与轮询"}，连续失败 ${a.failures} 次`).join("；") : "当前未启用轮询。";
  const ready = isReady(c);
  const label = s.running ? "运行中" : ready ? "已停止" : "待配置";
  $("rail-status").textContent = label; $("rail-lamp").className = "lamp " + (s.running ? "" : "idle");
  $("metric-status").textContent = label; $("metric-active").textContent = s.running ? s.activeRequests + " 个进行中的请求" : "本地 API 尚未监听";
  $("metric-requests").textContent = s.requests; $("metric-restored").textContent = s.restored;
  const shown = current || c, custom = shown.authMode === "custom";
  $("metric-tier").textContent = custom ? "不适用" : tierNames[shown.serviceTier];
  $("metric-traffic").textContent = "最近实际上游：" + (s.lastTrafficType || "尚无记录");
  $("runtime-badge").textContent = s.running ? "●  API ONLINE" : "●  " + label;
  $("runtime-badge").className = "badge " + (s.running ? "go" : "hold");
  $("runtime-title").textContent = s.running ? "网关已就绪" : ready ? "网关已停止" : "连接 Vertex 或自定义上游";
  $("runtime-description").textContent = s.error ? errorMessage(s.error) : s.running ? "本地接口正在监听。上游凭据与模型可用性以实际请求结果为准。" : ready ? "配置已保存，启动后即可接收客户端请求。" : "填写凭据并保存，即可向本地网关发送请求。";
  if (s.running && s.modelAvailability?.some(m => m.reason === "authentication_failed")) {
    $("runtime-description").textContent = "上游返回 401，当前凭据无法调用模型。请在连接配置修正凭据并保存应用；临时错误不会隐藏模型。";
  }
  // Unsaved setups open on the connection page, so the startup or environment problem is shown there too.
  setError("config-warning", s.error ? errorMessage(s.error) : "");
  $("start-button").hidden = s.running || !ready; $("stop-button").hidden = !s.running; $("stop-button").disabled = s.activeRequests > 0; $("setup-button").hidden = ready;
  $("endpoint").textContent = s.network?.gatewayPublicUrl || `http://127.0.0.1:${current?.port || c.port}/v1`;
  const allInterfaces = s.network?.listenHost === "0.0.0.0";
  $("listen-scope").textContent = allInterfaces ? "容器 / 网络访问" : "仅限本机 · 127.0.0.1";
  $("port-help").textContent = allInterfaces ? "Docker 默认映射到容器 4781；修改此端口后需同步修改容器端口映射。" : "仅监听 127.0.0.1，与控制台端口分开。";
  $("overview-auth").textContent = current ? authNames[current.authMode] : "未启动";
  $("overview-project").textContent = custom ? "不适用" : shown.projectId || (shown.authMode === "express" ? "Express · 由 API Key 确定" : "—");
  $("overview-location-label").textContent = custom ? "上游" : "地区";
  $("overview-location").textContent = custom ? upstreamHost(shown.customBaseUrl) : shown.authMode === "express" && !shown.projectId ? "由 Express 决定" : shown.location;
  const models = s.running ? s.models : c.models;
  const hidden = new Set((s.modelAvailability || []).filter(m => m.hidden).map(m => m.id));
  $("overview-anti").textContent = models.length + " 个独立版本" + (s.running ? " · " + hidden.size + " 个已隐藏" : "");
  $("rail-models").textContent = models.length + " 个" + (s.running ? "已应用" : state.config.saved ? "已保存" : "默认") + "版本";
  for (const id of ["client-model", "probe-model"]) {
    const select = $(id), rows = (id === "probe-model" ? s.models.filter(m => m.enabled !== false) : models.filter(m => !hidden.has(m.id)));
    const options = rows.map(m => `<option value="${esc(m.id)}">${esc(m.id)} · ${modeNames[m.mode]}</option>`).join("") || '<option value="">尚无已应用的模型</option>';
    if (select.innerHTML !== options) { const value = select.value; select.innerHTML = options; if (rows.some(m => m.id === value)) select.value = value; }
  }
  $("model-id").textContent = $("client-model").value;
  updateProbeModel();
}
function updateProbeModel() {
  const s = state.status, row = s?.models.find(m => m.id === $("probe-model").value);
  const retry = s?.active?.geminiPromptRetryEnabled;
  $("probe-cost-notice").textContent = retry
    ? "重试功能已开启：此次测试最多发送 2 次上游请求，每次最多 512 个输出 tokens。重试会带上自定义文本，增加输入用量和费用。"
    : s?.active?.authMode === "custom" ? "测试将使用已应用的自定义上游发送一次真实请求，可能按上游的规则计费。"
    : "测试将使用已应用的凭据与服务等级发送一次真实请求，可能产生 Google Cloud 费用。";
  $("probe-consent-label").textContent = retry ? "我同意此次真实测试及最多 1 次自动重试" : "我同意发送这一次真实测试请求";
  $("probe-model-help").textContent = row ? `${row.upstreamModel} · ${modeNames[row.mode]}` + (row.mode === "buffered" ? " · 完整回复到齐后交付正文。" : "")
    : !s?.running ? (isReady(state.config.settings) ? "网关未运行，请先在总览启动网关。" : "网关未运行，请先在连接配置中填写凭据并保存。") + (s?.error ? errorMessage(s.error) : "")
    : s.models.length ? "已应用的模型版本都已停用，请在模型与版本中启用并保存。" : "请先在模型与版本中保存配置。";
  $("probe-button").disabled = !row || !$("probe-consent").checked || Boolean(state.probe);
  $("probe-model").disabled = Boolean(state.probe);
  $("probe-stream").disabled = Boolean(state.probe);
}
function renderModels() {
  $("model-rows").innerHTML = state.models.length ? state.models.map((m, i) => `<div class="model-row" data-row="${i}">
    <label>客户端模型名称<input data-field="id" value="${esc(m.id)}" maxlength="160" spellcheck="false" aria-label="客户端模型名称（模型 ${i + 1}）"></label>
    <label>上游模型 ID<input data-field="upstreamModel" value="${esc(m.upstreamModel)}" maxlength="200" spellcheck="false" aria-label="上游模型 ID（模型 ${i + 1}）"></label>
    <label>传输模式<select data-field="mode" aria-label="模型 ${i + 1} 的传输模式">${Object.entries(modeNames).map(([v, label]) => `<option value="${v}"${v === m.mode ? " selected" : ""}>${label}</option>`).join("")}</select></label>
    <div class="model-actions"><label class="model-enabled"><input type="checkbox" data-field="enabled"${m.enabled !== false ? " checked" : ""} aria-label="启用模型 ${i + 1}">启用</label><button class="btn ghost remove-model" data-remove="${i}" aria-label="移除模型 ${i + 1}">移除</button></div></div>`).join("") : '<div class="empty-state"><strong>还没有模型版本</strong><p>从目录选择或手动添加。保存空列表后，客户端将没有可选模型。</p></div>';
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
  const custom = draft().authMode === "custom";
  for (const raw of upstreams) {
    let id, upstreamModel;
    if (custom) {
      // A custom upstream gets the name exactly as written; the client name keeps only allowed characters.
      upstreamModel = raw.trim();
      if (!upstreamModel || upstreamModel.length > 200 || /[\u0000-\u001f\u007f]/.test(upstreamModel)) throw new Error(errorMessage("Invalid custom upstream model name"));
      id = upstreamModel.replace(/^(?:google|models)\//, "").replace(/[^\p{L}\p{N}._@-]+/gu, "-").replace(/^[^\p{L}\p{N}]+|-+$/gu, "") || "model";
    } else {
      id = raw.trim().replace(/^(?:google\/|publishers\/google\/models\/)/, "");
      if (!/^gemini-[a-z0-9][a-z0-9._-]{0,126}(?:@[a-z0-9-]{1,32})?$/.test(id) || id.includes("..")) throw new Error(errorMessage("Invalid upstream Gemini model ID"));
      upstreamModel = "google/" + id;
    }
    for (const mode of modes) {
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
  const endings = { stop: "自然停止", length: "达到长度上限", content_filter: "内容受限", tool_calls: "工具调用", function_call: "函数调用" };
  const ending = !["complete", "tool_calls"].includes(result.outcome) && endings[result.finishReason];
  return '<small>' + esc(names[result.outcome] || "尚未确认") + (result.hasReasoning && !result.hasContent && !result.hasToolCalls ? " · 仅思考无正文" : "") + '</small>' +
    (ending ? '<small>上游结束：' + esc(ending) + '</small>' : '');
}
function compatibilityBadge(result) {
  if (!result) return "";
  return (result.prefillConverted ? "<small>预填充已转 USER</small>" : "") +
    (result.promptRetried ? "<small>已插入自定义文本重试 1 次</small>" : "");
}
// Fixed enums and counts only. floor-not-found can be normal when the client already encoded the text.
const unicodeReasons = { "floor-not-found": "未找到楼层原文（也可能已由客户端转码）", "no-encodable-text": "无需转码" };
function inputBadge(e) {
  const image = e.imageInput, unicode = e.unicodeInput;
  return (image ? "<small>" + (image.reason === "encoded" ? `图片已转码 ${esc(image.pages)} 页 · ${esc(image.messages)} 条消息`
      : "图片转码：" + (image.reason === "no-text" ? "没有可转换的会话文字" : "未知")) + "</small>" : "") +
    (unicode ? "<small>" + (unicode.reason === "encoded" ? `Unicode 已转码 ${esc(unicode.occurrences)} 处 · ${esc(unicode.matchedMessages)} 条消息 · ${esc(unicode.encodedCharacters)} 字符`
      : "Unicode 跳过：" + (unicodeReasons[unicode.reason] || "未知")) + "</small>" : "");
}
// Token counts and the gateway's estimate from Google's list prices; the bill is authoritative.
function usageCell(e) {
  const u = e.usage, cost = e.estimatedCostUsd, count = n => esc(Number(n).toLocaleString("zh-CN"));
  if (!u) return '<td>—<small>上游未报告用量</small></td>';
  const price = typeof cost === "number" ? `<small title="按 Google 官方价目估算，不含缓存存储、联网搜索等其他费用，以账单为准">≈ $${esc(cost >= 0.01 ? cost.toFixed(4) : cost.toPrecision(2))}</small>`
    : '<small title="自定义上游、预配吞吐量和价目表未收录的模型不估算">无官方单价</small>';
  return `<td><span class="mono">${count(u.promptTokens)} 入 · ${count(u.outputTokens)} 出</span>${u.cachedTokens ? `<small>其中缓存 ${count(u.cachedTokens)}</small>` : ""}${price}</td>`;
}
function eventTable(events) {
  if (!events.length) return '<div class="empty-state"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7 4h18v24H7zM11 10h10M11 15h10M11 20h6"/></svg><strong>暂无请求记录</strong><p>向网关发送请求后，传输与还原状态会显示在这里。</p></div>';
  return '<div class="table-wrap"><table><thead><tr><th>时间 / 请求</th><th>模型版本</th><th>状态</th><th>传输</th><th>正文还原</th><th>请求 / 实际档位</th><th>用量 / 估算费用</th><th>耗时</th></tr></thead><tbody>' + events.map(e => {
    const a = e.antiTruncation || {};
    const recovered = a.restored === true ? "已还原" : a.restored === false ? "未还原 / 跳过" : "未确认";
    // Pass-through requests keep the plain stream label; every audited transport, fallback and skip reason has its own.
    const transport = transportNames[a.transport] || (!a.transport || a.transport === "disabled" ? (e.stream ? "SSE 流式" : "普通响应") : a.transport);
    const success = e.status >= 200 && e.status < 300;
    return `<tr><td><span class="mono">${esc(new Date(e.at).toLocaleTimeString("zh-CN", { hour12: false }))}</span><small title="${esc(e.requestId)}">${esc(e.requestId.slice(0, 8))}</small></td><td><span class="mono">${esc(e.model || "—")}</span><small>${esc(modeNames[e.mode] || "")}</small></td><td><span class="badge ${success ? "go" : "stop"}">${e.status}</span>${e.code ? `<small class="error-code" title="${esc(errorMessage(e.code))}">${esc(e.code)}</small>` : ""}${integrityBadge(e.responseIntegrity)}${e.upstreamError ? `<small>上游：${esc([e.upstreamError.status, e.upstreamError.reason].filter(Boolean).join(" · "))}</small>` : ""}${compatibilityBadge(e.geminiCompatibility)}${inputBadge(e)}${accountBadge(e)}</td><td><span title="${esc(a.transport || "")}">${esc(transport)}</span><small>${esc(a.finishReason || "—")}</small></td><td><span class="badge ${a.restored ? "go" : ""}">${recovered}</span><small>${a.streamDone === true ? "流已结束" : a.streamDone === false ? "流未完成" : ""}</small></td><td>${esc(tierNames[e.serviceTier] || "Standard")}<small>${esc(e.trafficType || "上游未报告")}</small></td>${usageCell(e)}<td class="mono">${(e.latencyMs / 1000).toFixed(2)} s</td></tr>`;
  }).join("") + "</tbody></table></div>";
}
function accountBadge(event) {
  if (!event.accountAttempts?.length) return "";
  const label = id => id === "primary" ? "主账号" : state.config.settings.accounts?.find(account => account.id === id)?.name || id;
  return `<small>账号：${event.accountAttempts.map(a => `${esc(label(a.accountId))} (${a.status})`).join(" → ")}</small>`;
}
// Rebuilding a table resets its horizontal scroll and drops a text selection: skip unchanged
// tables, let a poll wait while text inside is selected, and keep the scroll position across a rebuild.
function renderTable(id, html, force) {
  const box = $(id), selection = getSelection();
  if (state.rendered[id] === html || (!force && selection && !selection.isCollapsed && selection.containsNode(box, true))) return;
  const scroll = box.querySelector(".table-wrap")?.scrollLeft || 0;
  box.innerHTML = html; state.rendered[id] = html;
  const wrap = box.querySelector(".table-wrap"); if (wrap) wrap.scrollLeft = scroll;
}
function renderEvents(force) {
  renderTable("recent-events", eventTable(state.events.slice(0, 4)));
  const filter = $("event-filter").value;
  renderTable("all-events", eventTable(state.events.filter(e => filter === "all" || (filter === "failed" ? e.status >= 400 : e.antiTruncation?.restored === true))), force);
}
async function refresh() {
  let status, events;
  try { [status, events] = await Promise.all([api("/api/status"), api("/api/events")]); }
  catch (error) { state.refreshError = error.message; throw error; }
  state.status = status; state.events = events.events; renderStatus(); renderEvents();
  // Clear only a refresh failure; start, stop and logout failures stay until the next action.
  if (state.refreshError && $("global-error").textContent === state.refreshError) setError("global-error", "");
  state.refreshError = null;
}
async function enter() {
  state.config = await api("/api/config");
  const pending = state.pendingDraft;
  fillConfig(pending?.settings);
  // A restored draft keeps its old revision, so a save after another session's save still gets the conflict message.
  if (pending) { state.config.revision = pending.revision; state.userLocation = pending.userLocation; state.dirty = true; updateDraft(false); }
  for (const id of ["global-error", "form-error", "models-error", "discovery-error"]) setError(id, "");
  await refresh();
  state.pendingDraft = null;
  $("login-key").value = ""; $("login-view").hidden = true; $("app-view").hidden = false;
  showPage(pending ? state.page : state.config.saved || state.config.settings.gatewayKeySet ? "overview" : "connection");
  if (pending) toast("已恢复登录前未应用的修改；凭据需重新输入。");
  clearInterval(state.timer);
  state.timer = setInterval(() => { if (!document.hidden && state.csrf) refresh().catch(e => setError("global-error", e.message)); }, 5000);
}
$("login-form").addEventListener("submit", e => { e.preventDefault(); action(e.submitter, async () => { state.csrf = (await api("/api/login", { key: $("login-key").value })).csrf; await enter(); }, "login-error"); });
document.querySelectorAll("[data-page],[data-go]").forEach(b => b.addEventListener("click", () => showPage(b.dataset.page || b.dataset.go)));
// Switching mode changes which credentials the box deletes, so it must be ticked again for the new list.
document.querySelectorAll('[name="authMode"]').forEach(r => r.addEventListener("change", () => { $("clear-other").checked = false; }));
$("settings-form").addEventListener("input", () => updateDraft());
$("settings-form").addEventListener("change", () => updateDraft());
$("add-account").addEventListener("click", () => {
  addAccount({ id: crypto.randomUUID(), name: "账号 " + ($("account-list").children.length + 2),
    authMode: document.querySelector('[name="authMode"]:checked').value, location: "global" });
  updateDraft(); $("account-list").lastElementChild.querySelector("input").focus();
});
async function saveConfiguration() {
  const result = await api("/api/config", { settings: draft(), revision: state.config.revision });
  state.config = result; fillConfig(); await refresh(); toast("配置已保存并应用，网关正在运行。");
  setError("form-error", ""); setError("models-error", ""); setError("global-error", "");
  void checkUpstreamNames();
}
// After a save, compare a custom upstream's saved model names with its own model list. It only
// lists models, so it costs nothing; a mismatch is a warning, since some lists are incomplete.
async function checkUpstreamNames() {
  setError("models-name-warning", "");
  const names = [...new Set(state.config.settings.models.map(m => m.upstreamModel))];
  if (state.config.settings.authMode !== "custom" || !names.length) return;
  let listed;
  try { listed = (await api("/api/models/discover", { settings: {} })).ids; }
  catch { return setError("models-name-warning", "已保存，但读不到上游的模型列表，没能核对上游模型名。请自行确认这些名字和上游一致。"); }
  const key = name => /gemini-[a-z0-9][a-z0-9._-]*/i.exec(name)?.[0].toLowerCase();
  const missing = names.filter(name => !listed.includes(name)).map(name => {
    const similar = listed.filter(id => key(id) && key(id) === key(name)).slice(0, 3);
    return name + (similar.length ? `（列表里有：${similar.join("、")}）` : "");
  });
  if (!missing.length) return;
  setError("models-name-warning", `已保存。以下上游模型名不在上游的模型列表里，请求时可能找不到模型：${missing.join("；")}。可以在下方改成列表里的名字；如果上游的列表本来就不全，可以忽略。`);
  toast(`已保存。有 ${missing.length} 个上游模型名不在上游的模型列表里，详见“模型与版本”。`);
}
async function discardConfiguration() {
  state.config = await api("/api/config"); fillConfig(); setError("form-error", ""); setError("models-error", ""); toast("已重新加载保存的配置。");
}
$("settings-form").addEventListener("submit", e => { e.preventDefault(); action($("save-button"), saveConfiguration, "form-error"); });
$("validate-button").addEventListener("click", e => action(e.currentTarget, async () => { await api("/api/validate", { settings: draft() }); toast("本地配置校验通过，未调用 Google。端口是否可用会在保存时检查。"); }, "form-error"));
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
  state.models[Number(row.dataset.row)][field] = field === "enabled" ? e.target.checked : e.target.value; updateDraft();
});
$("model-rows").addEventListener("click", e => {
  const button = e.target.closest("[data-remove]"); if (!button) return;
  const index = Number(button.dataset.remove), removed = state.models[index];
  state.models.splice(index, 1); renderModels(); updateDraft(); toast(`已从草稿移除 ${removed.id}，保存后生效。`);
  $("model-rows").querySelectorAll('[data-field="id"]')[Math.min(index, state.models.length - 1)]?.focus();
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
async function copy(text) {
  if (!text) return toast("没有可复制的内容。");
  try { await navigator.clipboard.writeText(text); toast("已复制到剪贴板。"); } catch { toast("复制失败，请手动选择文本复制。"); }
}
$("copy-key").addEventListener("click", () => $("gateway-key").value ? copy($("gateway-key").value)
  : toast(!state.config.settings.gatewayKeySet ? "请先生成或输入密钥。" : state.config.saved ? "已保存的密钥不回显。需要更换时，请生成新密钥。" : "密钥已从环境变量导入，页面不回显。需要更换时，请生成新密钥。"));
document.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", () => copy($(b.dataset.copy).textContent)));
$("refresh-button").addEventListener("click", e => action(e.currentTarget, refresh));
// A failed start stores its reason in the status; refresh shows it now instead of at the next poll.
$("start-button").addEventListener("click", e => action(e.currentTarget, async () => {
  try { await api("/api/start", {}); } catch (error) { await refresh().catch(() => {}); throw error; }
  await refresh(); toast("网关已启动。");
}));
$("stop-button").addEventListener("click", e => action(e.currentTarget, async () => { await api("/api/stop", {}); await refresh(); toast("网关已停止，控制台仍可使用。"); }));
$("logout-button").addEventListener("click", e => {
  if (state.dirty && !confirm("有未应用的修改，退出后会丢失。仍要退出吗？")) return;
  action(e.currentTarget, async () => {
    // A session that already expired counts as signed out.
    await api("/api/logout", {}).catch(error => { if (error.message !== errorMessage("Please sign in")) throw error; });
    showLogin(false);
  });
});
$("event-filter").addEventListener("change", () => renderEvents(true));
$("probe-consent").addEventListener("change", updateProbeModel);
$("probe-cancel").addEventListener("click", () => state.probe?.abort());
$("probe-button").addEventListener("click", async () => {
  if (!$("probe-consent").checked || state.probe) return;
  state.probe = new AbortController(); $("probe-button").disabled = true; $("probe-consent").checked = false; $("probe-cancel").hidden = false;
  updateProbeModel();
  $("probe-output").textContent = ""; $("probe-status").textContent = "请求中…"; $("probe-meta").innerHTML = ""; setError("probe-error", "");
  let text = "", usage, finish, restored, done = false, reads = 0, firstAt, lastAt, requestId = null;
  const started = performance.now();
  // The gateway closes the connection when a reply fails after its headers; the browser then reports a raw network error.
  const interrupted = error => { throw error.name === "AbortError" ? error : new Error(replyInterrupted); };
  const showMeta = meta => { $("probe-meta").innerHTML = Object.entries(meta).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd class="mono">${esc(v)}</dd></div>`).join(""); };
  try {
    const stream = $("probe-stream").checked;
    const response = await request("/api/probe", { confirm: true, stream, model: $("probe-model").value }, state.probe.signal);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      requestId = body.error?.requestId || null;
      // Google's status, reason and redacted message; shown only through textContent or esc().
      const google = body.error?.upstreamError;
      const detail = google ? [google.status, google.reason, google.message].filter(v => typeof v === "string" && v).join(" · ") : "";
      throw new Error(`HTTP ${response.status} · ` + errorMessage(body.error?.message || body.error?.code) + (detail ? " 上游：" + detail : ""));
    }
    requestId = response.headers.get("x-request-id");
    const transport = response.headers.get("x-anti-truncation-transport");
    if (stream) {
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
      for (;;) {
        const result = await reader.read().catch(interrupted); if (result.done) { buffer += decoder.decode(); break; }
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
      const body = await response.json().catch(interrupted); text = body.choices?.[0]?.message?.content || ""; finish = body.choices?.[0]?.finish_reason;
      usage = body.usage; restored = body.router_anti_truncation?.restored;
    }
    $("probe-output").textContent = text || "上游未返回可显示正文。";
    $("probe-status").textContent = finish === "stop" && text ? "请求完成" : "检查结束原因";
    // The raw value stays visible so it can be compared with the README.
    showMeta({ "请求 ID": requestId, "传输方式": transport === "disabled" ? "未使用抗截断 · disabled" : transportNames[transport] ? transportNames[transport] + " · " + transport : transport || "未知",
      "结束原因": finish || "未知", "正文还原": restored === true ? "已还原" : restored === false ? "未还原 / 跳过" : "未确认", "实际上游档位": usage?.traffic_type || usage?.extra_properties?.google?.traffic_type || "上游未报告", "耗时": ((performance.now() - started) / 1000).toFixed(2) + " s", ...(stream ? { "含正文读取次数": reads, "正文到达跨度": ((lastAt || 0) - (firstAt || 0)).toFixed(0) + " ms" } : {}) });
  } catch (error) {
    const cancelled = error.name === "AbortError", message = cancelled ? "请求已取消。" : error.message;
    $("probe-status").textContent = cancelled ? "已取消" : "测试失败"; setError("probe-error", message);
    // The result card states the cause too; partial text stays visible with the error beside it.
    if (!text) $("probe-output").textContent = cancelled ? message : "测试失败：" + message;
    showMeta({ ...(text && !cancelled ? { "错误": message } : {}), ...(requestId ? { "请求 ID": requestId } : {}), "耗时": ((performance.now() - started) / 1000).toFixed(2) + " s" });
  }
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
    loginCopy(session.setup);
    if (session.authenticated) { state.csrf = session.csrf; await enter(); }
    else if (setup) { state.csrf = (await api("/api/login", { key: setup })).csrf; await enter(); }
  } catch (error) { setError("login-error", error.message); }
  // The login card starts hidden so a signed-in reload does not flash it.
  if ($("app-view").hidden) { $("login-view").hidden = false; $("login-key").focus(); }
})();

$("image-input").addEventListener("change", () => { if ($("image-input").value !== "off") $("unicode-input").checked = false; });
$("unicode-input").addEventListener("change", () => { if ($("unicode-input").checked) $("image-input").value = "off"; });
