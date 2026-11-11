export const DEFAULT_TRANSPORT_TOOL_NAME = "router_emit";

// Use names accepted by both native Vertex and OpenAI-compatible transports.
export function validateTransportToolName(name) {
  if (typeof name !== "string" || (name !== "" && !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name))) {
    throw Object.assign(new Error("正文传输工具名须为 1–64 位英文字母、数字、下划线或连字符，并以字母或下划线开头。"), {
      code: "invalid_transport_tool_name", status: 400,
    });
  }
  return name;
}
