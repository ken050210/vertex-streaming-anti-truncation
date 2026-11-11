// SillyTavern's declaration for a preset that sends its reply through game_content.
export const presetTextTool = {
  type: "function",
  function: {
    name: "game_content",
    description: "Deliver the preset's complete reply.",
    parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
  },
};
