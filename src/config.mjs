import { readFile } from "node:fs/promises";
import { createPrivateKey } from "node:crypto";
import { parseServiceAccount, vertexAccessToken } from "./vertex-auth.mjs";
import { modelProfiles, MODEL_ID, UPSTREAM_MODEL } from "./model-profiles.mjs";

export { MODEL_ID, UPSTREAM_MODEL };
export const DEFAULT_SETTINGS = Object.freeze({
  projectId: "", location: "global", authMode: "service-account", serviceTier: "standard",
  port: 4781, timeoutMs: 600000, antiTruncation: true, models: null,
  gatewayKey: "", serviceAccountJson: "", apiKey: "", accessToken: "",
});
export const SECRET_FIELDS = ["gatewayKey", "serviceAccountJson", "apiKey", "accessToken"];

function integer(value, fallback, min, max, name) {
  const number = value == null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Invalid ${name}`);
  return number;
}

export async function settingsFromEnv(env = process.env) {
  const file = env.GOOGLE_APPLICATION_CREDENTIALS;
  if ([file, env.VERTEX_ACCESS_TOKEN, env.VERTEX_API_KEY].filter(Boolean).length > 1) throw new Error("Configure exactly one Google authentication method");
  let serviceAccountJson = "";
  if (file) {
    try { serviceAccountJson = (await readFile(file, "utf8")).replace(/^\uFEFF/, ""); }
    catch { throw new Error("Unable to read the Google service-account file"); }
  }
  return {
    ...DEFAULT_SETTINGS, projectId: env.VERTEX_PROJECT_ID || "", location: env.VERTEX_LOCATION || "global",
    gatewayKey: env.GATEWAY_API_KEY || "", serviceAccountJson,
    accessToken: env.VERTEX_ACCESS_TOKEN || "", apiKey: env.VERTEX_API_KEY || "",
    authMode: env.VERTEX_API_KEY ? "express" : env.VERTEX_ACCESS_TOKEN ? "access-token" : "service-account",
    serviceTier: env.VERTEX_SERVICE_TIER || "standard",
    port: integer(env.PORT, 4781, 1, 65535, "PORT"),
    timeoutMs: integer(env.UPSTREAM_TIMEOUT_MS, 600000, 1000, 1800000, "UPSTREAM_TIMEOUT_MS"),
    antiTruncation: env.ANTI_TRUNCATION !== "false",
  };
}

export function buildConnectionConfig(settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  if (!["service-account", "express", "access-token"].includes(s.authMode)) throw new Error("Invalid authentication mode");
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
    const value = s.authMode === "express" ? s.apiKey : s.accessToken;
    if (typeof value !== "string" || !value || /\s/.test(value) || value.length > 8192) throw new Error(s.authMode === "express" ? "Invalid VERTEX_API_KEY" : "Invalid VERTEX_ACCESS_TOKEN");
    accessToken = async () => value;
  }
  const host = s.location === "global" ? "aiplatform.googleapis.com" : `${s.location}-aiplatform.googleapis.com`;
  const baseUrl = s.authMode === "express" ? "https://aiplatform.googleapis.com/v1"
    : `https://${host}/v1/projects/${s.projectId}/locations/${s.location}/endpoints/openapi`;
  const tierHeaders = s.serviceTier === "standard" ? {} : {
    "x-vertex-ai-llm-shared-request-type": s.serviceTier,
    "x-vertex-ai-llm-request-type": "shared",
  };
  return {
    accessToken, authMode: s.authMode, serviceTier: s.serviceTier,
    projectId: s.projectId, location: s.location, baseUrl, tierHeaders,
    nativeOnly: s.authMode === "express" || s.serviceTier !== "standard",
  };
}

export function buildConfig(settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const key = s.gatewayKey;
  if (typeof key !== "string" || key.length < 16 || key.length > 512 || /\s/.test(key) || /^(change|replace|your)[-_ ]?me/i.test(key)) {
    throw new Error("Set GATEWAY_API_KEY to a random value of at least 16 characters");
  }
  if (typeof s.antiTruncation !== "boolean") throw new Error("Invalid anti-truncation setting");
  const models = modelProfiles(s.models, s.antiTruncation);
  return {
    ...buildConnectionConfig(s), gatewayKey: key, models,
    // Legacy fields remain available to CLI integrations; profiles own behavior.
    model: models[0]?.id || MODEL_ID, upstreamModel: models[0]?.upstreamModel || UPSTREAM_MODEL,
    antiTruncation: s.models == null ? s.antiTruncation : true,
    port: integer(s.port, 4781, 1, 65535, "PORT"),
    timeoutMs: integer(s.timeoutMs, 600000, 1000, 1800000, "UPSTREAM_TIMEOUT_MS"),
    bodyLimitBytes: 8 * 1024 * 1024,
  };
}

export async function loadConfig(env = process.env) {
  return buildConfig(await settingsFromEnv(env));
}

export function publicSettings(settings) {
  const result = { ...settings, models: modelProfiles(settings.models, settings.antiTruncation) };
  for (const name of SECRET_FIELDS) { delete result[name]; result[name + "Set"] = Boolean(settings[name]); }
  return result;
}
