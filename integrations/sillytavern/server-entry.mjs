import { readFile } from "node:fs/promises";

export const info = { id: "vertex-anti-truncation", name: "Vertex AI Anti-Truncation", description: "Native Vertex text transport using SillyTavern's saved credentials." };

// Tavern only mounts a plugin's router after init returns. Keep this entry free of
// plugin and host imports so a broken installation can still report its startup error.
export async function init(router) {
  let phase = "plugin-module";
  try {
    const server = await import("./server.mjs");
    phase = "register-routes";
    await server.init(router);
  } catch (error) {
    const cause = error.cause ?? error;
    const codes = ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_DLOPEN_FAILED",
      "ERR_REQUIRE_ESM", "ERR_UNKNOWN_FILE_EXTENSION", "ENOENT", "EACCES", "EPERM"];
    const code = codes.includes(cause.code) ? cause.code : cause instanceof SyntaxError ? "SyntaxError" : cause instanceof TypeError ? "TypeError" : "Error";
    const version = await readFile(new URL("../../manifest.json", import.meta.url), "utf8")
      .then(JSON.parse).then(manifest => manifest.version).catch(() => undefined);
    const startup = { phase: error.startupPhase ?? phase, code };
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      const files = [["./server.mjs", "integrations/sillytavern/server.mjs"], ["../../../../src/prompt-converters.js", "src/prompt-converters.js"],
        ["../../../../src/endpoints/secrets.js", "src/endpoints/secrets.js"], ["../../../../src/constants.js", "src/constants.js"]];
      startup.file = files.find(([path]) => new URL(path, import.meta.url).href === cause.url)?.[1];
    }
    const reply = (request, response) => {
      response.setHeader("cache-control", "no-store");
      if (!request.user?.directories) return response.sendStatus(401);
      return response.status(503).json({ id: info.id, version, ready: false, startup, error: { code: "plugin_startup_failed" },
        environment: { node: process.versions.node, os: process.platform, arch: process.arch } });
    };
    router.get("/status", reply);
    router.get("/diagnostics", reply);
    router.post("/generate", reply);
    router.post("/image-input", reply);
  }
}
