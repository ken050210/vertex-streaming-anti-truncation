// Standard text model endpoints from Google's Deployments and endpoints table, 2026-11-22.
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations
// An unlisted model may be newer than the table. Its configured locations go to Google as given.
const multi = ["global", "us", "eu"];
const usRegions = ["us-west1", "us-west4", "us-central1", "us-east1", "us-east4", "us-east5", "us-south1"];
const euRegions = ["europe-west1", "europe-west4", "europe-north1", "europe-central2", "europe-west8", "europe-west9"];
const byModel = {
  "gemini-4-neon": multi, "gemini-4-carbon": multi, "gemini-4-hydrogen": multi,
  "gemini-4-argon": [...multi, "europe-west2", "asia-southeast1"],
  "gemini-3.8-flash": [...multi, "northamerica-northeast1", "asia-northeast1"],
  "gemini-3.7-flash": multi, "gemini-3.6-flash": multi,
  "gemini-3.5-flash-lite": [...multi, "asia-south1"], "gemini-3.1-flash-lite": multi,
  "gemini-3.5-flash": [...multi, "northamerica-northeast1", "europe-west2", "europe-west3",
    "asia-south1", "asia-southeast1", "asia-northeast1", "australia-southeast1"],
  "gemini-3.1-pro-preview": ["global"], "gemini-3-flash-preview": ["global"],
  "gemini-2.5-pro": ["global", ...usRegions, ...euRegions, "europe-southwest1", "northamerica-northeast1", "asia-northeast1"],
  "gemini-2.5-flash-lite": ["global", ...usRegions, ...euRegions, "europe-southwest1"],
  "gemini-2.5-flash": ["global", ...usRegions, ...euRegions, "europe-southwest1", "northamerica-northeast1",
    "southamerica-east1", "europe-west2", "europe-west3", "asia-south1", "asia-southeast1", "asia-northeast1", "australia-southeast1", "asia-northeast3"],
};
export function supportedVertexLocations(model) {
  const id = model.replace(/^(?:google\/|publishers\/google\/models\/)/, "").split("@")[0];
  return Object.hasOwn(byModel, id) ? byModel[id] : undefined;
}

export const isMultiRegion = location => location === "us" || location === "eu";
export const validVertexLocation = location => typeof location === "string" && location.length <= 63 &&
  (location === "global" || isMultiRegion(location) || /^[a-z]+(?:-[a-z]+)+\d+$/.test(location));

export function vertexHost(location) {
  if (location === "global") return "aiplatform.googleapis.com";
  if (isMultiRegion(location)) return `aiplatform.${location}.rep.googleapis.com`;
  return `${location}-aiplatform.googleapis.com`;
}

// Older Carbon/Neon connections selected a city for other models and implicitly used global for these two.
export function legacyVertexLocation(location, model) {
  return /^(?:google\/|publishers\/google\/models\/)?gemini-4-(?:carbon|neon)(?:@|$)/i.test(model) && !isMultiRegion(location) ? "global" : location;
}

export function requestLocations(config, model) {
  if (config.authMode === "custom") return [config.location];
  if (!config.regionFallbackEnabled) return [legacyVertexLocation(config.location, model)];
  const allowed = supportedVertexLocations(model);
  if (allowed && !allowed.includes(config.location)) {
    throw Object.assign(new Error(`${model} supports ${allowed.join(", ")}. Select a supported primary location.`),
      { status: 400, code: "unsupported_primary_location" });
  }
  return [config.location, ...config.fallbackLocations.filter(location => location !== config.location && (!allowed || allowed.includes(location)))];
}
