#!/usr/bin/env node
import { loadConfig } from "../src/config.mjs";
import { createGatewayServer } from "../src/gateway.mjs";

try {
  const config = await loadConfig();
  const logger = event => process.stdout.write(JSON.stringify(event) + "\n");
  const server = createGatewayServer(config, { logger });
  server.on("error", () => { console.error("Gateway could not bind its loopback port"); process.exitCode = 1; });
  server.listen(config.port, "127.0.0.1", () => {
    logger({ event: "listening", endpoint: `http://127.0.0.1:${config.port}/v1`, model: config.model });
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
