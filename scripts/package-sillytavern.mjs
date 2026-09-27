import { mkdir, readFile, readdir, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(root, "dist", "sillytavern");
const name = "vertex-anti-truncation";
const frontend = ["manifest.json", "integrations/sillytavern/index.js", "integrations/sillytavern/shared.js", "integrations/sillytavern/style.css"];
const backend = ["package.json", "integrations/sillytavern/server.mjs", "integrations/sillytavern/shared.js",
  ...(await readdir(path.join(root, "src"))).filter(file => file.endsWith(".mjs")).map(file => `src/${file}`)];
const notices = ["LICENSE", "NOTICE.md", "LICENSES/Antigravity-gateway-MIT.txt", "docs/SILLYTAVERN.md"];
const hashes = {};
for (const [kind, files] of [["server", backend], ["extension", frontend]]) {
  const destination = path.join(output, kind, name);
  for (const file of [...files, ...notices]) {
    const target = path.join(destination, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, file), target);
    hashes[`${kind}/${name}/${file}`] = createHash("sha256").update(await readFile(target)).digest("hex");
  }
}
await writeFile(path.join(output, "SHA256.json"), JSON.stringify(hashes, null, 2) + "\n");
console.log(`SillyTavern server plugin and UI extension packaged in ${output}`);
