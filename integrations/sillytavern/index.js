import { PLUGIN_ID, PLUGIN_PATH, PLUGIN_VERSION, MIN_SERVER_VERSION, MODES, compareVersions, createFetchInterceptor, latestUserInput } from "./shared.js";
import { normalizeStopUsageWait, DEFAULT_STOP_TAG, DEFAULT_STOP_COUNT, validateTagStopRule } from "../../src/tag-stop-rule.mjs";
import { DEFAULT_TRANSPORT_TOOL_NAME, validateTransportToolName } from "../../src/transport-tool-name.mjs";

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
  paygo_image_backend_required: "PayGo 图片转码需要配套的新版抗截断服务端插件。请更新后重启酒馆。",
  paygo_long_decode_unsupported: "当前 PayGo 后端不支持 Gemini 4 分段续写。请降低最大回复长度，或关闭 long decode 后使用单次上限。",
  natural_stop_usage_not_supported: "当前服务端插件不支持等待 Google 自然结束。请更新服务端并重启酒馆，或选择其他截停等待方式。",
  tag_stop_not_supported: "服务端插件不支持自定义标签截停。请更新服务端插件并重启酒馆，或关闭此开关。",
  transport_tool_name_not_supported: "服务端插件不支持自定义正文传输工具名。请更新服务端并重启酒馆，或清空工具名以使用默认值。",
  invalid_tag_stop: "截停标签名须为 1–64 位字母、数字、下划线、点、冒号或连字符，以字母或下划线开头；次数须为正整数。",
  image_input_requires_supported_request: "图片输入不支持此请求，已停止发送，未改用明文。请去掉不支持的内容或换用支持的模型，或关闭图片输入。",
  image_input_unsupported_characters: "图片转码遇到无法绘制的字符。请替换提示位置的字符，或改用“图片·当前轮”。",
  image_input_too_large: "转成图片后超过大小或页数限制，已停止发送。请缩短对话，或改用“图片·当前轮”。",
  image_renderer_unavailable: "服务端图片渲染组件不可用。请在服务端插件目录运行 npm ci --ignore-scripts 后重启酒馆。",
  image_render_failed: "服务端图片渲染失败，已停止发送，未改用明文。",
  request_too_large: "请求超过 8 MiB，插件已拒绝发送。请减少附件或聊天历史。",
  gemini4_long_decode_required: "服务端插件较旧，输出上限超过 Gemini 4 Argon 单次上限时会拒绝发送。请更新服务端插件后重启酒馆；或在预设里把最大回复长度降到 32,768（非流式）／65,536（流式）以内。" };
