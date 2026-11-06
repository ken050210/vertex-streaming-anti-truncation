import { PLUGIN_ID, PLUGIN_PATH, PLUGIN_VERSION, MIN_SERVER_VERSION, MODES, compareVersions, createFetchInterceptor, latestUserInput } from "./shared.js";
import { DEFAULT_STOP_TAG, DEFAULT_STOP_COUNT } from "../../src/tag-stop-rule.mjs";

// TauriTavern has no Node server to host the plugin, so the extension shapes the
// request and restores the reply itself. Rendering text as images needs the server.
const tauri = window.__TAURITAVERN__ ? await import("../../src/tauritavern.mjs") : null;
const direct = tauri && { prepare: tauri.prepareTauriTavernRequest, restore: tauri.restoreTauriTavernResponse };
const context = SillyTavern.getContext();
const events = context.eventTypes ?? context.event_types;
const labels = { off: "关闭（普通 Vertex）", buffered: "非流式抗截断", streaming: "流式抗截断" };
const reasons = { "existing-tools": "旧版 functions 工具", "tool-choice": "请求指定必须调用工具", "tool-schema": "工具定义无法转为 Vertex 原生格式",
  "server-tools": "服务端插件较旧，不支持工具调用；更新服务端插件后重启酒馆",
  "structured-output": "结构化输出", "multiple-candidates": "多个候选回复",
  "tool-history": "旧版 function 工具历史", "web-search": "联网搜索", "image-generation": "图片生成", "reverse-proxy": "反向代理",
  model: "此模型不适用", "too-large": "请求超过 8 MiB", "additional-parameters": "Vertex 附加参数不是 JSON 对象，无法合并" };
const errors = { unicode_floor_required: "找不到真实用户楼层，也没有聊天变量“我的行动”，已停止发送。请先输入消息，或关闭 Unicode 转码。",
  unicode_input_too_large: "转码后的请求超过大小限制，已停止发送。请缩短输入或关闭 Unicode 转码。",
  plugin_not_ready: "服务端插件未就绪或版本太旧，本次请求已停止发送。点“检查插件连接”查看原因和更新办法。",
  tag_stop_not_supported: "服务端插件不支持自定义标签截停。请更新服务端插件并重启酒馆，或关闭此开关。",
  invalid_tag_stop: "截停标签名须为 1–64 位字母、数字、下划线、点、冒号或连字符，以字母或下划线开头；次数须为正整数。",
  image_input_requires_supported_request: "图片输入不支持此请求，已停止发送，未改用明文。请去掉不支持的内容或换用支持的模型，或关闭图片输入。",
  image_input_unsupported_characters: "图片输入不支持 emoji、控制字符或字体缺字，已停止发送。请删除这些字符，或改用“图片·当前轮”/关闭图片输入。",
  image_input_too_large: "转成图片后超过大小或页数限制，已停止发送。请缩短对话，或改用“图片·当前轮”。",
  image_renderer_unavailable: "服务端图片渲染组件不可用。请在服务端插件目录运行 npm ci --ignore-scripts 后重启酒馆。",
  image_render_failed: "服务端图片渲染失败，已停止发送，未改用明文。",
  request_too_large: "请求超过 8 MiB，插件已拒绝发送。请减少附件或聊天历史。",
  gemini4_long_decode_required: "服务端插件较旧，输出上限超过 Gemini 4 Argon 单次上限时会拒绝发送。请更新服务端插件后重启酒馆；或在预设里把最大回复长度降到 32,768（非流式）／65,536（流式）以内。" };
const updateServer = "用安装包装的，下载新版安装包再运行一次；用 Git 装的，在服务端插件目录运行 git pull --ff-only 和 npm ci --ignore-scripts。之后重启酒馆并重新检查。";
let status, select, backendReady, backendFeatures = [], backendWarning;
function settings() {
  const store = SillyTavern.getContext().extensionSettings;
  store[PLUGIN_ID] ??= { mode: "off", unicodeInput: false };
  return store[PLUGIN_ID];
}
function mode() { return MODES.includes(settings().mode) ? settings().mode : "off"; }
function showStatus(text = "") {
  if (!status) return;
  // A failed version check stays visible until a later check succeeds.
  if (!text && backendReady === false) text = backendWarning;
  status.textContent = text;
  status.hidden = !text;
}
function updateStatus(result) {
  if (result.error) {
    const code = result.status ? `${result.error}，HTTP ${result.status}` : result.error;
    const cause = result.bypass ? `原因：${reasons[result.bypass] ?? result.bypass}。` : "";
    return showStatus((errors[result.error] || `请求失败（${code}）。请查看酒馆错误提示；未自动重试。`) + cause);
  }
  const unicode = result.unicode ? { encoded: "已对当前用户输入的匹配文本转码。", "floor-not-found": "请求中没有找到当前用户输入的原文，按原文发送。", "no-encodable-text": "当前用户输入没有需要转码的字符。" }[result.unicode.reason] || "" : "";
  const noText = result.image?.mode === "current-turn"
    ? "图片·当前轮：最后一条 AI 消息之后没有可转换的文本（如点击“继续”或以 AI 消息结尾的预填充），本次按原文发送。"
    : "图片·全部会话：没有可转换的文本，本次按原文发送。";
  const image = result.image ? { encoded: `已将文本转为图片发送${result.image.pages ? `（${result.image.pages} 页）` : ""}。`,
    "no-text": noText }[result.image.reason] || "" : "";
  const delivery = result.image && { "native-streaming": "正文按流式接收。", buffered: "正文整段返回。" }[result.image.transport];
  const bypass = result.bypass && result.bypass !== "disabled" ? `本次使用普通 Vertex：${reasons[result.bypass] ?? result.bypass}。` : "";
  const continuation = result.continuation ? "本次“继续”已请求仅生成新增续文，由酒馆追加到原消息。" : "";
  const limit = result.outputLimit, tokens = value => value.toLocaleString("en-US");
  const output = !limit ? "" : limit.longDecode
    ? `本次输出上限 ${tokens(limit.applied)} token（含思考）超过单次上限，写满后自动续写。`
    : `本次输出上限按单次上限 ${tokens(limit.applied)} token（含思考）发送，预设未改动；写满会停止并标记为长度截断。`;
  showStatus([unicode, image, delivery, bypass, continuation, output].filter(Boolean).join(" "));
}

