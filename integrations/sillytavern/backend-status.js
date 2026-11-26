import { MIN_SERVER_VERSION, PLUGIN_FEATURES, PLUGIN_ID, PLUGIN_PATH, compareVersions } from "./shared.js";
import { httpRejection, networkCodes, safeVersion } from "./diagnostic-fields.js";

const numericVersion = value => safeVersion(value) && /^\d+(?:\.\d+){1,2}(?:[-+][\w.-]+)?$/.test(value) ? value : undefined;
const startupParts = { "plugin-module": "导入插件模块", build: "读取插件构建文件", "tavern-prompts": "导入酒馆 prompt-converters.js",
  "tavern-secrets": "导入酒馆 secrets.js", "tavern-constants": "导入酒馆 constants.js", "node-fetch": "导入 node-fetch", "register-routes": "注册插件接口" };
const startupCodes = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_DLOPEN_FAILED",
  "ERR_REQUIRE_ESM", "ERR_UNKNOWN_FILE_EXTENSION", "ENOENT", "EACCES", "EPERM", "SyntaxError", "TypeError", "Error"]);
const featureNames = { "vertex-region-routing": "区域路由", "client-tools": "客户端工具", "image-input-convert": "文字转图",
  "stop-after-tag-pairs": "标签截停", "tag-stop-exempt-block": "截停豁免块", "tag-stop-natural-usage": "截停后等待用量",
  "preset-transport-tool": "预设正文工具", "meow-compat": "小猫兼容模式" };
function pluginIdentity(evidence, data) {
  evidence.identified = true;
  evidence.version = numericVersion(data.version);
  const env = data.environment;
  if (typeof env?.build === "string" && /^[a-f\d]{8,64}$/i.test(env.build)) evidence.build = env.build;
  if (["linux", "win32", "darwin", "android", "freebsd", "openbsd", "netbsd", "sunos", "aix"].includes(env?.os)) evidence.os = env.os;
  if (["x64", "arm64", "arm", "ia32", "riscv64", "ppc64", "s390x", "loong64", "mips", "mipsel"].includes(env?.arch)) evidence.arch = env.arch;
  evidence.node = numericVersion(env?.node);
  if (typeof data.ready === "boolean") evidence.ready = data.ready;
  if (data.error?.code === "plugin_startup_failed" && Object.hasOwn(startupParts, data.startup?.phase)) {
    evidence.startup = startupParts[data.startup.phase];
    if (startupCodes.has(data.startup.code)) evidence.startupCode = data.startup.code;
    if (["integrations/sillytavern/server.mjs", "src/prompt-converters.js", "src/endpoints/secrets.js", "src/constants.js"].includes(data.startup.file)) evidence.startupFile = data.startup.file;
  }
}
async function readErrorBody(response, signal) {
  if (response.bodyUsed || response.body?.locked) return { note: "错误正文已被读取或占用" };
  const reader = response.body?.getReader();
  const limit = 16 * 1024;
  let size = 0, text = "", note, data;
  if (reader) {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { text += decoder.decode(); break; }
        size += value.byteLength;
        if (size > limit) {
          note = "错误正文超过 16 KiB";
          void reader.cancel().catch(() => {});
          break;
        }
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      note = signal.aborted && signal.reason?.name === "TimeoutError" ? "读取错误正文超时" : "读取错误正文时中断";
    } finally { reader.releaseLock(); }
  }
  if (!note && text) {
    if (/json/i.test(response.headers.get("content-type") ?? "") || /^\s*[\[{]/.test(text)) {
      try { data = JSON.parse(text); } catch { note = "响应格式错误，错误正文不是有效的 JSON"; }
    } else data = text;
  }
  return { data, note };
}
// Keep HTTP evidence even when a proxy, login page or older plugin answers.
// The response body is consumed here and is never copied into a report.
export async function readDiagnosticEndpoint(path, getHeaders, timeoutMs, requestSignal) {
  const evidence = { at: new Date().toISOString() };
  const began = performance.now();
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = requestSignal ? AbortSignal.any([requestSignal, deadline]) : deadline;
  let data, started = false;
  try {
    const headers = getHeaders();
    started = true;
    const response = await fetch(path, { headers, cache: "no-store", signal });
    const type = response.headers.get("content-type") ?? "";
    Object.assign(evidence, { http: response.status, type: /html/i.test(type) ? "HTML" : /json/i.test(type) ? "JSON" : "其他",
      redirected: response.redirected });
    if (!response.ok) {
      evidence.result = "http";
      const body = await readErrorBody(response, signal);
      evidence.rejection = httpRejection(response.status, response.headers, body.data, body.note);
      // An error can identify the plugin without granting any capabilities.
      if (body.data?.id === PLUGIN_ID) pluginIdentity(evidence, body.data);
    } else if (evidence.type === "HTML") {
      const path = response.url && new URL(response.url).pathname;
      evidence.result = path === "/login" || path === "/login.html" ? "login-page" : "html";
    }
    else {
      data = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data)) evidence.result = "json-shape";
      else evidence.result = data.error || (!data.id && (data.code || data.reason)) ? "reported-error" : "ok";
      if (evidence.result === "reported-error" || data?.ready === false)
        evidence.rejection = httpRejection(response.status, response.headers, data);
    }
  } catch (error) {
    if (requestSignal?.aborted) evidence.result = "cancelled";
    else if (!started) evidence.result = "headers";
    else if (deadline.aborted || error?.name === "TimeoutError") evidence.result = "timeout";
    else evidence.result = error instanceof SyntaxError ? "json" : "network";
    if (evidence.result === "timeout") evidence.timeoutMs = timeoutMs;
    if (evidence.result === "network") evidence.network = networkCodes(error);
  }
  evidence.elapsedMs = Math.round(performance.now() - began);
  return { evidence, data };
}

