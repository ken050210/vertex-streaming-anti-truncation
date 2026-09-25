// Fields Google documents as unsupported for Gemini on Vertex (model pages and developer
// guides updated 2026-09-24, checked 2026-09-25). They are removed before sending.
const PENALTIES = ["frequency_penalty", "presence_penalty"];
const SAMPLING = ["temperature", "top_p", "top_k"];
const DOCUMENTED = new Map(Object.entries({
  // Guides: "Remove the following unsupported parameters: frequency_penalty, presence_penalty,
  // candidate_count, temperature, top_p, and top_k." candidate_count is OpenAI's `n`.
  "gemini-3.8-flash": [...PENALTIES, ...SAMPLING, "n"],
  "gemini-3.7-flash": [...PENALTIES, ...SAMPLING, "n"],
  // Model pages: custom temperature, top-K, top-P and penalty values "aren't supported".
  "gemini-3.6-flash": [...PENALTIES, ...SAMPLING],
  "gemini-3.5-flash-lite": [...PENALTIES, ...SAMPLING],
  // Guide: penalties throw runtime errors. Model page: topK 64 (fixed); temperature and
  // topP keep documented ranges, so they are only "no longer recommended" and stay.
  "gemini-3.5-flash": [...PENALTIES, "top_k"],
  // Model pages: topK 64 (fixed), temperature/topP/candidateCount have ranges.
  "gemini-3.1-flash-lite": ["top_k"],
  "gemini-3.1-pro-preview": ["top_k"],
  "gemini-3-flash-preview": ["top_k"],
  "gemini-2.5-pro": ["top_k"],
}));

export function documentedUnsupported(upstreamModel, payload = {}) {
  const keys = new Set(DOCUMENTED.get(upstreamModel.replace(/^google\//, "").replace(/@[a-z0-9-]+$/, "")));
  // The compatible API: "only one of reasoning_effort or extra_body.google.thinking_config
  // may be specified". Keep the explicit Gemini configuration.
  if (payload.reasoning_effort != null && payload.extra_body?.google?.thinking_config != null) keys.add("reasoning_effort");
  return keys;
}

export function dropParams(payload, keys) {
  if (!keys?.size || !Object.keys(payload).some(key => keys.has(key))) return payload;
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !keys.has(key)));
}