async function checkBackend(silent = false) {
  if (!silent) showStatus("正在检查服务端插件…");
  let version, features = [];
  try {
    const response = await fetch(`${PLUGIN_PATH}/status`, { headers: context.getRequestHeaders(), signal: AbortSignal.timeout(5000) });
    const data = response.ok ? await response.json() : null;
    if (data?.id === PLUGIN_ID && typeof data.version === "string") version = data.version;
    if (version && Array.isArray(data.features)) features = data.features;
  } catch {}
  backendFeatures = features;
  backendReady = Boolean(version) && compareVersions(version, MIN_SERVER_VERSION) >= 0;
  backendWarning = !version ? "找不到服务端插件。请安装配套服务端插件，确认 config.yaml 中 enableServerPlugins 为 true，重启酒馆后重新检查。"
    : `服务端插件 ${version} 太旧，需要 ${MIN_SERVER_VERSION} 或更新。${updateServer}`;
  const difference = backendReady ? compareVersions(version, PLUGIN_VERSION) : 0;
  showStatus(silent || !backendReady ? "" : difference < 0 ? `服务端插件已就绪（${version}），可以使用；它比扩展 ${PLUGIN_VERSION} 旧，建议更新：${updateServer}`
    : difference > 0 ? `服务端插件已就绪（${version}），可以使用；扩展 ${PLUGIN_VERSION} 比它旧，建议在扩展管理器里更新本扩展。`
    : `服务端插件已就绪（${version}）。`);
  return backendReady;
}

