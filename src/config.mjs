import { readFile } from "node:fs/promises";
import { createPrivateKey } from "node:crypto";
import { parseServiceAccount, vertexAccessToken } from "./vertex-auth.mjs";
import { modelProfiles, MODEL_ID, UPSTREAM_MODEL } from "./model-profiles.mjs";
import { MAX_RETRY_TEXT_BYTES } from "./gemini-compat.mjs";

export { MODEL_ID, UPSTREAM_MODEL };
export const DEFAULT_SETTINGS = Object.freeze({
  projectId: "", location: "global", authMode: "service-account", serviceTier: "standard",
  port: 4781, timeoutMs: 600000, antiTruncation: true, models: null,
  hideUnavailableModels: true, geminiPrefillToUser: true, geminiLongDecode: false, unicodeInput: false, imageInput: "off",
  geminiPromptRetryEnabled: false, geminiPromptRetryText: "", geminiPromptRetryMatches: null, customBaseUrl: "",
  gatewayKeyMode: "strict", gatewayKey: "", serviceAccountJson: "", apiKey: "", accessToken: "", customApiKey: "",
  accountRotationEnabled: false, accountTimeoutMs: 60000, accountFailureThreshold: 2, accountCooldownMs: 60000, accounts: [],
});
export const SECRET_FIELDS = ["gatewayKey", "serviceAccountJson", "apiKey", "accessToken", "customApiKey"];
export const ACCOUNT_FIELDS = ["id", "name", "authMode", "projectId", "location", "customBaseUrl", "credential"];
export const ACCOUNT_CREDENTIALS = { "service-account": "serviceAccountJson", express: "apiKey", "access-token": "accessToken", custom: "customApiKey" };

function accountConnections(s, requireAscii) {
  if (!Array.isArray(s.accounts) || s.accounts.length > 19) throw new Error("Accounts must be a list of at most 19 additional accounts");
  const ids = new Set(["primary"]);
  return s.accounts.map(account => {
    if (!account || typeof account !== "object" || Object.keys(account).some(key => !ACCOUNT_FIELDS.includes(key)) ||
        typeof account.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(account.id) || ids.has(account.id)) throw new Error("Invalid or duplicate account ID");
    ids.add(account.id);
    if (typeof account.name !== "string" || !account.name.trim() || account.name.length > 80) throw new Error("Account name must contain 1-80 characters");
    if (!Object.hasOwn(ACCOUNT_CREDENTIALS, account.authMode)) throw new Error("Invalid account authentication mode");
    // Keep custom model aliases and Vertex models in separate pools; Vertex auth modes can mix.
    if ((account.authMode === "custom") !== (s.authMode === "custom")) throw new Error("Accounts must all use Vertex or all use custom upstreams");
    if (typeof account.credential !== "string" || account.credential.length > 128 * 1024) throw new Error("Invalid account credential");
    return { id: account.id, name: account.name, ...buildConnectionConfig({
      authMode: account.authMode, projectId: account.projectId ?? "", location: account.location ?? "global",
      customBaseUrl: account.customBaseUrl ?? "", serviceTier: s.serviceTier,
      [ACCOUNT_CREDENTIALS[account.authMode]]: account.credential,
    }, { requireAscii }) };
  });
}

