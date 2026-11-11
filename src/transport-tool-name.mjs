export const DEFAULT_TRANSPORT_TOOL_NAME = "router_emit";

// Use names accepted by both native Vertex and OpenAI-compatible transports.
export function validateTransportToolName(name) {
  if (typeof name !== "string" || (name !== "" && !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name))) {
    throw Object.assign(new Error("预设正文工具名须为 1–64 位英文字母、数字、下划线或连字符，并以字母或下划线开头。"), {
      code: "invalid_transport_tool_name", status: 400,
    });
  }
  return name;
}

// A preset tool is consumed as text. Only claim the one declaration the user
// selected, with the argument shape understood by both streaming decoders.
export function transportToolBypassReason({ tools, tool_choice: choice }, targetName = "") {
  if (targetName === "") {
    return choice == null || choice === "auto" || choice === "none" ? null : "tool-choice";
  }
  validateTransportToolName(targetName);
  if (choice === "none") return "target-tool-choice";
  if (choice != null && choice !== "auto" && choice !== "required") {
    if (choice?.type !== "function" || typeof choice.function?.name !== "string") return "tool-choice";
    if (choice.function.name !== targetName) return "target-tool-choice";
  }
  const matches = Array.isArray(tools) ? tools.filter(tool => tool?.function?.name === targetName) : [];
  if (!matches.length) return "target-tool-missing";
  const schema = matches[0].function.parameters;
  if (matches.length !== 1 || matches[0].type !== "function" || schema?.type !== "object" ||
      schema.properties?.content?.type !== "string" || Object.keys(schema.properties).length !== 1 ||
      !Array.isArray(schema.required) || schema.required.length !== 1 || schema.required[0] !== "content") return "target-tool-schema";
  return null;
}