function mount() {
  if (document.getElementById("vertex_anti_truncation_settings")) return;
  const parent = document.getElementById("vertexai_form");
  if (!parent) { console.warn("[Vertex 抗截断] 找不到 Vertex 连接面板。兼容目标为 SillyTavern 1.19。"); return; }
  const panel = document.createElement("div");
  panel.id = "vertex_anti_truncation_settings";
  const label = document.createElement("label");
  label.htmlFor = "vertex_anti_truncation_mode";
  label.textContent = "抗截断传输";
  select = document.createElement("select");
  select.id = label.htmlFor;
  select.className = "text_pole";
  for (const value of MODES) select.add(new Option(labels[value], value));
  select.value = mode();
  select.addEventListener("change", () => {
    settings().mode = select.value;
    context.saveSettingsDebounced();
    showStatus();
  });
  status = document.createElement("small");
  status.hidden = true;
  status.className = "vertex-antitruncation-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const check = document.createElement("button");
  check.type = "button";
  check.className = "menu_button";
  check.textContent = "检查插件连接";
  check.title = "只检查酒馆服务端插件，不调用模型";
  check.addEventListener("click", () => checkBackend());
  const inputLabel = document.createElement("label");
  inputLabel.htmlFor = "vertex_input_encoding";
  inputLabel.textContent = "输入转码";
  const input = document.createElement("select");
  input.id = inputLabel.htmlFor;
  input.className = "text_pole";
  for (const [value, text] of [
    ["off", "关闭（保持原文）"],
    ["unicode", "Unicode（最新用户楼层或“我的行动”变量，及其副本）"],
    ["current-turn", "图片·当前轮（本轮用户文本）"],
    ["all", "图片·全部会话（用户与 AI 文本）"],
  ]) if (!direct || !["current-turn", "all"].includes(value)) input.add(new Option(text, value));
  const saved = settings();
  input.value = saved.unicodeInput === true ? "unicode"
    : !direct && ["current-turn", "all"].includes(saved.imageInput) ? saved.imageInput : "off";
  input.addEventListener("change", () => {
    const current = settings();
    current.unicodeInput = input.value === "unicode";
    current.imageInput = ["current-turn", "all"].includes(input.value) ? input.value : "off";
    context.saveSettingsDebounced();
    showStatus();
  });
  panel.append(label, select, inputLabel, input);
  // TauriTavern's own backend sends the request, so it cannot follow long-decode continuation tokens.
  if (!direct) {
    const tagStop = document.createElement("label");
    tagStop.className = "checkbox_label";
    tagStop.htmlFor = "vertex_tag_stop";
    const stopBox = Object.assign(document.createElement("input"), { type: "checkbox", id: tagStop.htmlFor, checked: saved.tucaoStop ?? true });
    const tagLabel = Object.assign(document.createElement("label"), { htmlFor: "vertex_stop_tag", textContent: "截停标签名（不含尖括号）" });
    const tagInput = Object.assign(document.createElement("input"), { type: "text", id: tagLabel.htmlFor, className: "text_pole", value: saved.stopTag ?? DEFAULT_STOP_TAG, maxLength: 64, placeholder: "tucao 或 A" });
    const countLabel = Object.assign(document.createElement("label"), { htmlFor: "vertex_stop_count", textContent: "完整出现次数" });
    const countInput = Object.assign(document.createElement("input"), { type: "number", id: countLabel.htmlFor, className: "text_pole", min: "1", step: "1", value: saved.stopCount ?? DEFAULT_STOP_COUNT });
    tagInput.disabled = countInput.disabled = !stopBox.checked;
    stopBox.addEventListener("change", () => {
      settings().tucaoStop = stopBox.checked;
      tagInput.disabled = countInput.disabled = !stopBox.checked;
      context.saveSettingsDebounced();
      showStatus();
    });
    for (const input of [tagInput, countInput]) input.addEventListener("change", () => {
      settings().stopTag = tagInput.value.trim();
      settings().stopCount = Number(countInput.value);
      context.saveSettingsDebounced();
    });
    tagStop.append(stopBox, Object.assign(document.createElement("span"), { textContent: "自定义标签截停" }));
    panel.append(tagStop, tagLabel, tagInput, countLabel, countInput, Object.assign(document.createElement("small"), { textContent:
      "默认开启：tucao，2 次。例如 A + 1 次，在完整 <A>…</A> 后停止。精确区分大小写，不匹配带属性的标签；保留命中的结束标签，丢弃后续所有内容（包括其后的 MVU 更新块）。仅抗截断生效时应用，每次请求重新计数。" }));
    const longDecode = document.createElement("label");
    longDecode.className = "checkbox_label";
    longDecode.htmlFor = "vertex_long_decode";
    const box = Object.assign(document.createElement("input"), { type: "checkbox", id: longDecode.htmlFor, checked: saved.longDecode === true });
    box.addEventListener("change", () => {
      settings().longDecode = box.checked;
      context.saveSettingsDebounced();
      showStatus();
    });
    longDecode.append(box, Object.assign(document.createElement("span"), { textContent: "Gemini 4 Argon 超长回复自动续写（long decode，实验）" }));
    panel.append(longDecode, Object.assign(document.createElement("small"), { textContent:
      "关闭时，最大回复长度超过单次上限（流式 65,536、非流式 32,768 token，含思考）会按单次上限发送，不再报错；回复写满就停止并标记为长度截断，非流式抗截断写满时可能拿不到正文。"
      + "开启后改用 Google 的 v1beta1 接口，写满后自动续写并拼成一条回复，最多写到预设的长度。只有真写超单次上限才会追加请求；每续写一段都重发完整上下文，费用和等待时间随之增加，整次请求最长 10 分钟。" }));
  }
  panel.append(status, direct ? Object.assign(document.createElement("small"),
    { textContent: "TauriTavern：抗截断由本扩展直接完成，无需服务端插件；不支持图片输入和超长回复自动续写。" }) : check);
  parent.append(panel);
  // Install once and chain any previously installed fetch wrapper.
  const key = Symbol.for("vertex-anti-truncation.fetch");
  if (!window[key]) {
    window[key] = true;
    window.fetch = createFetchInterceptor(window.fetch.bind(window), { origin: location.origin, getMode: mode,
      getImageInput: () => direct ? "off" : settings().imageInput || "off",
      getUnicodeInput: () => settings().unicodeInput === true,
      getLongDecode: () => !direct && settings().longDecode === true,
      getTagStop: () => direct || settings().tucaoStop === false ? null
        : { tag: settings().stopTag ?? DEFAULT_STOP_TAG, count: settings().stopCount ?? DEFAULT_STOP_COUNT },
      getUserFloor: () => {
        const context = SillyTavern.getContext();
        return latestUserInput(context.chat, context.chatMetadata?.variables);
      },
      // Image input, Continue and client tools require a matching server plugin.
      ensureBackend: async feature => Boolean(direct) ||
        Boolean((backendReady || await checkBackend(true)) && (!feature || backendFeatures.includes(feature))), onStatus: updateStatus, direct });
  }
  if (!direct) void checkBackend(true);
}

context.eventSource.on(events.APP_READY ?? events.APP_INITIALIZED, mount);