function integer(value, fallback, min, max, name) {
  const number = value == null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Invalid ${name}`);
  return number;
}

// HTTP header values are byte strings, so a key with smart quotes or full-width characters could be
// saved but never sent. Settings saved before this rule load with requireAscii: false, so the console
// still opens and reports the problem when the gateway starts.
const visibleAscii = value => /^[\x21-\x7e]+$/.test(value);

export async function settingsFromEnv(env = process.env) {
  const file = env.GOOGLE_APPLICATION_CREDENTIALS;
  if ([file, env.VERTEX_ACCESS_TOKEN, env.VERTEX_API_KEY, env.CUSTOM_UPSTREAM_URL].filter(Boolean).length > 1) throw new Error("Configure exactly one upstream authentication method: GOOGLE_APPLICATION_CREDENTIALS, VERTEX_ACCESS_TOKEN, VERTEX_API_KEY or CUSTOM_UPSTREAM_URL");
  let serviceAccountJson = "";
  if (file) {
    try { serviceAccountJson = (await readFile(file, "utf8")).replace(/^\uFEFF/, ""); }
    catch { throw new Error("Unable to read the Google service-account file (GOOGLE_APPLICATION_CREDENTIALS)"); }
  }
  let geminiPromptRetryText = "";
  let accounts = [];
  if (env.GATEWAY_ACCOUNTS_FILE) {
    try { accounts = JSON.parse((await readFile(env.GATEWAY_ACCOUNTS_FILE, "utf8")).replace(/^\uFEFF/, "")); }
    catch { throw new Error("Unable to read account JSON (GATEWAY_ACCOUNTS_FILE)"); }
  }
  if (env.GEMINI_PROMPT_RETRY_TEXT_FILE) {
    try { geminiPromptRetryText = (await readFile(env.GEMINI_PROMPT_RETRY_TEXT_FILE, "utf8")).replace(/^\uFEFF/, ""); }
    catch { throw new Error("Unable to read the prompt retry text file (GEMINI_PROMPT_RETRY_TEXT_FILE)"); }
  }
  const toggle = (name, fallback) => {
    if (env[name] == null || env[name] === "") return fallback;
    if (!["true", "false"].includes(env[name])) throw new Error("Invalid " + name);
    return env[name] === "true";
  };
  // "|"-separated rules; empty keeps the single default rule.
  const retryMatches = (env.GEMINI_PROMPT_RETRY_MATCHES || "").split("|").map(text => text.trim()).filter(Boolean);
  return {
    ...DEFAULT_SETTINGS, projectId: env.VERTEX_PROJECT_ID || "", location: env.VERTEX_LOCATION || "global",
    gatewayKeyMode: env.GATEWAY_KEY_MODE || "strict",
    gatewayKey: env.GATEWAY_KEY_MODE === "none" ? "" : env.GATEWAY_API_KEY || "", serviceAccountJson,
    accessToken: env.VERTEX_ACCESS_TOKEN || "", apiKey: env.VERTEX_API_KEY || "",
    customBaseUrl: env.CUSTOM_UPSTREAM_URL || "", customApiKey: env.CUSTOM_UPSTREAM_API_KEY || "",
    authMode: env.CUSTOM_UPSTREAM_URL ? "custom" : env.VERTEX_API_KEY ? "express" : env.VERTEX_ACCESS_TOKEN ? "access-token" : "service-account",
    serviceTier: env.VERTEX_SERVICE_TIER || "standard",
    port: integer(env.PORT, 4781, 1, 65535, "PORT"),
    timeoutMs: integer(env.UPSTREAM_TIMEOUT_MS, 600000, 1000, 1800000, "UPSTREAM_TIMEOUT_MS"),
    antiTruncation: env.ANTI_TRUNCATION !== "false",
    unicodeInput: toggle("UNICODE_INPUT", false), imageInput: env.IMAGE_INPUT || "off",
    hideUnavailableModels: toggle("HIDE_UNAVAILABLE_MODELS", true),
    geminiPrefillToUser: toggle("GEMINI_PREFILL_TO_USER", true), geminiLongDecode: toggle("GEMINI_LONG_DECODE", false),
    geminiPromptRetryEnabled: toggle("GEMINI_PROMPT_RETRY_ENABLED", false), geminiPromptRetryText,
    geminiPromptRetryMatches: retryMatches.length ? retryMatches : null,
    accounts, accountRotationEnabled: toggle("ACCOUNT_ROTATION_ENABLED", false),
    accountTimeoutMs: integer(env.ACCOUNT_TIMEOUT_MS, 60000, 1000, 1800000, "ACCOUNT_TIMEOUT_MS"),
    accountFailureThreshold: integer(env.ACCOUNT_FAILURE_THRESHOLD, 2, 1, 100, "ACCOUNT_FAILURE_THRESHOLD"),
    accountCooldownMs: integer(env.ACCOUNT_COOLDOWN_MS, 60000, 1000, 3600000, "ACCOUNT_COOLDOWN_MS"),
  };
}

// An OpenAI-compatible service that serves Gemini models. It has no Vertex project, region,
// service tier or native endpoint, so every request keeps the compatible format.
function customConnection(s, requireAscii) {
  const raw = s.customBaseUrl;
  let url;
  try { url = new URL(raw); } catch { throw new Error("Invalid CUSTOM_UPSTREAM_URL"); }
  if (typeof raw !== "string" || raw.length > 2048 || /[?#]/.test(raw) || !["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Invalid CUSTOM_UPSTREAM_URL");
  }
  const key = s.customApiKey;
  if (typeof key !== "string" || !key || /\s/.test(key) || key.length > 8192) throw new Error("Invalid CUSTOM_UPSTREAM_API_KEY");
  if (requireAscii && !visibleAscii(key)) throw new Error("CUSTOM_UPSTREAM_API_KEY must contain only visible ASCII characters");
  // A pasted endpoint works as well as its base: requests go to <base>/chat/completions.
  const baseUrl = url.href.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  return { accessToken: async () => key, authMode: "custom", serviceTier: "standard", projectId: "", location: "", baseUrl, tierHeaders: {}, nativeOnly: false };
}

export function buildConnectionConfig(settings, { requireAscii = true } = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  if (!["service-account", "express", "access-token", "custom"].includes(s.authMode)) throw new Error("Invalid authentication mode");
  if (s.authMode === "custom") return customConnection(s, requireAscii);
  if (!["standard", "flex", "priority"].includes(s.serviceTier)) throw new Error("Invalid service tier");
  if (typeof s.projectId !== "string" || (s.projectId && !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(s.projectId))) throw new Error("Invalid VERTEX_PROJECT_ID");
  if (s.authMode !== "express" && !s.projectId) throw new Error("Invalid VERTEX_PROJECT_ID");
  if (typeof s.location !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(s.location)) throw new Error("Invalid VERTEX_LOCATION");
  if ((s.serviceTier !== "standard" || s.authMode === "express") && s.location !== "global") throw new Error("Express, Flex and Priority require the global location");
  let accessToken;
  if (s.authMode === "service-account") {
    const account = parseServiceAccount(s.serviceAccountJson);
    try {
      if (createPrivateKey(account.private_key).asymmetricKeyType !== "rsa") throw new Error();
    } catch { throw new Error("Service account must contain a valid RSA private key"); }
    accessToken = () => vertexAccessToken(s.serviceAccountJson);
  } else {
    const [name, value] = s.authMode === "express" ? ["VERTEX_API_KEY", s.apiKey] : ["VERTEX_ACCESS_TOKEN", s.accessToken];
    if (typeof value !== "string" || !value || /\s/.test(value) || value.length > 8192) throw new Error("Invalid " + name);
    if (requireAscii && !visibleAscii(value)) throw new Error(name + " must contain only visible ASCII characters");
    accessToken = async () => value;
  }
  const host = s.location === "global" ? "aiplatform.googleapis.com" : `${s.location}-aiplatform.googleapis.com`;
  // The projectless Express endpoint does not explicitly select locations/global.
  // Honor a supplied project so global-only models can use the scoped native endpoint.
  const baseUrl = s.authMode === "express" ? `https://aiplatform.googleapis.com/v1${s.projectId ? `/projects/${s.projectId}/locations/${s.location}` : ""}`
    : `https://${host}/v1/projects/${s.projectId}/locations/${s.location}/endpoints/openapi`;
  const tierHeaders = s.serviceTier === "standard" ? {} : {
    "x-vertex-ai-llm-shared-request-type": s.serviceTier,
    "x-vertex-ai-llm-request-type": "shared",
  };
  return {
    accessToken, authMode: s.authMode, serviceTier: s.serviceTier,
    projectId: s.projectId, location: s.location, baseUrl, tierHeaders,
    // Priority works on the OpenAI-compatible endpoint (verified 2026-09-25, traffic type
    // ON_DEMAND_PRIORITY); Flex and Express do not, so only they require native requests.
    nativeOnly: s.authMode === "express" || s.serviceTier === "flex",
  };
}

