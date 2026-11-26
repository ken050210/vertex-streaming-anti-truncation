import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createConsole } from "../../src/console-server.mjs";
import { loadNetworkConfig } from "../../src/network-config.mjs";
import { createSettingsStore } from "../../src/settings-store.mjs";

test("add accounts over LAN HTTP, save and apply rotation, then reload the console", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-lan-console-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const loginKey = "fixture-console-access-key";
  const store = createSettingsStore({ directory, env: { GATEWAY_API_KEY: loginKey, VERTEX_API_KEY: "fixture-primary-key" } });
  const network = loadNetworkConfig({});
  const app = await createConsole({ store, network, autoStart: false, fetchImpl: () => assert.fail("Unexpected upstream call") });
  t.after(() => app.close());
  await app.listen(0);
  // Localhost is a secure context even on HTTP. Map a LAN-style origin to the isolated listener.
  network.guiOrigin = "http://console.test:" + app.server.address().port;
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP console.test 127.0.0.1", "--no-proxy-server"] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(network.guiOrigin);
  assert.equal(await page.evaluate(() => window.isSecureContext), false);
  await page.getByLabel("本地访问密钥").fill(loginKey);
  await page.getByRole("button", { name: "进入控制台" }).click();
  const connection = page.getByRole("navigation").getByRole("button", { name: "连接配置" });
  await connection.click();

  // Save starts the real gateway. Leave the user's usual gateway port available.
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const gatewayPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  await page.locator("#port").fill(String(gatewayPort));

  const names = ["备用账号 A", "备用账号 B"];
  const accounts = page.getByRole("group", { name: "附加账号", exact: true });
  for (const [index, name] of names.entries()) {
    await page.getByRole("button", { name: "添加账号" }).click();
    assert.deepEqual(errors, [], "添加账号 raised a browser error");
    const row = accounts.nth(index);
    await row.getByLabel("账号名称").fill(name);
    await row.getByLabel("Express API Key").fill("fixture-backup-key-" + index);
  }
  const rotation = page.getByRole("checkbox", { name: /启用多账号轮询/ });
  await rotation.check();
  await page.getByRole("button", { name: "保存并应用" }).click();
  await page.getByText("配置已保存并应用，网关正在运行。", { exact: true }).waitFor();

  await page.reload();
  await connection.click();
  assert.equal(await rotation.isChecked(), true);
  assert.equal(await accounts.count(), names.length);
  const status = await page.locator("#account-status").innerText();
  for (const [index, name] of names.entries()) {
    const row = accounts.nth(index);
    assert.equal(await row.getByLabel("账号名称").inputValue(), name);
    assert.equal(await row.getByLabel("Express API Key").inputValue(), "");
    assert.ok(status.includes(name + "：参与轮询"), status);
  }
  assert.deepEqual(errors, []);
});
