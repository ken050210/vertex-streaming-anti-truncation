#!/usr/bin/env node
import { createConsole } from "../src/console-server.mjs";

try {
  const port = Number(process.env.GUI_PORT || 4780);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid GUI_PORT");
  const app = await createConsole({ logger: event => process.stdout.write(JSON.stringify(event) + "\n") });
  await app.listen(port);
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Vertex Gateway console: ${url}`);
  if (app.bootstrapToken) console.log(`First-time setup link (local access only): ${url}#setup=${app.bootstrapToken}`);
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
