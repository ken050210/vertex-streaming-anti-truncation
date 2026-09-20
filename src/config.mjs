import { readFile } from "node:fs/promises";
import { parseServiceAccount, vertexAccessToken } from "./vertex-auth.mjs";

export const MODEL_ID = "gemini-3.7-flash-antitruncation";
export const UPSTREAM_MODEL = "google/gemini-3.7-flash";

function integer(value, fallback, min, max, name) {
  const number = value == null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Invalid ${name}`);
  return number;
}

export async function loadConfig(env = process.env) {
  const gatewayKey = env.GATEWAY_API_KEY;
  if (typeof gatewayKey !== "string" || gatewayKey.length < 16 || /^(change|replace|your)[-_ ]?me/i.test(gatewayKey)) {
    throw new Error("Set GATEWAY_API_KEY to a random value of at least 16 characters");
  }
  const project = env.VERTEX_PROJECT_ID;
  const location = env.VERTEX_LOCATION || "global";
  if (!project || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(project)) throw new Error("Invalid VERTEX_PROJECT_ID");
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(location)) throw new Error("Invalid VERTEX_LOCATION");
  const file = env.GOOGLE_APPLICATION_CREDENTIALS;
  const token = env.VERTEX_ACCESS_TOKEN;
  if (Boolean(file) === Boolean(token)) throw new Error("Configure exactly one of GOOGLE_APPLICATION_CREDENTIALS or VERTEX_ACCESS_TOKEN");
  let accessToken;
  if (file) {
    let raw;
    try { raw = (await readFile(file, "utf8")).replace(/^\uFEFF/, ""); }
    catch { throw new Error("Unable to read the Google service-account file"); }
    const account = parseServiceAccount(raw);
    if (account.token_uri !== "https://oauth2.googleapis.com/token") throw new Error("Only Google's OAuth token endpoint is allowed");
    accessToken = () => vertexAccessToken(raw);
  } else {
    if (/\s/.test(token)) throw new Error("Invalid VERTEX_ACCESS_TOKEN");
    accessToken = async () => token;
  }
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  return {
    gatewayKey, accessToken, model: MODEL_ID, upstreamModel: UPSTREAM_MODEL,
    baseUrl: `https://${host}/v1/projects/${project}/locations/${location}/endpoints/openapi`,
    port: integer(env.PORT, 4781, 1, 65535, "PORT"),
    timeoutMs: integer(env.UPSTREAM_TIMEOUT_MS, 600000, 1000, 1800000, "UPSTREAM_TIMEOUT_MS"),
    bodyLimitBytes: 8 * 1024 * 1024,
  };
}