export function buildConfig(settings, { requireAscii = true } = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  if (!["strict", "weak", "none"].includes(s.gatewayKeyMode)) throw new Error("Invalid GATEWAY_KEY_MODE");
  const key = s.gatewayKeyMode === "none" ? "" : s.gatewayKey;
  if (s.gatewayKeyMode === "strict" && (typeof key !== "string" || key.length < 16 || key.length > 512 || /\s/.test(key) || /^(change|replace|your)[-_ ]?me/i.test(key))) {
    throw new Error("Set GATEWAY_API_KEY to a random value of at least 16 characters");
  }
  if (s.gatewayKeyMode === "weak" && (typeof key !== "string" || !key || key.length > 512 || /\s/.test(key))) {
    throw new Error("Set GATEWAY_API_KEY to 1-512 visible ASCII characters without spaces");
  }
  if (s.gatewayKeyMode !== "none" && requireAscii && !visibleAscii(key)) throw new Error("GATEWAY_API_KEY must contain only visible ASCII characters");
  if (!["off", "current-turn", "all"].includes(s.imageInput)) throw new Error("Invalid image input mode");
  if (s.unicodeInput && s.imageInput !== "off") throw new Error("Unicode and image input are mutually exclusive");
  if (typeof s.antiTruncation !== "boolean") throw new Error("Invalid anti-truncation setting");
  for (const name of ["hideUnavailableModels", "geminiPrefillToUser", "geminiLongDecode", "geminiPromptRetryEnabled", "unicodeInput", "accountRotationEnabled"]) {
    if (typeof s[name] !== "boolean") throw new Error("Invalid compatibility toggle");
  }
  if (typeof s.geminiPromptRetryText !== "string" || Buffer.byteLength(s.geminiPromptRetryText) > MAX_RETRY_TEXT_BYTES) {
    throw new Error("Prompt retry text must be at most 192000 UTF-8 bytes");
  }
  if (s.geminiPromptRetryEnabled && !s.geminiPromptRetryText.trim()) throw new Error("Enter custom text before enabling prompt retry");
  const matches = s.geminiPromptRetryMatches;
  if (matches != null && (!Array.isArray(matches) || !matches.length || matches.length > 32 ||
      matches.some(text => typeof text !== "string" || !text.trim() || text.length > 500))) {
    throw new Error("Prompt retry error matches must list 1-32 texts of at most 500 characters");
  }
  const models = modelProfiles(s.models, s.antiTruncation, { custom: s.authMode === "custom" });
  const accounts = accountConnections(s, requireAscii);
  if (s.accountRotationEnabled && !accounts.length) throw new Error("Add at least one additional account before enabling rotation");
  return {
    ...buildConnectionConfig(s, { requireAscii }), gatewayKeyMode: s.gatewayKeyMode, gatewayKey: key, models,
    accountRotation: { enabled: s.accountRotationEnabled, accounts,
      timeoutMs: integer(s.accountTimeoutMs, 60000, 1000, 1800000, "ACCOUNT_TIMEOUT_MS"),
      failureThreshold: integer(s.accountFailureThreshold, 2, 1, 100, "ACCOUNT_FAILURE_THRESHOLD"),
      cooldownMs: integer(s.accountCooldownMs, 60000, 1000, 3600000, "ACCOUNT_COOLDOWN_MS") },
    hideUnavailableModels: s.hideUnavailableModels, geminiPrefillToUser: s.geminiPrefillToUser, geminiLongDecode: s.geminiLongDecode, unicodeInput: s.unicodeInput, imageInput: s.imageInput,
    geminiPromptRetry: { enabled: s.geminiPromptRetryEnabled, text: s.geminiPromptRetryText, ...(matches ? { errorMatches: matches } : {}) },
    // Legacy fields remain available to CLI integrations; profiles own behavior.
    model: models[0]?.id || MODEL_ID, upstreamModel: models[0]?.upstreamModel || UPSTREAM_MODEL,
    antiTruncation: s.models == null ? s.antiTruncation : true,
    port: integer(s.port, 4781, 1, 65535, "PORT"),
    timeoutMs: integer(s.timeoutMs, 600000, 1000, 1800000, "UPSTREAM_TIMEOUT_MS"),
    bodyLimitBytes: 8 * 1024 * 1024,
  };
}

export async function loadConfig(env = process.env) {
  // The GUI can start without credentials; the CLI cannot, and an empty service-account JSON would hide why.
  if (![env.GOOGLE_APPLICATION_CREDENTIALS, env.VERTEX_ACCESS_TOKEN, env.VERTEX_API_KEY, env.CUSTOM_UPSTREAM_URL].some(Boolean)) {
    throw new Error("Configure one upstream authentication method: GOOGLE_APPLICATION_CREDENTIALS, VERTEX_ACCESS_TOKEN, VERTEX_API_KEY or CUSTOM_UPSTREAM_URL");
  }
  return buildConfig(await settingsFromEnv(env));
}

export function publicSettings(settings) {
  const result = { ...settings, models: modelProfiles(settings.models, settings.antiTruncation, { custom: settings.authMode === "custom" }) };
  for (const name of SECRET_FIELDS) { delete result[name]; result[name + "Set"] = Boolean(settings[name]); }
  result.accounts = (settings.accounts || []).map(({ credential, ...account }) => ({ ...account, credentialSet: Boolean(credential) }));
  return result;
}
