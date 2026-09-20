import { createSign } from "node:crypto";

const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const TOKEN_LIFETIME_SECONDS = 3600;
const tokenCache = new Map();

export function parseServiceAccount(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("vertex service account secret is not valid JSON");
  }
  if (
    parsed?.type !== "service_account" ||
    typeof parsed.client_email !== "string" ||
    typeof parsed.private_key !== "string" ||
    typeof parsed.token_uri !== "string" ||
    !parsed.token_uri.startsWith("https://")
  ) {
    throw new Error("vertex service account secret must contain type, client_email, private_key and an HTTPS token_uri");
  }
  if (parsed.token_uri !== "https://oauth2.googleapis.com/token") throw new Error("Only Google's OAuth token endpoint is allowed");
  return parsed;
}

function signedAssertion(serviceAccount, nowMs) {
  const encode = (part) => Buffer.from(JSON.stringify(part)).toString("base64url");
  const issuedAt = Math.floor(nowMs / 1000);
  const unsigned =
    encode({ alg: "RS256", typ: "JWT" }) +
    "." +
    encode({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: serviceAccount.token_uri,
      iat: issuedAt,
      exp: issuedAt + TOKEN_LIFETIME_SECONDS,
    });
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  return unsigned + "." + signer.sign(serviceAccount.private_key, "base64url");
}

async function mintToken(serviceAccountJson, timeoutMs) {
  const serviceAccount = parseServiceAccount(serviceAccountJson);
  const response = await fetch(serviceAccount.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signedAssertion(serviceAccount, Date.now()),
    }),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    // Status alone is reported below; the body is never echoed into logs.
  }
  if (!response.ok) {
    throw new Error(`vertex token exchange failed with HTTP ${response.status}`);
  }
  if (typeof parsed?.access_token !== "string" || !parsed.access_token) {
    throw new Error("vertex token exchange returned no access_token");
  }
  const lifetimeSeconds = Number(parsed.expires_in) > 0 ? Number(parsed.expires_in) : TOKEN_LIFETIME_SECONDS;
  return { token: parsed.access_token, expiresAt: Date.now() + lifetimeSeconds * 1000 };
}

export function vertexAccessToken(serviceAccountJson, timeoutMs = 10_000) {
  const cached = tokenCache.get(serviceAccountJson);
  if (cached?.token && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return Promise.resolve(cached.token);
  }
  if (cached?.pending) return cached.pending;
  const entry = {
    pending: mintToken(serviceAccountJson, timeoutMs)
      .then((minted) => {
        tokenCache.set(serviceAccountJson, minted);
        return minted.token;
      })
      .catch((error) => {
        tokenCache.delete(serviceAccountJson);
        throw error;
      }),
  };
  tokenCache.set(serviceAccountJson, entry);
  return entry.pending;
}

export function clearVertexTokenCache() {
  tokenCache.clear();
}
