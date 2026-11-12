#!/usr/bin/env node
import { startPricingUpdates } from "../src/pricing.mjs";
import { loadConfig } from "../src/config.mjs";
import { createGatewayServer } from "../src/gateway.mjs";
import { loadNetworkConfig } from "../src/network-config.mjs";

try {
  const config = await loadConfig();
  const network = loadNetworkConfig();
  const logger = event => process.stdout.write(JSON.stringify(event) + "\n");
  const server = createGatewayServer(config, { logger });
  startPricingUpdates();
  server.on("error", () => { console.error("Gateway could not bind its configured address/port"); process.exitCode = 1; });
  server.listen(config.port, network.listenHost, () => {
    logger({ event: "listening", host: network.listenHost, endpoint: network.gatewayPublicUrl || `http://127.0.0.1:${config.port}/v1`, model: config.model });
  });
  let stopping = false;
  for (const name of ["SIGINT", "SIGTERM"]) process.on(name, () => {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