const updateServer = "用安装包装的，下载新版安装包再运行一次；用 Git 装的，在服务端插件目录运行 git pull --ff-only 和 npm ci --ignore-scripts。之后重启酒馆并重新检查。";
let status, backendReady, backendFeatures = [], backendWarning;
function settings() {
  const store = SillyTavern.getContext().extensionSettings;
  // Existing profiles without a saved switch used the old enabled default.
  store[PLUGIN_ID] ??= { mode: "off", unicodeInput: false, tucaoStop: false };
  return store[PLUGIN_ID];
}
function mode() { return MODES.includes(settings().mode) ? settings().mode : "off"; }
function saveSettings(changes) {
  Object.assign(settings(), changes);
  context.saveSettingsDebounced();
  showStatus();
}
function showStatus(text = "") {
  if (!status) return;
  // A failed version check stays visible until a later check succeeds.
  if (!text && backendReady === false) text = backendWarning;
  status.textContent = text;
  status.hidden = !text;
}
function updateStatus(result) {
  if (result.error) {
    if (result.message && result.message !== result.error) return showStatus(result.message);
    const code = result.status ? `${result.error}，HTTP ${result.status}` : result.error;
    const cause = result.bypass ? `原因：${reasons[result.bypass] ?? result.bypass}。` : "";
    const where = result.character && result.param ? ` ${result.character}，位置 ${result.param}。` : "";
    return showStatus((errors[result.error] || `请求失败（${code}）。请查看酒馆错误提示；未自动重试。`) + where + cause);
  }
  const unicode = result.unicode ? { encoded: result.unicode.method === "all-context" ? `已对全部上下文中的 ${result.unicode.matchedMessages} 条消息转码。` : "已对当前用户输入的匹配文本转码。", "floor-not-found": "请求中没有找到当前用户输入的原文，按原文发送。", "no-encodable-text": "所选范围没有需要转码的字符。" }[result.unicode.reason] || "" : "";
  const format = { alternate: "隔字 Unicode", table: "高频字表" }[result.unicode?.format];
  const basis = { gemma: "酒馆 Gemma 分词估算", utf8: "分词器不可用，按 UTF-8 长度估算", "body-limit": "另一种格式超过请求大小限制" }[result.unicode?.selection];
  const optimized = format ? format + "（" + basis + "）。" : "";
  const noText = result.image?.mode === "current-turn"
    ? "图片·当前轮：最后一条 AI 消息之后没有可转换的文本（如点击“继续”或以 AI 消息结尾的预填充），本次按原文发送。"
    : "图片·全部会话：没有可转换的文本，本次按原文发送。";
  const image = result.image ? { encoded: `已将文本转为图片发送${result.image.pages ? `（${result.image.pages} 页）` : ""}。`,
    "no-text": noText }[result.image.reason] || "" : "";
  const delivery = result.image && { "native-streaming": "正文按流式接收。", "paygo-streaming": "正文经 PayGo 流式接收。", buffered: "正文整段返回。" }[result.image.transport];
  const bypass = result.bypass && result.bypass !== "disabled" ? `本次使用普通 Vertex：${reasons[result.bypass] ?? result.bypass}。` : "";
  const continuation = result.continuation ? "本次“继续”已请求仅生成新增续文，由酒馆追加到原消息。" : "";
  const limit = result.outputLimit, tokens = value => value.toLocaleString("en-US");
  const output = !limit ? "" : limit.longDecode
    ? `本次输出上限 ${tokens(limit.applied)} token（含思考）超过单次上限，写满后自动续写。`
    : `本次输出上限按单次上限 ${tokens(limit.applied)} token（含思考）发送，预设未改动；写满会停止并标记为长度截断。`;
  showStatus([result.payGo && "本次通过 Vertex PayGo 发送。", unicode, optimized, image, delivery, bypass, continuation, output].filter(Boolean).join(" "));
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

function mountInputEncoding(panel, saved) {
  const method = panel.querySelector("#vertex_input_encoding");
  const scope = panel.querySelector("#vertex_encoding_scope");
  const summary = panel.querySelector("#vertex_encoding_summary");
  if (!direct) method.add(new Option("文字转图", "image"));
  const unicode = saved.unicodeInput;
  if (unicode === "optimized" || unicode === "optimized-all") method.value = "optimized";
  else if (unicode === true || unicode === "all") method.value = "unicode";
  else if (!direct && ["current-turn", "all"].includes(saved.imageInput)) method.value = "image";
  scope.value = (method.value === "image" ? saved.imageInput === "all" : unicode === "all" || unicode === "optimized-all") ? "all" : "current";

  function render() {
    const image = method.value === "image";
    scope.options[0].text = image ? "当前轮" : "当前输入";
    scope.options[1].text = image ? "全部会话" : "全部上下文";
    scope.parentElement.hidden = method.value === "off";
    summary.textContent = method.selectedOptions[0].text + (method.value === "off" ? "" : " · " + scope.selectedOptions[0].text);
  }
  function change() {
    const all = scope.value === "all";
    const unicodeInput = method.value === "unicode" ? (all ? "all" : true)
      : method.value === "optimized" ? (all ? "optimized-all" : "optimized") : false;
    const imageInput = method.value === "image" ? (all ? "all" : "current-turn") : "off";
    saveSettings({ unicodeInput, imageInput });
    render();
  }
  method.addEventListener("change", change);
  scope.addEventListener("change", change);
  render();
}

function mountTransportOptions(panel, select, saved, payGoInstalled) {
  const options = panel.querySelector("#vertex_transport_options");
  const summary = panel.querySelector("#vertex_transport_summary");
  const stop = panel.querySelector("#vertex_tag_stop");
  const fields = panel.querySelector("#vertex_tag_fields");
  const tag = panel.querySelector("#vertex_stop_tag");
  const count = panel.querySelector("#vertex_stop_count");
  const wait = panel.querySelector("#vertex_wait_for_stop_usage");
  const tool = panel.querySelector("#vertex_transport_tool_name");
  const hostStream = document.getElementById("stream_toggle");
  stop.checked = saved.tucaoStop ?? true;
  tag.value = saved.stopTag ?? DEFAULT_STOP_TAG;
  count.value = saved.stopCount ?? DEFAULT_STOP_COUNT;
  wait.value = String(normalizeStopUsageWait(saved.waitForStopUsage));
  tool.placeholder = DEFAULT_TRANSPORT_TOOL_NAME;
  tool.value = saved.transportToolName ?? "";

  function render() {
    options.hidden = select.value === "off";
    fields.hidden = !stop.checked;
    // TT always reads SSE. PayGo can also buffer a streamed host reply.
    const streaming = hostStream?.checked ?? context.chatCompletionSettings?.stream_openai;
    const payGo = payGoInstalled || typeof window.vertexPayGoGemini4GenerateInterceptor === "function";
    wait.parentElement.hidden = !(direct || (streaming && (select.value === "streaming" || payGo)));
    summary.textContent = stop.checked ? `第 ${count.value} 对 <${tag.value}> 后停止` : "标签截停已关闭";
  }
  select.addEventListener("change", () => { saveSettings({ mode: select.value }); render(); });
  stop.addEventListener("change", () => { saveSettings({ tucaoStop: stop.checked }); render(); });
  wait.addEventListener("change", () => saveSettings({ waitForStopUsage: wait.value === "natural" ? "natural" : wait.value === "true" }));
  function changeRule() {
    try {
      const rule = validateTagStopRule({ tag: tag.value.trim(), count: count.valueAsNumber });
      tag.value = rule.tag;
      saveSettings({ stopTag: rule.tag, stopCount: rule.count });
    } catch (error) {
      tag.value = settings().stopTag ?? DEFAULT_STOP_TAG;
      count.value = settings().stopCount ?? DEFAULT_STOP_COUNT;
      showStatus(error.message + " 已恢复上次设置。");
    }
    render();
  }
  tag.addEventListener("change", changeRule);
  count.addEventListener("change", changeRule);
  tool.addEventListener("change", () => {
    try {
      tool.value = validateTransportToolName(tool.value.trim());
      saveSettings({ transportToolName: tool.value });
    } catch (error) {
      tool.value = settings().transportToolName ?? "";
      showStatus(error.message + " 已恢复上次设置。");
    }
  });
  hostStream?.addEventListener("change", render);
  if (events.OAI_PRESET_CHANGED_AFTER) context.eventSource.on(events.OAI_PRESET_CHANGED_AFTER, render);
  render();
}

function mount() {
  if (document.getElementById("vertex_anti_truncation_settings")) return;
  const parent = document.getElementById("vertexai_form");
  if (!parent) { console.warn("[Vertex 抗截断] 找不到 Vertex 连接面板。兼容目标为 SillyTavern 1.19。"); return; }
  const panel = document.createElement("div");
  panel.id = "vertex_anti_truncation_settings";
  panel.innerHTML = `
    <label for="vertex_anti_truncation_mode">抗截断传输</label>
    <select id="vertex_anti_truncation_mode" class="text_pole"></select>
    <details>
      <summary>输入转码 <span id="vertex_encoding_summary"></span></summary>
      <div class="vertex-fields">
        <label>转码方式<select id="vertex_input_encoding" class="text_pole">
          <option value="off">关闭</option><option value="unicode">Unicode</option><option value="optimized">优化转码（实验）</option>
        </select></label>
        <label>转码范围<select id="vertex_encoding_scope" class="text_pole">
          <option value="current">当前输入</option><option value="all">全部上下文</option>
        </select></label>
      </div>
    </details>
    <details id="vertex_transport_options">
      <summary>传输与截停 <span id="vertex_transport_summary"></span></summary>
      <div class="vertex-fields">
        <label class="checkbox_label"><input type="checkbox" id="vertex_tag_stop"> 自定义标签截停</label>
        <div class="vertex-fields" id="vertex_tag_fields">
          <label>截停标签名（不含尖括号）<input class="text_pole" id="vertex_stop_tag" maxlength="64"></label>
          <label>完整出现次数<input class="text_pole" id="vertex_stop_count" type="number" min="1" step="1"></label>
          <small>命中的结束标签会保留，之后的内容会丢弃，包括 MVU 变量更新。</small>
          <label>截停后接收用量<select class="text_pole" id="vertex_wait_for_stop_usage">
            <option value="false">立即断流</option>
            <option value="true">最多等 250 毫秒</option>
            <option value="natural">等 Google 自然结束</option>
          </select><small>命中标签后正文立即停显。等待期间 Google 生成的 token 会计入用量，点酒馆的停止按钮可提前断开。分段续写请求仍立即断流。</small></label>
        </div>
        <label>正文传输工具名<input class="text_pole" id="vertex_transport_tool_name" maxlength="64" spellcheck="false" aria-describedby="vertex_tool_name_help"></label>
        <small id="vertex_tool_name_help">留空自动命名。预设或上游要求固定名称时填写，其他工具沿用原名。</small>
      </div>
    </details>
    <div class="vertex-connection">
      <small class="vertex-antitruncation-status" role="status" aria-live="polite" hidden></small>
    </div>`;
  const select = panel.querySelector("#vertex_anti_truncation_mode");
  for (const value of MODES) select.add(new Option(labels[value], value));
  select.value = mode();
  const saved = settings();
  const payGoInstalled = !direct && window.fetch.name === "payGoFetch";
  const connection = panel.querySelector(".vertex-connection");
  status = connection.querySelector("[role=status]");
  mountInputEncoding(panel, saved);
  mountTransportOptions(panel, select, saved, payGoInstalled);
  if (direct) {
    connection.append(Object.assign(document.createElement("small"), { textContent: "TauriTavern 扩展已加载。" }));
  } else {
    if (saved.longDecode === true) {
      const legacy = document.createElement("div");
      legacy.className = "vertex-fields";
      legacy.innerHTML = `<label class="checkbox_label"><input type="checkbox" id="vertex_long_decode" checked> Argon 超长自动续写（旧设置）</label>
        <small>每段续写会重发上下文并计费。下个插件版本将移除此功能，届时请在独立网关开启。关闭并刷新后，此入口会收起。</small>`;
      const box = legacy.querySelector("input");
      box.addEventListener("change", () => saveSettings({ longDecode: box.checked }));
      connection.before(legacy);
    }
    const check = Object.assign(document.createElement("button"), { type: "button", className: "menu_button",
      textContent: "检查插件连接", title: "只检查酒馆服务端插件，不调用模型" });
    check.addEventListener("click", () => checkBackend());
    connection.append(check);
  }
  parent.append(panel);
  // Install once and chain any previously installed fetch wrapper.
  const key = Symbol.for("vertex-anti-truncation.fetch");
  if (!window[key]) {
    window[key] = true;
    window.fetch = createFetchInterceptor(window.fetch.bind(window), { origin: location.origin, getMode: mode,
      payGoInstalled,
      getRequestHeaders: () => SillyTavern.getContext().getRequestHeaders(),
      getImageInput: () => direct ? "off" : settings().imageInput || "off",
      getUnicodeInput: () => settings().unicodeInput,
      getTransportToolName: () => settings().transportToolName ?? "",
      getLongDecode: () => !direct && settings().longDecode === true,
      getWaitForStopUsage: () => settings().waitForStopUsage,
      getTagStop: () => settings().tucaoStop === false ? null
        : { tag: settings().stopTag ?? DEFAULT_STOP_TAG, count: settings().stopCount ?? DEFAULT_STOP_COUNT },
      getUserFloor: () => {
        const context = SillyTavern.getContext();
        return latestUserInput(context.chat, context.chatMetadata?.variables);
      },
      // Image input, Continue and client tools require a matching server plugin.
      ensureBackend: async feature => (backendReady || await checkBackend(true)) && (!feature || backendFeatures.includes(feature)),
      onStatus: updateStatus, direct });
  }
  if (!direct) void checkBackend(true);
}

context.eventSource.on(events.APP_READY ?? events.APP_INITIALIZED, mount);
