import { PLUGIN_ID, PLUGIN_PATH, PLUGIN_VERSION, MODES, createFetchInterceptor, latestUserFloor } from "./shared.js";

const context = SillyTavern.getContext();
const events = context.eventTypes ?? context.event_types;
const labels = { off: "关闭（普通 Vertex）", buffered: "非流式抗截断", streaming: "流式抗截断" };
let status, select;
function settings() {
  const store = SillyTavern.getContext().extensionSettings;
  store[PLUGIN_ID] ??= { mode: "off", unicodeInput: false };
  return store[PLUGIN_ID];
}
function mode() { return MODES.includes(settings().mode) ? settings().mode : "off"; }
function showStatus(text = "") {
  if (!status) return;
  status.textContent = text;
  status.hidden = !text;
}
function updateStatus(result) {
  const errors = { unicode_floor_required: "找不到真实用户楼层，已停止发送。请先输入消息，或关闭 Unicode 转码。",
    unicode_input_too_large: "转码后的请求超过大小限制，已停止发送。请缩短输入或关闭 Unicode 转码。" };
  showStatus(result.error ? errors[result.error] || `请求失败（${result.error}）。请查看酒馆错误提示；未自动重试。`
    : result.unicode ? ({ encoded: "已对当前用户楼层的匹配文本转码。", "floor-not-found": "未匹配到用户楼层原文，按原文发送。", "no-encodable-text": "当前楼层没有需要转码的字符。" }[result.unicode.reason] || "") : "");
}

async function checkBackend(silent = false) {
  if (!silent) showStatus("正在检查服务端插件…");
  try {
    const response = await fetch(`${PLUGIN_PATH}/status`, { headers: context.getRequestHeaders(), signal: AbortSignal.timeout(5000) });
    const data = response.ok ? await response.json() : null;
    if (data?.id !== PLUGIN_ID || data?.version !== PLUGIN_VERSION) throw new Error();
    showStatus(silent ? "" : "服务端插件已就绪。");
  } catch {
    showStatus("服务端插件未就绪或版本不匹配。安装配套服务端插件并重启酒馆，然后重新检查。");
  }
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
  const unicodeLabel = document.createElement("label");
  unicodeLabel.className = "checkbox_label";
  const unicode = document.createElement("input");
  unicode.type = "checkbox";
  unicode.id = "vertex_unicode_input";
  unicode.checked = settings().unicodeInput === true;
  unicode.addEventListener("change", () => {
    settings().unicodeInput = unicode.checked;
    context.saveSettingsDebounced();
    showStatus();
  });
  unicodeLabel.append(unicode, document.createTextNode("Unicode 输入转码（所有 Vertex 模式）"));
  const unicodeHint = document.createElement("small");
  unicodeHint.id = "vertex_unicode_hint";
  unicodeHint.textContent = "独立于抗截断；仅编码最新真实用户楼层的匹配文本，默认关闭。可能增加 token 用量；请关闭预设中的重复转码。";
  unicode.setAttribute("aria-describedby", unicodeHint.id);
  panel.append(label, select, unicodeLabel, unicodeHint, status, check);
  parent.append(panel);
  // Install once and chain any previously installed fetch wrapper.
  const key = Symbol.for("vertex-anti-truncation.fetch");
  if (!window[key]) {
    window[key] = true;
    window.fetch = createFetchInterceptor(window.fetch.bind(window), { origin: location.origin, getMode: mode,
      getUnicodeInput: () => settings().unicodeInput === true,
      getUserFloor: () => latestUserFloor(SillyTavern.getContext().chat), onStatus: updateStatus });
  }
  void checkBackend(true);
}

context.eventSource.on(events.APP_READY ?? events.APP_INITIALIZED, mount);
