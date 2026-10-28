// One explicitly authorized live request against an isolated, published Docker image.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const model = "gemini-3.7-flash-antitruncation";
const prompt = "请只回复英文标记 DOCKER_OK，不要解释。";

export async function imageProbe(request = fetch) {
  const result = { passed: false, model, maxTokens: 512, generationRequests: 0 };
  const started = performance.now();
  const base = "http://127.0.0.1:4781";
  const headers = { authorization: "Bearer " + process.env.GATEWAY_API_KEY, "content-type": "application/json" };
  try {
    result.generationRequests++;
    const response = await request(base + "/v1/chat/completions", {
      method: "POST", headers, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ model, stream: false, max_tokens: 512, messages: [{ role: "user", content: prompt }] }),
    });
    Object.assign(result, {
      status: response.status, requestId: response.headers.get("x-request-id"),
      imageInput: response.headers.get("x-image-input"),
      transport: response.headers.get("x-anti-truncation-transport"),
      promptRetried: response.headers.get("x-gemini-prompt-retried"),
    });
    // Capture the entire reply before any assertion, including on a header mismatch.
    result.rawBody = await response.text();
    const body = JSON.parse(result.rawBody);
    result.output = body.choices?.[0]?.message?.content;
    const eventsResponse = await request(base + "/admin/events", { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(eventsResponse.status, 200, "Unable to read the request audit");
    const { events } = await eventsResponse.json();
    result.events = events;
    assert.equal(response.status, 200, "Image request failed; no retry");
    assert.equal(result.imageInput, "encoded");
    assert.equal(result.transport, "tool-transport", "Non-stream image replies use tool-transport");
    assert.equal(result.promptRetried, "false");
    assert.equal(body.router_anti_truncation?.restored, true);
    assert.equal(body.choices?.[0]?.finish_reason, "stop");
    assert.equal(typeof result.output, "string");
    assert.equal(result.output.trim(), "DOCKER_OK", "Reply must contain only the requested marker");
    assert.ok(Array.isArray(events));
    assert.equal(events.length, 1, "The isolated gateway must record exactly one generation");
    const event = events[0];
    assert.ok(result.requestId);
    assert.equal(event.requestId, result.requestId);
    assert.equal(event.event, "request_complete");
    assert.equal(event.status, 200);
    assert.equal(event.stream, false);
    assert.equal(event.imageInput?.mode, "all");
    assert.equal(event.imageInput?.reason, "encoded");
    assert.equal(event.imageInput?.pages, 1);
    assert.ok(event.imageInput.bytes > 0);
    assert.equal(event.antiTruncation?.transport, "tool-transport");
    assert.equal(event.antiTruncation?.restored, true);
    assert.equal(event.antiTruncation?.finishReason, "stop");
    assert.equal(event.responseIntegrity?.outcome, "complete");
    assert.equal(event.responseIntegrity?.hasContent, true);
    assert.equal(event.geminiCompatibility?.promptRetried, false);
    result.passed = true;
  } catch (error) {
    result.error = error.message;
  }
  result.elapsedMs = Math.round(performance.now() - started);
  return result;
}

async function main() {
  const { values } = parseArgs({ options: {
    live: { type: "boolean" }, probe: { type: "boolean" }, credentials: { type: "string" },
    image: { type: "string", default: "ghcr.io/ken050210/vertex-streaming-anti-truncation:0.12.0" },
    report: { type: "string" },
  } });
  assert.equal(values.live, true, "Pass --live to authorize exactly one request, max 512 output tokens, no retry");
  if (values.probe) {
    assert.ok(process.env.GATEWAY_API_KEY);
    console.log(JSON.stringify(await imageProbe()));
    return;
  }
  assert.ok(values.credentials, "--credentials <service-account.json> is required");
  const file = resolve(values.credentials);
  const credentials = await readFile(file);
  const account = JSON.parse(credentials.toString("utf8"));
  assert.equal(account.type, "service_account");
  assert.ok(account.project_id);
  const hash = data => createHash("sha256").update(data).digest("hex");
  const before = hash(credentials);
  const name = "vertex-docker-image-live-" + randomUUID().slice(0, 8);
  const reportFile = resolve(values.report || `runtime/${name}.json`);
  const execute = promisify(execFile);
  const env = { ...process.env, GATEWAY_API_KEY: randomBytes(32).toString("hex"), VERTEX_PROJECT_ID: account.project_id };
  const docker = async args => (await execute("docker", args, { env, timeout: 180000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  const report = { passed: false, startedAt: new Date().toISOString(), image: values.image,
    model, maxTokens: 512, promptRetriesEnabled: false, container: name };
  let created = false;
  try {
    report.imageDigests = JSON.parse(await docker(["image", "inspect", values.image, "--format", "{{json .RepoDigests}}"]));
    await docker(["run", "-d", "--pull=never", "--name", name, "--init", "--read-only", "--no-healthcheck",
      "--tmpfs", "/tmp:size=64m,mode=1777", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
      "--mount", `type=bind,source=${file},target=/run/secrets/google.json,readonly`,
      "--mount", `type=bind,source=${fileURLToPath(import.meta.url)},target=/probe.mjs,readonly`,
      "-e", "GATEWAY_API_KEY", "-e", "VERTEX_PROJECT_ID", "-e", "GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/google.json",
      "-e", "VERTEX_LOCATION=global", "-e", "VERTEX_SERVICE_TIER=standard", "-e", "UPSTREAM_TIMEOUT_MS=120000",
      "-e", "GEMINI_PROMPT_RETRY_ENABLED=false", "-e", "IMAGE_INPUT=all", values.image, "node", "bin/start.mjs"]);
    created = true;
    const deadline = Date.now() + 30000;
    while (true) {
      try {
        await docker(["exec", name, "node", "--input-type=module", "-e",
          "const r=await fetch('http://127.0.0.1:4781/healthz',{signal:AbortSignal.timeout(1000)});if(!r.ok)process.exit(1)"]);
        break;
      } catch {
        assert.ok(Date.now() < deadline, "Gateway did not start; no inference sent");
        await delay(250);
      }
    }
    console.log("Sending one image-input request, capped at 512 output tokens; no retry.");
    report.result = JSON.parse(await docker(["exec", name, "node", "/probe.mjs", "--probe", "--live"]));
    report.passed = report.result.passed;
    report.gatewayLogs = await docker(["logs", name]);
  } catch (error) {
    report.error = error.message;
  } finally {
    if (created) {
      try { await docker(["rm", "-f", name]); report.containerRemoved = true; }
      catch { report.containerRemoved = false; report.passed = false; }
    }
    report.credentialUnchanged = before === hash(await readFile(file));
    report.passed &&= report.credentialUnchanged;
    report.finishedAt = new Date().toISOString();
    await mkdir(dirname(reportFile), { recursive: true });
    await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
    console.log("Receipt: " + reportFile);
    if (!report.passed) process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