export async function readPluginJournal(path, getHeaders, signal) {
  const reply = await readDiagnosticEndpoint(path + "/diagnostics", getHeaders, 2000, signal);
  const { evidence, data } = reply;
  if (data?.id === PLUGIN_ID && (evidence.result === "reported-error" || Array.isArray(data.records))) {
    evidence.identified = true;
    evidence.version = numericVersion(data.version);
  }
  if (evidence.result === "json-shape") evidence.result = "journal-shape";
  if (evidence.result === "ok") {
    if (data.id != null && data.id !== PLUGIN_ID) evidence.result = "journal-id";
    else if (!Object.hasOwn(data, "records")) evidence.result = "no-records";
    else if (!Array.isArray(data.records)) evidence.result = "invalid-records";
  }
  return reply;
}

export async function readInstallation(signal) {
  const asset = name => readDiagnosticEndpoint(new URL("../../" + name, import.meta.url).href, () => ({}), 1500, signal);
  const { evidence, data } = await asset("vertex-installation.json");
  const receipt = { evidence };
  if (evidence.result !== "ok") return receipt;
  if (data?.id !== PLUGIN_ID || !numericVersion(data.version) || typeof data.linked !== "boolean" ||
      typeof data.installedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(data.installedAt)) {
    evidence.result = "invalid-receipt"; return receipt;
  }
  Object.assign(receipt, { version: data.version, at: data.installedAt, linked: data.linked });
  if (data.linked && !signal?.aborted) {
    const { evidence: file, data: marker } = await asset("vertex-server-receipt/installation.json");
    receipt.file = file;
    if (file.result === "ok") {
      if (marker?.id !== PLUGIN_ID || !numericVersion(marker.version) || typeof marker.installedAt !== "string") file.result = "invalid-receipt";
      else if (marker.version !== data.version || marker.installedAt !== data.installedAt) file.result = "different-install";
    }
  }
  return receipt;
}

export async function probeBackend(getHeaders, confirmInstallation = false, signal, checkReceipt = confirmInstallation) {
  const { evidence, data } = await readDiagnosticEndpoint(PLUGIN_PATH + "/status", getHeaders, 5000, signal);
  evidence.minimumVersion = MIN_SERVER_VERSION;
  if (data?.id !== PLUGIN_ID) {
    if (evidence.result === "ok") evidence.result = data?.id ? "wrong-plugin" : "no-id";
    // A proxy can break just /status. Use the other read-only plugin route as
    // independent evidence. Its history never supplies this request's capabilities.
    if (confirmInstallation && !evidence.identified && !signal?.aborted) {
      const { evidence: other } = await readPluginJournal(PLUGIN_PATH, getHeaders, signal);
      if (other.result === "ok" && !other.identified) other.result = "legacy-log";
      evidence.other = other;
    }
    if (checkReceipt && !evidence.identified && !evidence.other?.identified && !signal?.aborted) {
      evidence.installation = await readInstallation(signal);
    }
    return evidence;
  }
  pluginIdentity(evidence, data);
  if (Array.isArray(data.features) && data.features.every(f => typeof f === "string")) {
    evidence.features = PLUGIN_FEATURES.filter(f => data.features.includes(f));
  } else if (data.features != null) evidence.invalidFeatures = true;
  if (evidence.result === "reported-error") return evidence;
  if (!evidence.version) evidence.result = data.version == null ? "missing-version" : "version";
  else if (data.ready === false) evidence.result = "unready";
  else if (data.ready != null && typeof data.ready !== "boolean") evidence.result = "invalid-ready";
  else if (compareVersions(data.version, MIN_SERVER_VERSION) < 0) evidence.result = "outdated";
  return evidence;
}

