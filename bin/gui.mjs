#!/usr/bin/env node
import { startPricingUpdates } from "../src/pricing.mjs";
import { createConsole } from "../src/console-server.mjs";
import { loadNetworkConfig } from "../src/network-config.mjs";

try {
  const port = Number(process.env.GUI_PORT || 4780);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid GUI_PORT");
  const network = loadNetworkConfig();
  const app = await createConsole({ network, logger: event => process.stdout.write(JSON.stringify(event) + "\n") });
  await app.listen(port);
  startPricingUpdates();
  const url = network.guiOrigin ? network.guiOrigin + "/" : `http://127.0.0.1:${port}/`;
  console.log(`Vertex Gateway console: ${url}`);
  console.log(`Listening on ${network.listenHost}; console port ${port}`);
  if (app.bootstrapToken) console.log(`First-time setup link (keep private): ${url}#setup=${app.bootstrapToken}`);
  if (app.status().error) console.error("Gateway not started: " + app.status().error);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10000); deadline.unref();
    await app.close(); clearTimeout(deadline);
  });
} catch (error) {
  console.error(error.code ? "Unable to start the local console; check configuration and file permissions" : error.message);
  process.exitCode = 1;
}
