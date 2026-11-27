// Every stored field is selected here or at its owning boundary. A provider
// message may quote the prompt; it belongs only in the optional on-screen preview.
export const DIAGNOSTIC_HEADER = "x-vertex-diagnostic-id";
export const CLIENT_HEADER = "x-vertex-diagnostic-client";
export const HISTORY_LIMIT = 20;
export const diagnosticId = value => typeof value === "string" && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value) ? value : undefined;
export const safeCode = value => typeof value === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : undefined;
export const safeModel = value => typeof value === "string" && /^gemini-[a-z0-9][a-z0-9.-]{0,63}$/.test(value) ? value : undefined;
export const safeVersion = value => typeof value === "string" && /^\d[\w.+-]{0,39}$/.test(value) ? value : undefined;

const configMessages = {
  vertex_service_account_missing: "酒馆当前选择的凭据中没有服务账号。请在 Google Vertex AI 连接设置中保存并选择服务账号 JSON。",
  vertex_api_key_missing: "酒馆当前选择的凭据中没有 API Key。请在 Google Vertex AI 的 Express 连接设置中保存并选择密钥。",
  "Invalid VERTEX_FALLBACK_LOCATIONS": "备用地区设置有误。最多选择两个有效地区，并移除重复项。",
  "Invalid service tier": "服务等级设置有误。请选择 Standard、Flex 或 Priority。",
  "Invalid VERTEX_PROJECT_ID": "Vertex 项目 ID 缺失或格式错误。",
  "Invalid VERTEX_LOCATION": "所选 Vertex 地区格式错误。请重新选择地区。",
  "Invalid VERTEX_API_KEY": "已保存的 Vertex API Key 格式错误。",
  "VERTEX_API_KEY must contain only visible ASCII characters": "已保存的 Vertex API Key 含有无效字符。",
  "Express, Flex and Priority require the global location": "当前鉴权方式或服务等级要求将 Vertex 地区设为 global。",
  "Service account must contain a valid RSA private key": "服务账号 JSON 的 private_key 无效。请重新导入有效的 RSA 服务账号密钥。",
  "vertex service account secret is not valid JSON": "已保存的服务账号 JSON 解析失败。请重新导入完整的 JSON 文件。",
  "vertex service account secret must contain type, client_email, private_key and an HTTPS token_uri": "服务账号 JSON 字段错误。需要 type=service_account、client_email、private_key 和 HTTPS token_uri。",
  "Only Google's OAuth token endpoint is allowed": "服务账号 JSON 中的 token_uri 错误。应为 https://oauth2.googleapis.com/token。",
  "vertex token exchange returned no access_token": "Google 令牌响应缺少 access_token。",
  express_project_required: "使用此模型的 Express 连接需要填写 API Key 所属的项目 ID。",
  unsupported_authentication_mode: "插件直连只支持服务账号或 Express 鉴权。",
};
export const configurationProblem = value => typeof value === "string" && Object.hasOwn(configMessages, value) ? configMessages[value] : undefined;
const oauthMessages = {
  invalid_grant: "Google 拒绝了服务账号签发的凭据", invalid_client: "Google 拒绝了客户端身份",
  unauthorized_client: "客户端无权申请令牌", access_denied: "Google 拒绝授权", invalid_scope: "Google 拒绝了申请的授权范围",
  invalid_request: "Google 拒绝了令牌请求的格式", unsupported_grant_type: "Google 不支持本次授权类型",
  temporarily_unavailable: "Google 令牌服务暂时不可用", server_error: "Google 令牌服务发生错误",
};
export const oauthProblem = value => typeof value === "string" && Object.hasOwn(oauthMessages, value) ? oauthMessages[value] : undefined;
const googleMessages = {
  IAM_PERMISSION_DENIED: "当前凭据缺少访问该 Vertex 资源的 IAM 权限", BILLING_DISABLED: "Google Cloud 项目没有启用结算",
  SERVICE_DISABLED: "Google Cloud 项目没有启用请求的服务", API_KEY_INVALID: "Google 拒绝了当前 API Key",
  PERMISSION_DENIED: "Vertex 拒绝了这次访问", UNAUTHENTICATED: "Vertex 拒绝了本次身份验证",
  INVALID_ARGUMENT: "Vertex 拒绝了请求参数", RESOURCE_EXHAUSTED: "Vertex 报告可用资源已耗尽",
};
export function googleProblem(detail) {
  const key = [detail?.reason, detail?.status].find(value => typeof value === "string" && Object.hasOwn(googleMessages, value));
  return key ? googleMessages[key] + "（" + key + "）" : undefined;
}

