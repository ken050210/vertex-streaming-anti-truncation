import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const installer = fileURLToPath(new URL("../integrations/sillytavern/installer/install.mjs", import.meta.url));
const homePage = "https://github.com/ken050210/vertex-streaming-anti-truncation";
const config = "dataRoot: ./data\r\n# Enable server plugins\r\nenableServerPlugins: false\r\nlisten: false\r\n";

async function put(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function fixture(t) {
  const temporary = await mkdtemp(path.join(tmpdir(), "vertex-install-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const pkg = path.join(temporary, "package");
  const tavern = path.join(temporary, "SillyTavern");
  await mkdir(pkg);
  await copyFile(installer, path.join(pkg, "install.mjs"));
  await put(path.join(pkg, "server/vertex-anti-truncation/package.json"), JSON.stringify({ name: "vertex-streaming-anti-truncation", main: "server.mjs" }));
  await put(path.join(pkg, "server/vertex-anti-truncation/server.mjs"), "v1");
  await put(path.join(pkg, "extension/vertex-anti-truncation/manifest.json"), JSON.stringify({ version: "9.9.9", homePage }));
  await put(path.join(pkg, "extension/vertex-anti-truncation/index.js"), "v1");
  await put(path.join(tavern, "server.js"), "");
  await put(path.join(tavern, "package.json"), JSON.stringify({ name: "sillytavern", version: "1.19.0" }));
  await put(path.join(tavern, "config.yaml"), config);
  await mkdir(path.join(tavern, "plugins"));
  await mkdir(path.join(tavern, "data/default-user/extensions"), { recursive: true });
  return { pkg, tavern, run: () => execute(process.execPath, [path.join(pkg, "install.mjs"), tavern, "--skip-deps"]) };
}

const backups = async tavern => (await readdir(tavern)).filter(file => file.startsWith("config.yaml.backup-"));

test("installer places both halves, enables server plugins once with a backup, and updates its own copy", async t => {
  const { pkg, tavern, run } = await fixture(t);
  const server = path.join(tavern, "plugins/vertex-anti-truncation");
  const extension = path.join(tavern, "public/scripts/extensions/third-party/vertex-anti-truncation");
  await run();
  assert.equal(await readFile(path.join(server, "server.mjs"), "utf8"), "v1");
  assert.equal(await readFile(path.join(extension, "index.js"), "utf8"), "v1");
  assert.deepEqual(JSON.parse(await readFile(path.join(extension, ".vertex-installer.json"), "utf8")), { version: "9.9.9" });
  assert.ok(existsSync(path.join(server, ".vertex-installer.json")));
  const receipt = JSON.parse(await readFile(path.join(extension, "vertex-installation.json"), "utf8"));
  assert.equal(receipt.id, "vertex-anti-truncation");
  assert.equal(receipt.version, "9.9.9");
  assert.ok(Number.isFinite(Date.parse(receipt.installedAt)));
  const markerFile = path.join(server, "public-install-receipt", "installation.json");
  const visibleFile = path.join(extension, "vertex-server-receipt", "installation.json");
  const marker = JSON.parse(await readFile(markerFile, "utf8"));
  assert.deepEqual(marker, { id: receipt.id, version: receipt.version, installedAt: receipt.installedAt });
  if (receipt.linked) {
    assert.deepEqual(await readdir(path.dirname(visibleFile)), ["installation.json"]);
    assert.deepEqual(JSON.parse(await readFile(visibleFile, "utf8")), marker);
    await rm(markerFile);
    await assert.rejects(readFile(visibleFile), { code: "ENOENT" });
  } else assert.equal(existsSync(visibleFile), false);
  assert.equal(await readFile(path.join(tavern, "config.yaml"), "utf8"), config.replace("enableServerPlugins: false", "enableServerPlugins: true"));
  const [backup] = await backups(tavern);
  assert.equal(await readFile(path.join(tavern, backup), "utf8"), config);
  assert.ok(!(await readdir(tavern)).some(file => file.startsWith(".vertex-installer-")));

  await writeFile(path.join(pkg, "server/vertex-anti-truncation/server.mjs"), "v2");
  await writeFile(path.join(server, "stale.mjs"), "old file");
  await run();
  if (receipt.linked) assert.deepEqual(JSON.parse(await readFile(visibleFile, "utf8")), JSON.parse(await readFile(markerFile, "utf8")));
  assert.equal(await readFile(path.join(server, "server.mjs"), "utf8"), "v2");
  assert.ok(!existsSync(path.join(server, "stale.mjs")));
  assert.equal((await backups(tavern)).length, 1);
});

test("installer refuses copies it did not install and changes nothing", async t => {
  const { tavern, run } = await fixture(t);
  const manual = path.join(tavern, "plugins/vertex-anti-truncation");
  const git = path.join(tavern, "public/scripts/extensions/third-party/vertex-streaming-anti-truncation");
  const personal = path.join(tavern, "data/default-user/extensions/vertex-copy");
  await put(path.join(manual, "package.json"), JSON.stringify({ name: "vertex-streaming-anti-truncation" }));
  await put(path.join(git, "manifest.json"), JSON.stringify({ homePage }));
  await put(path.join(personal, "manifest.json"), JSON.stringify({ homePage: homePage + ".git" }));
  await assert.rejects(run(), error => {
    for (const dir of [manual, git, personal]) assert.ok(error.stderr.includes(dir), dir);
    return error.code === 1;
  });
  assert.deepEqual(await readdir(manual), ["package.json"]);
  assert.ok(!existsSync(path.join(tavern, "public/scripts/extensions/third-party/vertex-anti-truncation")));
  assert.equal(await readFile(path.join(tavern, "config.yaml"), "utf8"), config);
  assert.deepEqual(await backups(tavern), []);
});
