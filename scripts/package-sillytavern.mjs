import { mkdir, mkdtemp, readFile, readdir, writeFile, copyFile, lstat, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const distribution = path.join(root, "dist");
const output = path.join(distribution, "sillytavern");
const name = "vertex-anti-truncation";
const frontend = ["src/unicode-input.mjs", "manifest.json", "integrations/sillytavern/index.js", "integrations/sillytavern/shared.js", "integrations/sillytavern/style.css"];
const backend = ["package.json", "package-lock.json", "assets/fonts/NotoSansCJKsc-Regular.otf", "assets/fonts/OFL.txt", "integrations/sillytavern/server.mjs", "integrations/sillytavern/shared.js",
  ...(await readdir(path.join(root, "src"))).filter(file => file.endsWith(".mjs")).map(file => `src/${file}`)];
const notices = ["LICENSE", "NOTICE.md", "LICENSES/Antigravity-gateway-MIT.txt", "docs/SILLYTAVERN.md"];
// Only replace generated directories immediately beneath this repository's real
// dist directory. Refuse links/junctions before any recursive removal on Windows.
async function verifyGeneratedDirectory(directory) {
  if (path.dirname(path.resolve(directory)) !== distribution ||
      (directory !== output && !path.basename(directory).startsWith(".sillytavern-"))) throw new Error("Unsafe package output path");
  if (await realpath(distribution) !== path.join(await realpath(root), "dist")) throw new Error("Package dist directory must not be a link");
  const entry = await lstat(directory).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (entry?.isSymbolicLink()) throw new Error("Package output directory must not be a link");
}

await mkdir(distribution, { recursive: true });
await verifyGeneratedDirectory(output);
const staging = await mkdtemp(path.join(distribution, ".sillytavern-"));
try {
  const hashes = {};
  for (const [kind, files] of [["server", backend], ["extension", frontend]]) {
    const destination = path.join(staging, kind, name);
    for (const file of [...files, ...notices]) {
      const target = path.join(destination, file);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(root, file), target);
      hashes[`${kind}/${name}/${file}`] = createHash("sha256").update(await readFile(target)).digest("hex");
    }
  }
  await writeFile(path.join(staging, "SHA256.json"), JSON.stringify(hashes, null, 2) + "\n");
  await verifyGeneratedDirectory(output);
  await rm(output, { recursive: true, force: true });
  await rename(staging, output);
} finally {
  await verifyGeneratedDirectory(staging);
  await rm(staging, { recursive: true, force: true });
}
console.log(`SillyTavern server plugin and UI extension packaged in ${output}`);
