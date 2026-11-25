// Every stored field is selected here or at its owning boundary. A provider
// message may quote the prompt; it belongs only in the optional on-screen preview.
export const DIAGNOSTIC_HEADER = "x-vertex-diagnostic-id";
export const CLIENT_HEADER = "x-vertex-diagnostic-client";
export const HISTORY_LIMIT = 20;
export const safeCode = value => typeof value === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : undefined;
export const safeModel = value => typeof value === "string" && /^gemini-[a-z0-9][a-z0-9.-]{0,63}$/.test(value) ? value : undefined;
export const safeVersion = value => typeof value === "string" && /^\d[\w.+-]{0,39}$/.test(value) ? value : undefined;
export function deviceEnvironment(ua) {
  const browser = ua.match(/(?:EdgA?|Firefox|FxiOS|CriOS)\/[\d.]+/)?.[0] ??
    ua.match(/Chrome\/[\d.]+/)?.[0] ?? ua.match(/Version\/[\d.]+(?=.*Safari)/)?.[0]?.replace("Version", "Safari");
  const os = ua.match(/(?:Android |Windows NT |(?:iPhone |CPU )OS |Mac OS X )[\d._]+|Linux/)?.[0]?.replaceAll("_", ".");
  return { os, browser };
}

export function clientHeader({ env, encoding }) {
  return [env.extension, env.build, env.tavern, env.revision, encoding].join(" ");
}

export function readClientHeader(headers = {}) {
  const raw = headers[CLIENT_HEADER];
  if (typeof raw !== "string" || raw.length > 170) return;
  const [extension, build, tavern, revision, encoding] = raw.split(" ");
  return { host: "SillyTavern", extension: safeVersion(extension), build: /^[a-f0-9]{8}$/.test(build) ? build : undefined,
    tavern: safeVersion(tavern), revision: /^[a-f0-9]{6,40}$/.test(revision) ? revision : undefined,
    encoding: /^(?:off|unicode|all|recent|(?:alternate|gbk|table|optimized)(?:_(?:all|recent))?)$/.test(encoding) ? encoding : undefined,
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
