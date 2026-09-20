import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ignored = new Set([".git", "node_modules", "runtime", "coverage", "dist"]);
async function walk(dir) {
  const result = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.name === ".env" || entry.name.endsWith(".log")) continue;
    if (entry.isSymbolicLink()) throw new Error("Release must not contain symbolic links");
    const file = path.join(dir, entry.name);
    result.push(...(entry.isDirectory() ? await walk(file) : [file]));
  }
  return result;
}
const files = await walk(root);
const privateKey = new RegExp("-----BEGIN " + "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----");
for (const file of files) {
  const text = await fs.readFile(file, "utf8");
  if (privateKey.test(text) || /(?:ghp_|github_pat_|AIza|sk-proj-)[A-Za-z0-9_-]{20,}/.test(text) ||
      /"(?:private_key|access_token|refresh_token)"\s*:\s*"[^"\n]+"/.test(text) ||
      /[A-Z]:[\\/]Users[\\/][A-Za-z0-9_-]+[\\/]/i.test(text)) {
    throw new Error("Potential credential/private path in " + path.relative(root, file));
  }
  if (/\.(mjs|js)$/.test(file)) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status) throw new Error("Syntax check failed: " + path.relative(root, file));
  }
}
for (const required of ["LICENSE", "NOTICE.md", "LICENSES/Antigravity-gateway-MIT.txt", "README.md", ".env.example"]) {
  await fs.access(path.join(root, required));
}
console.log(`Checked ${files.length} release files; syntax and credential/path checks passed.`);
