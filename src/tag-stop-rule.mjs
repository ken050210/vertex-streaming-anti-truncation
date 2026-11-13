export const DEFAULT_STOP_TAG = "tucao";
export const DEFAULT_STOP_COUNT = 2;

// Existing profiles and older clients use booleans for immediate cutoff and 250 ms.
export function normalizeStopUsageWait(value) {
  return value === "natural" ? value : value === true;
}

export function validateTagStopRule(rule) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule) ||
      Object.keys(rule).some(key => !["tag", "count", "exemptTag"].includes(key)) ||
      typeof rule.tag !== "string" || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/.test(rule.tag) ||
      !Number.isSafeInteger(rule.count) || rule.count < 1) {
    throw Object.assign(new Error("标签名须为 1–64 位字母、数字、下划线、点、冒号或连字符，以字母或下划线开头；次数须为正整数。"),
      { code: "invalid_tag_stop", status: 400 });
  }
  if (rule.exemptTag !== undefined && (typeof rule.exemptTag !== "string" ||
      (rule.exemptTag !== "" && !/^[A-Za-z_][A-Za-z0-9_.:~-]{0,63}$/.test(rule.exemptTag)) || rule.exemptTag === rule.tag)) {
    throw Object.assign(new Error("豁免标签请填写与截停标签不同的标签名（最多 64 字符，可含 ~，不含尖括号）。"),
      { code: "invalid_tag_stop", status: 400 });
  }
  return rule;
}
