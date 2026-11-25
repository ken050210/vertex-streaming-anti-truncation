import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readDiagnostics, startDiagnostic } from "../integrations/sillytavern/server-diagnostics.mjs";
import { CLIENT_HEADER, DIAGNOSTIC_HEADER } from "../integrations/sillytavern/diagnostic-fields.js";
import { formatDiagnostic } from "../integrations/sillytavern/diagnostics-ui.js";
import { observeDelivery } from "../integrations/sillytavern/diagnostic-stream.js";
import { createFetchInterceptor, GENERATE_PATH } from "../integrations/sillytavern/shared.js";
import { prepareTauriTavernRequest, restoreTauriTavernResponse } from "../src/tauritavern.mjs";
import { sseData } from "../src/wire.mjs";

const request = root => ({ user: { directories: { root } }, headers: { [DIAGNOSTIC_HEADER]: randomUUID(),
  [CLIENT_HEADER]: "0.20.0 1234abcd 1.19.0  off", "user-agent": "Agent/secret-agent-name (Android 14) Chrome/120.0.0.1" },
  body: { messages: [{ role: "user", content: "private chat marker" }], model: "gemini-3.7-flash", proxy_password: "private ticket" } });
const response = { headersSent: false, setHeader() {}, json: value => value, sendStatus: value => value };
test("concurrent failures survive reload in the right account; disk failures retain a searchable safe report", async t => {
  const root = await mkdtemp(join(tmpdir(), "vertex-diag-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const user = request(root), other = request(join(root, "other"));
  await mkdir(other.user.directories.root);
  const error = Object.assign(new Error("raw private chat marker http://user:pass@proxy/"), { code: "ECONNRESET" });
  const rows = Array.from({length: 23}, () => startDiagnostic(request(root), "0.20.0"));
  await Promise.all(rows.map(item => item.finish("error", error, "vertex_upstream_failed",
    { status: "UNAVAILABLE", message: "third party private ticket" }, response)));
  const file = join(root, "vertex-anti-truncation-errors.json");
  const persisted = JSON.parse(await readFile(file, "utf8"));
  assert.equal(persisted.length, 20);
  assert.equal(new Set(persisted.map(r => r.id)).size, 20);
  assert.ok(persisted.every(r => r.network[0] === "ECONNRESET" && r.google.status === "UNAVAILABLE"));
  assert.ok(persisted.every(r => r.client.tavern === "1.19.0" && r.client.os === "Android 14"));
  assert.doesNotMatch(JSON.stringify(persisted), /private |user:pass|http:|proxy_password|secret-agent-name/);
  assert.deepEqual((await readDiagnostics(other, response)).records, []);
  assert.equal(await readDiagnostics({}, response), 401);
  const restarted = await import("../integrations/sillytavern/server-diagnostics.mjs?restart");
  assert.equal((await restarted.readDiagnostics(user, response)).records.length, 20);
  const fresh = restarted.startDiagnostic(user, "0.20.0");
  assert.equal((await restarted.readDiagnostics(user, response)).records[0].id, fresh.record.id);
  await writeFile(file, "{damaged");
  const logger = t.mock.method(console, "error", () => {});
  await fresh.finish("disconnected", error, "downstream_disconnected", null, response);
  assert.equal(logger.mock.calls.length, 1);
  assert.match(logger.mock.calls[0].arguments.at(-1), new RegExp(fresh.record.id));
  assert.doesNotMatch(logger.mock.calls[0].arguments.at(-1), /private |user:pass/);
  const recovered = await restarted.readDiagnostics(user, response);
  assert.equal(recovered.storage, "unavailable");
  assert.equal(recovered.records[0].storage, "stderr");
});

function browserTrace() {
  const record = { id: randomUUID(), state: "pending", route: "plugin", at: new Date().toISOString(), bytesReceived: 0 };
  return { record, elapsed: () => 10, preview() {}, finish(state, code) { if (record.state === "pending") Object.assign(record, { state, code }); },
    thrown(_error, code) { this.finish("error", code); } };
}
test("a bare EOF after visible output is distinguishable from STOP and from user cancellation", async () => {
  const text = sseData({candidates:[{content:{parts:[{text:"private output"}]}}]});
  for (const done of [true, false]) {
    const trace = browserTrace();
    const wire = text + (done ? sseData({candidates:[{finishReason:"STOP"}]}) + sseData("[DONE]") : "");
    const reply = observeDelivery(new Response(wire, {headers:{"content-type":"text/event-stream"}}), trace, () => {});
    assert.equal(await reply.text(), wire);
    assert.equal(trace.record.state, done ? "ok" : "error");
    assert.equal(trace.record.firstTextMs, 10);
    assert.equal(trace.record.bytesReceived, Buffer.byteLength(wire));
    assert.doesNotMatch(formatDiagnostic(trace.record), /private output/);
    if (done) assert.equal(trace.record.finishReason, "STOP");
    else assert.equal(trace.record.code, "stream_ended_without_done");
  }
  let cancelled = false;
  const trace = browserTrace();
  const upstream = new ReadableStream({ cancel() { cancelled = true; } });
  await observeDelivery(new Response(upstream), trace, () => {}).body.cancel();
  assert.equal(trace.record.state, "cancelled");
  assert.equal(cancelled, true);
  const ended = browserTrace();
  const complete = observeDelivery(new Response(sseData("[DONE]"), {headers:{"content-type":"text/event-stream"}}), ended, () => {}).body.getReader();
  await complete.read();
  await complete.cancel();
  assert.equal(ended.record.state, "ok");
});
test("an HTML gateway rejection and a socket read failure preserve their distinct browser evidence", async () => {
  const html = browserTrace();
  await observeDelivery(new Response("<html>proxy private ticket</html>", {status:502,headers:{"content-type":"text/html"}}), html, () => {}).text();
  assert.match(formatDiagnostic(html.record), /HTTP=502.*内容类型=HTML/);
  assert.doesNotMatch(formatDiagnostic(html.record), /private ticket/);
  const broken = browserTrace();
  const upstream = new ReadableStream({ pull(controller) { controller.error(new TypeError("socket error")); } });
  await assert.rejects(observeDelivery(new Response(upstream), broken, () => {}).text(), /socket error/);
  assert.equal(broken.record.code, "response_read_failed");
});

test("Tauri and PayGo report the host HTTP failure and keep plugin diagnostic headers out of their requests", async () => {
  for (const route of ["tauri", "paygo"]) {
    const trace = browserTrace();
    const fetch = createFetchInterceptor(async (_url, init) => {
      const headers = new Headers(init.headers);
      assert.equal(headers.has(CLIENT_HEADER), false);
      assert.equal(headers.has(DIAGNOSTIC_HEADER), false);
      return Response.json({ error: { status: "PERMISSION_DENIED", message: "private host message" } }, {status:403});
    }, { origin:"http://localhost", getMode:() => "streaming", startReport:() => trace,
      direct:route === "tauri" ? {prepare:prepareTauriTavernRequest,restore:restoreTauriTavernResponse} : null, payGoInstalled:route === "paygo" });
    const reply = await fetch(GENERATE_PATH,{method:"POST",body:JSON.stringify({ ...request().body, chat_completion_source:"vertexai", stream:true })});
    assert.equal((await reply.json()).error.status, "PERMISSION_DENIED");
    assert.equal(trace.record.route, route); assert.equal(trace.record.hostStatus, 403);
    assert.equal(trace.record.google.status, "PERMISSION_DENIED");
    assert.doesNotMatch(formatDiagnostic(trace.record), /private host message/);
  }
});
