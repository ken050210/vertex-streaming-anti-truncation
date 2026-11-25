import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readDiagnostics, startDiagnostic } from "../integrations/sillytavern/server-diagnostics.mjs";
import { DIAGNOSTIC_HEADER } from "../integrations/sillytavern/diagnostic-fields.js";
import { formatDiagnostic } from "../integrations/sillytavern/diagnostics-ui.js";
import { observeDelivery } from "../integrations/sillytavern/diagnostic-stream.js";
import { sseData } from "../src/wire.mjs";

const request = root => ({ user: { directories: { root } }, headers: { [DIAGNOSTIC_HEADER]: randomUUID() },
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
  assert.doesNotMatch(JSON.stringify(persisted), /private |user:pass|http:|proxy_password/);
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
