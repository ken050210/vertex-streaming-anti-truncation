// One-step installer shipped at the root of the packaged SillyTavern bundle.
// Usage: node install.mjs [SillyTavern folder] [--skip-deps]
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const NAME = "vertex-anti-truncation";
const PACKAGE_NAME = "vertex-streaming-anti-truncation";
const HOME_PAGE = "github.com/ken050210/vertex-streaming-anti-truncation";
const MARKER = ".vertex-installer.json";
const KINDS = ["server", "extension"];
const args = process.argv.slice(2);
const skipDeps = args.includes("--skip-deps");
const interactive = process.stdin.isTTY === true;

const readJson = file => readFile(file, "utf8").then(JSON.parse, () => null);
const isLink = async dir => (await lstat(dir).catch(() => null))?.isSymbolicLink() === true;
function fail(message) {
  console.error(`\n安装未完成：${message}`);
  process.exit(1);
}
async function ask(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return await prompt.question(question); } finally { prompt.close(); }
}
async function isSillyTavern(dir) {
  return existsSync(path.join(dir, "server.js")) && (await readJson(path.join(dir, "package.json")))?.name === "sillytavern";
}
async function subdirectories(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => path.join(dir, entry.name));
}

async function findRoot() {
  const given = args.find(arg => !arg.startsWith("--"));
  if (given) return path.resolve(given);
  // The package may have been extracted inside the SillyTavern folder.
  for (const start of [process.cwd(), path.dirname(here)]) {
    for (let dir = start, depth = 0; depth < 3; dir = path.dirname(dir), depth++) if (await isSillyTavern(dir)) return dir;
  }
  if (!interactive) fail("请在命令后面写上 SillyTavern 文件夹的路径。");
  let answer = (await ask("请把 SillyTavern 文件夹拖进这个窗口（或输入它的路径），然后按回车：\n> ")).trim().replace(/^(["'])(.*)\1$/, "$2");
  // macOS and Linux terminals escape spaces in dropped paths.
  if (process.platform !== "win32") answer = answer.replace(/\\(.)/g, "$1");
  if (!answer) fail("没有输入路径。");
  return path.resolve(answer);
}

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || major === 22 && minor < 9) fail(`插件需要 Node.js 22.9 或更高版本，当前是 ${process.versions.node}。请先升级 Node.js。`);
for (const kind of KINDS) {
  if (!existsSync(path.join(here, kind, NAME))) fail(`安装包缺少 ${kind}/${NAME} 文件夹。请重新解压完整的安装包后再运行。`);
}
const version = (await readJson(path.join(here, "extension", NAME, "manifest.json")))?.version ?? "?";

const root = await findRoot();
if (!await isSillyTavern(root)) fail(`${root} 不是 SillyTavern 文件夹（里面应该有 server.js 和 SillyTavern 的 package.json）。`);
const configFile = path.join(root, "config.yaml");
if (!existsSync(configFile)) fail("没有找到 config.yaml。请先正常启动一次酒馆让它生成配置，关闭后再运行安装。");
const tavernVersion = (await readJson(path.join(root, "package.json"))).version;
let config = await readFile(configFile, "utf8");
const dataRoot = path.resolve(root, config.match(/^dataRoot:[ \t]*["']?([^"'#\r\n]*?)["']?[ \t]*(?:#.*)?$/m)?.[1] || "data");
const targets = {
  server: path.join(root, "plugins", NAME),
  extension: path.join(root, "public", "scripts", "extensions", "third-party", NAME),
};

// Any other copy of this plugin would be loaded twice. Never overwrite or
// delete copies that this installer did not create.
const copies = [];
for (const dir of await subdirectories(path.join(root, "plugins"))) {
  if ((await readJson(path.join(dir, "package.json")))?.name === PACKAGE_NAME) copies.push(dir);
}
const extensionParents = [path.dirname(targets.extension), ...(await subdirectories(dataRoot)).map(user => path.join(user, "extensions"))];
for (const parent of extensionParents) {
  for (const dir of await subdirectories(parent)) {
    if ((await readJson(path.join(dir, "manifest.json")))?.homePage?.includes(HOME_PAGE)) copies.push(dir);
  }
}
const conflicts = copies.filter(dir => !Object.values(targets).includes(dir) || !existsSync(path.join(dir, MARKER)));
for (const target of Object.values(targets)) {
  if (!conflicts.includes(target) && (await isLink(target) || existsSync(target) && !copies.includes(target))) conflicts.push(target);
}
if (conflicts.length) {
  fail([
    "发现不是由安装包放进去的同名或同一插件的文件夹：",
    ...conflicts.map(dir => `  - ${dir}`),
    "为避免插件被加载两次，安装包不会覆盖或删除它们。",
    "可以继续用原来的方式（Git 或手动复制）更新；想改用安装包，请先关闭酒馆，把上面的文件夹移到酒馆目录以外（留作备份），再重新运行安装。",
  ].join("\n"));
}

const pluginsEnabled = /^enableServerPlugins:[ \t]*true[ \t]*(?:#.*)?$/m.test(config);
const action = target => existsSync(target) ? "更新" : "新装";
console.log([
  `\nVertex AI 抗截断 ${version} 安装程序`,
  `  酒馆：${root}（SillyTavern ${tavernVersion}）`,
  `  服务端插件（${action(targets.server)}）→ ${path.relative(root, targets.server)}`,
  `  前端扩展（${action(targets.extension)}）→ ${path.relative(root, targets.extension)}`,
  `  图片渲染组件：${skipDeps ? "跳过" : "联网安装"}`,
  `  config.yaml：${pluginsEnabled ? "enableServerPlugins 已开启，不修改" : "把 enableServerPlugins 改为 true（先备份原文件）"}`,
].join("\n"));
if (!tavernVersion?.startsWith("1.19.")) console.warn(`\n注意：插件按 SillyTavern 1.19.0 适配，你的是 ${tavernVersion}，装上后可能无法加载。`);
if (interactive) await ask("\n请先关闭酒馆。准备好后按回车开始，按 Ctrl+C 取消。");

// Prepare both halves next to their targets (same volume), then swap them in.
// If either swap fails, restore what was there before.
const staging = await mkdtemp(path.join(root, ".vertex-installer-"));
let depsInstalled = false;
let installError;
try {
  for (const kind of KINDS) {
    await cp(path.join(here, kind, NAME), path.join(staging, kind), { recursive: true });
    await writeFile(path.join(staging, kind, MARKER), JSON.stringify({ version }, null, 2) + "\n");
  }
  // This directory contains only the public receipt. A Windows directory junction
  // works for ordinary users who cannot create a file symlink.
  const receipt = { id: NAME, version, installedAt: new Date().toISOString() };
  const publicDir = "public-install-receipt";
  await mkdir(path.join(staging, "server", publicDir));
  await writeFile(path.join(staging, "server", publicDir, "installation.json"), JSON.stringify(receipt));
  const source = path.join(targets.server, publicDir);
  let linked = true;
  try {
    await symlink(process.platform === "win32" ? source : path.relative(targets.extension, source),
      path.join(staging, "extension", "vertex-server-receipt"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EINVAL"].includes(error.code)) throw error;
    linked = false;
  }
  await writeFile(path.join(staging, "extension", "vertex-installation.json"), JSON.stringify({ ...receipt, linked }));
  if (!skipDeps) {
    console.log("\n正在安装图片输入需要的渲染组件（需要联网，可能要一两分钟）……");
    depsInstalled = spawnSync("npm ci --omit=dev --ignore-scripts --no-audit --no-fund", { cwd: path.join(staging, "server"), stdio: "inherit", shell: true }).status === 0;
  }
  const swapped = [];
  try {
    for (const kind of KINDS) {
      const target = targets[kind];
      const previous = existsSync(target) ? path.join(staging, `previous-${kind}`) : null;
      if (previous) await rename(target, previous);
      else await mkdir(path.dirname(target), { recursive: true });
      try { await rename(path.join(staging, kind), target); }
      catch (error) { if (previous) await rename(previous, target); throw error; }
      swapped.push({ kind, target, previous });
    }
  } catch (error) {
    for (const { kind, target, previous } of swapped.reverse()) {
      await rename(target, path.join(staging, `failed-${kind}`));
      if (previous) await rename(previous, target);
    }
    throw error;
  }
} catch (error) {
  installError = error;
} finally {
  await rm(staging, { recursive: true, force: true }).catch(() => console.warn(`临时文件夹没能删除，可以手动删掉：${staging}`));
}
if (["EBUSY", "EPERM", "EACCES"].includes(installError?.code)) {
  fail(`文件被占用或没有权限（${installError.code}）。请确认酒馆已经完全关闭，再重新运行安装。之前的安装保持不变。`);
}
if (installError) throw installError;

let backup;
if (!pluginsEnabled) {
  config = await readFile(configFile, "utf8");
  const eol = config.includes("\r\n") ? "\r\n" : "\n";
  backup = `${configFile}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await writeFile(backup, config);
  await writeFile(configFile, /^enableServerPlugins:.*$/m.test(config)
    ? config.replace(/^enableServerPlugins:.*$/m, "enableServerPlugins: true")
    : config + (config.endsWith("\n") ? "" : eol) + "enableServerPlugins: true" + eol);
}

console.log([
  "\n安装完成。",
  `  服务端插件：${targets.server}`,
  `  前端扩展：${targets.extension}`,
  depsInstalled ? "  图片渲染组件：已安装"
    : "  图片渲染组件：未安装。抗截断和 Unicode 转码不受影响，只有图片输入会报 image_renderer_unavailable；联网后重新运行安装即可补上。",
  backup ? `  config.yaml：已开启 enableServerPlugins，原文件备份为 ${backup}` : "  config.yaml：未修改",
  "",
  "下一步：",
  "  1. 启动酒馆，然后刷新网页。",
  "  2. 打开 API 连接 → Google Vertex AI → 抗截断传输，点击“检查插件连接”，应显示“服务端插件已就绪”。",
  "更新：下载新版安装包，再运行一次。卸载：先在面板里关闭抗截断，关闭酒馆，再把上面两个文件夹移出酒馆目录。",
].join("\n"));