// Proxies sometimes put arbitrary user text or credentials in an error code.
// Only copy identifiers made of diagnostic terms, and fixed descriptions of
// stock Tavern error pages. Neither messages nor authentication realms leave the browser.
const reasonWords = new Set(("access account address admin allowed api auth authenticated authentication authorization " +
  "bad blocked client code connection credentials csrf denied disabled disallowed domain error exceeded expired failed forbidden " +
  "gateway grant host insufficient invalid ip limit limited login locked method missing not origin password permission policy " +
  "proxy quota rate rejected request required resource retry route scope server service session timeout token unauthenticated " +
  "unauthorized unavailable unknown unsupported upstream user valid vertex whitelist found").split(" "));
const reasonLabels = {
  csrf_token_invalid: "CSRF 令牌无效", invalid_csrf_token: "CSRF 令牌无效", ebadcsrftoken: "CSRF 令牌无效",
  access_policy_denied: "访问策略拒绝", session_expired: "登录会话过期", insufficient_scope: "授权范围不足",
  plugin_startup_failed: "配套插件初始化失败", vertex_configuration_failed: "Vertex 连接设置有误",
};
export function diagnosticReasonCode(value) {
  if (typeof value !== "string" || !/^[a-z][a-z_-]{0,63}$/i.test(value)) return;
  const key = value.toLowerCase().replaceAll("-", "_");
  if (Object.hasOwn(reasonLabels, key) || Object.hasOwn(configMessages, key) || key.split("_").every(word => reasonWords.has(word))) return key;
}
export function httpRejection(status, headers, data, note) {
  const error = data?.error;
  const info = Array.isArray(error?.details) ? error.details.find(d => d?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo") : error?.details;
  const auth = headers.get("www-authenticate") ?? "";
  const challenge = /^(Basic|Bearer|Digest|Negotiate)(?:\s|$)/i.exec(auth);
  const fields = [error?.code, error?.status, error?.reason, data?.code, data?.status, data?.reason, info?.reason,
    typeof error === "string" && /^[\w-]+$/.test(error) ? error : undefined];
  if (challenge?.[1].toLowerCase() === "bearer") {
    const params = auth.slice(challenge[0].length).matchAll(/(?:^|,)\s*([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/g);
    for (const [, name, quoted, token] of params) if (name.toLowerCase() === "error") fields.push(quoted ?? token);
  }
  if (typeof data === "string" && /^[a-z][a-z_-]{0,63}$/i.test(data.trim())) fields.push(data.trim());
  const reasons = new Set();
  let unknown = false;
  for (const value of fields) {
    if (typeof value !== "string" || !value) continue;
    const key = diagnosticReasonCode(value);
    if (!key) { unknown = true; continue; }
    const setting = configurationProblem(key);
    if (setting) reasons.add(setting);
    else reasons.add(Object.hasOwn(reasonLabels, key) ? reasonLabels[key] + "（" + value + "）" : value);
  }
  const message = typeof data === "string" ? data : error?.message ?? data?.message ?? error;
  if (typeof message === "string" && status === 403) {
    if (/Invalid CSRF token\. Please refresh the page and try again\./i.test(message)) reasons.add("酒馆提示 CSRF 令牌无效");
    if (/add your IP address to the\s+whitelist or disable whitelist mode/i.test(message)) reasons.add("酒馆 IP 白名单拒绝");
    if (/Access from this host is not allowed\. This attempt has been logged\./i.test(message)) reasons.add("酒馆主机名白名单拒绝");
  }
  if (challenge) reasons.add("认证方式 " + challenge[1]);
  if (unknown) reasons.add("原因码未识别");
  if (note) reasons.add(note);
  return [...reasons].join("、") || "具体原因=N/A";
}
const pluginUrl = new URL("../../", import.meta.url).href;
export function pluginFrames(error) {
  return String(error?.stack ?? "").split("\n").filter(line => (/^\s*at |@(?:https?|file):/.test(line)) && line.includes(pluginUrl))
    .map(line => line.split(pluginUrl).at(-1).match(/^((?:src|integrations\/sillytavern)\/[\w-]+\.(?:mjs|js))(?::|[?#][^ ]*?:)(\d+:\d+)\)?$/))
    .filter(Boolean).slice(0, 4).map(match => match[1] + ":" + match[2]);
}
export function deviceEnvironment(ua) {
  const browser = ua.match(/(?:EdgA?|Firefox|FxiOS|CriOS)\/[\d.]+/)?.[0] ??
    ua.match(/Chrome\/[\d.]+/)?.[0] ?? ua.match(/Version\/[\d.]+(?=.*Safari)/)?.[0]?.replace("Version", "Safari");
  const os = ua.match(/(?:Android |Windows NT |(?:iPhone |CPU )OS |Mac OS X )[\d._]+|Linux/)?.[0]?.replaceAll("_", ".");
  return { os, browser };
}

export function clientHeader({ env, encoding, selectedFormat }) {
  return [env.extension, env.build, env.tavern, env.revision, encoding, ...(selectedFormat ? [selectedFormat] : [])].join(" ");
}

export function readClientHeader(headers = {}) {
  const raw = headers[CLIENT_HEADER];
  if (typeof raw !== "string" || raw.length > 170) return;
  const [extension, build, tavern, revision, encoding, selectedFormat] = raw.split(" ");
  return { host: "SillyTavern", extension: safeVersion(extension), build: /^[a-f0-9]{8}$/.test(build) ? build : undefined,
    tavern: safeVersion(tavern), revision: /^[a-f0-9]{6,40}$/.test(revision) ? revision : undefined,
    encoding: /^(?:off|unicode|all|recent|(?:unicode|alternate|gbk|table|optimized)(?:_(?:all|recent|chat|except_preset))?)$/.test(encoding) ? encoding : undefined,
    ...(["alternate", "gbk", "table"].includes(selectedFormat) ? { selectedFormat } : {}),
    ...deviceEnvironment(headers["user-agent"] ?? "") };
}
export const systemCodes = {
  ENOTFOUND: "域名解析失败", EAI_AGAIN: "DNS 暂时无法解析", ECONNREFUSED: "连接被拒绝", ECONNRESET: "连接被重置",
  EHOSTUNREACH: "主机不可达", ENETUNREACH: "网络不可达", ETIMEDOUT: "连接超时", EPIPE: "连接写入中断",
  EPROTO: "TLS 协议错误", CERT_HAS_EXPIRED: "TLS 证书过期", ERR_TLS_CERT_ALTNAME_INVALID: "TLS 证书域名不匹配",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "TLS 证书验证失败", SELF_SIGNED_CERT_IN_CHAIN: "TLS 证书链不受信任",
  DEPTH_ZERO_SELF_SIGNED_CERT: "TLS 自签名证书不受信任", ERR_STREAM_PREMATURE_CLOSE: "响应流提前关闭",
  UND_ERR_SOCKET: "网络连接中断", UND_ERR_CONNECT_TIMEOUT: "建立连接超时", UND_ERR_HEADERS_TIMEOUT: "等待响应头超时",
  UND_ERR_BODY_TIMEOUT: "读取响应正文超时", TimeoutError: "等待超时",
};

export function networkCodes(error) {
  const codes = new Set();
  for (let cause = error; cause; cause = cause.cause) {
    for (const item of [cause, ...(cause instanceof AggregateError ? cause.errors : [])]) {
      if (Object.hasOwn(systemCodes, item?.code)) codes.add(item.code);
      else if (item?.name === "TimeoutError") codes.add("TimeoutError");
      else {
        // Some proxy adapters retain the syscall and errno only in the cause text.
        const code = /^(?:connect|read|write|getaddrinfo) ([A-Z_]+)\b/.exec(item?.message)?.[1];
        if (Object.hasOwn(systemCodes, code)) codes.add(code);
      }
    }
  }
  return [...codes];
}

export function requestFields(body = {}) {
  return {
    operation: ["normal", "regenerate", "swipe", "continue", "quiet", "impersonate", "group_chat"].includes(body.type) ? body.type : "generate",
    model: safeModel(body.model), stream: body.stream === true,
    authentication: body.vertexai_auth_mode === "full" ? "service-account" : "express",
    tier: ["flex", "priority"].includes(body.vertexai_service_tier) ? body.vertexai_service_tier : "standard",
    messages: Array.isArray(body.messages) ? body.messages.length : undefined,
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
    requestedTokens: Number.isSafeInteger(body.max_tokens) ? body.max_tokens : undefined,
  };
}
