import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, lstat, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/package-sillytavern.mjs", import.meta.url));
async function fixture(t) {
  const temporary = await mkdtemp(path.join(tmpdir(), "vertex-package-test-"));
  const root = path.join(temporary, "repo");
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
    assert.ok(path.basename(temporary).startsWith("vertex-package-test-"));
    assert.equal((await lstat(temporary)).isSymbolicLink(), false);
    await rm(temporary, { recursive: true, force: true });
  });
  const files = ["package-lock.json", "assets/fonts/NotoSansCJKsc-Regular.otf", "assets/fonts/OFL.txt", "manifest.json", "package.json", "integrations/sillytavern/index.js", "integrations/sillytavern/shared.js",
    "integrations/sillytavern/style.css", "integrations/sillytavern/server.mjs", "src/current.mjs", "src/unicode-input.mjs", "LICENSE", "NOTICE.md",
    "LICENSES/Antigravity-gateway-MIT.txt", "docs/SILLYTAVERN.md"];
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), `fixture ${file}\n`);
  }
  await mkdir(path.join(root, "scripts"));
  await copyFile(script, path.join(root, "scripts/package-sillytavern.mjs"));
  return { root, temporary, files, run: () => execute(process.execPath, [path.join(root, "scripts/package-sillytavern.mjs")]) };
}

async function filesIn(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await filesIn(path.join(directory, entry.name), relative + "/"));
    else result.push(relative);
  }
  return result;
}

test("SillyTavern packages contain only current whitelisted files and preserve neighboring files", async t => {
  const { root, files, run } = await fixture(t);
  const output = path.join(root, "dist/sillytavern");
  await mkdir(path.join(output, "server/vertex-anti-truncation/src"), { recursive: true });
  await writeFile(path.join(output, "server/vertex-anti-truncation/src/obsolete.mjs"), "stale source");
  await writeFile(path.join(output, "old-release.txt"), "stale artifact");
  await writeFile(path.join(root, "dist/keep.txt"), "other artifact");
  await run();
  const hashes = JSON.parse(await readFile(path.join(output, "SHA256.json"), "utf8"));
  assert.deepEqual((await filesIn(output)).sort(), [...Object.keys(hashes), "SHA256.json"].sort());
  assert.ok(!Object.keys(hashes).some(file => file.includes("obsolete") || file.includes("old-release")));
  for (const [file, digest] of Object.entries(hashes)) {
    assert.equal(createHash("sha256").update(await readFile(path.join(output, file))).digest("hex"), digest);
  }
  for (const file of files) assert.equal(await readFile(path.join(root, file), "utf8"), `fixture ${file}\n`);
  assert.equal(await readFile(path.join(root, "dist/keep.txt"), "utf8"), "other artifact");
  assert.deepEqual((await readdir(path.join(root, "dist"))).sort(), ["keep.txt", "sillytavern"]);
  await run();
  assert.deepEqual(JSON.parse(await readFile(path.join(output, "SHA256.json"), "utf8")), hashes);
});

test("SillyTavern packaging refuses an output link before touching its target", async t => {
  const { root, temporary, run } = await fixture(t);
  const outside = path.join(temporary, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "keep.txt"), "protected");
  await mkdir(path.join(root, "dist"));
  try { await symlink(outside, path.join(root, "dist/sillytavern"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code === "EPERM") return t.skip("Creating directory links is not permitted"); throw error; }
  await assert.rejects(run(), /Package output directory must not be a link/);
  assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "protected");
});