export function endpointProblem(e) {
  if (e.result === "cancelled") return "请求已取消，状态检查已结束";
  if (e.result === "headers") return "未能读取酒馆的鉴权请求头";
  if (e.result === "http") {
    const reason = { 401: "需要登录", 403: "访问被拒绝", 404: "找不到接口", 502: "网关错误", 503: "服务不可用", 504: "网关超时" }[e.http];
    return "HTTP " + e.http + (reason ? "，" + reason : "") + (e.rejection ? "。" + e.rejection : "");
  }
  if (e.result === "html") return e.redirected ? "重定向后收到了 HTML 网页" : "收到了 HTML 网页";
  if (e.result === "login-page") return "收到酒馆登录页，请重新登录酒馆";
  if (e.result === "journal-id") return "日志接口返回了其他插件的标识";
  if (e.result === "json-shape") return "响应格式错误，应为 JSON 对象";
  if (e.result === "journal-shape") return "日志接口响应格式错误，应为包含 records 字段的 JSON 对象";
  if (e.result === "no-records") return "日志接口缺少 records 字段";
  if (e.result === "invalid-records") return "日志接口的 records 字段格式错误，应为数组";
  if (e.result === "records") return "日志条目格式错误";
  if (e.result === "unknown-reply") return "无效返回";
  if (e.result === "reported-error") return "接口报告错误，" + e.rejection;
  if (e.result === "invalid-receipt") return "安装回执字段格式错误";
  if (e.result === "different-install") return "前后端安装批次不同";
  if (e.result === "timeout") return "等待 " + e.timeoutMs + " 毫秒后超时";
  if (e.result === "json") return "响应格式错误，正文不是有效的 JSON";
  if (e.result === "network") return e.http ? "读取响应正文时连接失败" : "浏览器未收到 HTTP 响应";
  return e.rejection;
}

export function backendFinding(e, feature, other = e.other) {
  const problem = endpointProblem(e);
  const startup = e.startup ? e : other?.startup ? other : undefined;
  if (startup) {
    const code = startup.startupCode;
    let failure = startup.startup;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND")
      failure += startup.startupFile ? "时缺少文件 " + startup.startupFile : "时缺少依赖模块";
    else if (code === "SyntaxError") failure += "时遇到语法错误";
    else if (code === "EACCES" || code === "EPERM") failure += "时权限不足";
    return "配套服务端插件已安装" + (startup.version ? "（" + startup.version + "）" : "") + "，初始化失败。" + failure + "（" + (code ?? "N/A") + "）。" +
      (startup.startupFile === "integrations/sillytavern/server.mjs" ? "请重新安装配套服务端插件，然后重启酒馆。" : "");
  }
  if (!e.identified) {
    let detail;
    if (e.result === "json" || e.result === "json-shape") detail = "状态接口" + problem;
    else if (problem) detail = "状态检查" + (e.result === "http" ? "返回 " : " · ") + problem;
    else detail = e.result === "wrong-plugin" ? "状态接口返回了其他插件的标识" : "状态接口未返回插件标识";
    if (other?.identified) return "配套服务端插件已安装并加载" + (other.version ? "（" + other.version + "）" : "") + "，已由日志接口确认。" + detail + "。";
    if (e.http === 404 && other?.http === 404) {
      if (e.installation?.file?.result === "ok") return "服务端插件文件已安装（" + e.installation.version + "），酒馆的插件接口均返回 404。在 config.yaml 中启用 enableServerPlugins 后重启酒馆。";
      if (e.installation?.file?.http === 404) return "一键安装记录存在，服务端插件的安装文件回执缺失，两个插件接口均返回 404。在运行酒馆的机器上重新安装配套服务端插件，然后重启酒馆。";
      return "酒馆没有提供配套服务端插件接口（状态与日志均为 HTTP 404）。在运行酒馆的机器上安装配套服务端插件。安装包中的 server/vertex-anti-truncation 应放在酒馆根目录的 plugins/ 下，更新时沿用原插件目录。把酒馆根目录 config.yaml 中的 enableServerPlugins 设为 true，然后重启酒馆。安装状态=N/A。";
    }
    return detail + "。" + (e.installation?.file?.result === "ok" ? "服务端插件文件已安装（" + e.installation.version + "）。" : "安装状态=N/A。");
  }
  const loaded = "配套服务端插件已安装并加载" + (e.version ? "（" + e.version + "）" : "");
  if (e.result === "http") return loaded + "，状态检查返回 " + problem + "。";
  if (e.result === "reported-error") return loaded + "，状态接口报告错误。" + e.rejection;
  if (e.result === "version") return loaded + "，版本号格式错误。";
  if (e.result === "missing-version") return loaded + "，状态接口缺少版本号。";
  if (e.result === "outdated") return loaded + "，扩展至少需要 " + e.minimumVersion + "。请更新配套服务端插件，然后重启酒馆。";
  if (e.result === "unready") return loaded + "，插件报告尚未就绪。" + (e.rejection ?? "");
  if (e.result === "invalid-ready") return loaded + "，就绪字段格式无效。";
  if (feature && feature !== "base" && !e.features?.includes(feature)) {
    if (!e.features) return loaded + (e.invalidFeatures ? "，功能清单格式无效" : "，未返回功能清单") + "，" + feature + "=N/A。";
    return loaded + "，该版本未提供" + (featureNames[feature] ?? feature) + "功能。请更新配套服务端插件，然后重启酒馆。";
  }
  return loaded + "。";
}
