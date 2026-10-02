import assert from "node:assert/strict";
import { settingsFromEnv } from "../src/config.mjs";
import { modelProfiles } from "../src/model-profiles.mjs";
import { createSettingsStore } from "../src/settings-store.mjs";
if (!process.argv.includes("--live")) throw new Error("Pass --live to authorize two 512-token client requests (up to four provider submissions if recovery is enabled)");
const settings = process.argv.includes("--env") ? await settingsFromEnv() : (await createSettingsStore().load()).settings;
const requested = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : null;
if (process.argv.includes("--model") && (!requested || requested.startsWith("--"))) throw new Error("--model requires a saved streaming alias");
const models = modelProfiles(settings.models, settings.antiTruncation);
const model = requested ? models.find(m => m.id === requested) : models.find(m => m.mode === "streaming" && m.enabled !== false);
if (!model || model.mode !== "streaming" || model.enabled === false) throw new Error("Select an enabled streaming anti-truncation profile with --model <alias>");
const key = settings.gatewayKey;
if (!key) throw new Error("Missing GATEWAY_API_KEY");
const base = `http://127.0.0.1:${settings.port}`;
const request = (url, body) => fetch(base + url, { ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  headers: { authorization: "Bearer " + key, "content-type": "application/json" }, signal: AbortSignal.timeout(settings.timeoutMs) });
const results = [];
console.log(settings.geminiPromptRetryEnabled
  ? "Prompt recovery is enabled: up to 4 upstream submissions, each capped at 512 output tokens; retries include your custom input text."
  : "Two upstream submissions, each capped at 512 output tokens.");
for (const stream of [false, true]) {
  const started = performance.now();
  const response = await request("/v1/chat/completions", { model: model.id, stream, max_tokens: 512,
    ...(stream ? { thinking: { type: "disabled" } } : {}), messages: [{ role: "user", content: stream
      ? "Write exactly 16 numbered lines. Each line should be: <number>. The river flows quietly. No introduction or conclusion."
      : "Reply with exactly OK." }] });
  assert.equal(response.status, 200, "Provider request failed; inspect the status-only gateway log");
  const result = { requestId: response.headers.get("x-request-id"), stream, restored: false, finishReason: null,
    promptRetried: response.headers.get("x-gemini-prompt-retried") === "true" };
  if (!stream) {
    const body = await response.json();
    result.restored = body.router_anti_truncation?.restored === true;
    result.finishReason = body.choices?.[0]?.finish_reason;
    assert.ok(body.choices?.[0]?.message?.content?.length);
  } else {
    assert.equal(response.headers.get("x-anti-truncation-transport"), "tool-transport-native-streaming");
    let buffer = "", reads = 0, lastRead = -1, contentReads = 0, contentEvents = 0, first = null, last = null, done = false;
    const decoder = new TextDecoder();
    for await (const bytes of response.body) {
      reads++;
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split(/\r?\n/); buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (raw === "[DONE]") { done = true; continue; }
        const body = JSON.parse(raw);
        assert.equal(Boolean(body.error), false);
        result.restored ||= body.router_anti_truncation?.restored === true;
        const choice = body.choices?.[0];
        assert.ok(!choice?.delta?.tool_calls?.length);
        if (choice?.delta?.content?.length) {
          contentEvents++; first ??= performance.now() - started; last = performance.now() - started;
          if (lastRead !== reads) { contentReads++; lastRead = reads; }
        }
        if (choice?.finish_reason != null) result.finishReason = choice.finish_reason;
      }
    }
    assert.ok(done && contentReads >= 2 && last - first >= 100, "No progressive content arrival demonstrated");
    Object.assign(result, { contentEvents, contentReads, firstContentMs: Math.round(first), contentSpanMs: Math.round(last - first), streamDone: done });
  }
  assert.equal(result.restored, true);
  assert.equal(result.finishReason, "stop");
  results.push(result);
}
const { events } = await (await request("/admin/events")).json();
for (const result of results) {
  const event = events.find(event => event.requestId === result.requestId);
  assert.equal(event?.antiTruncation?.restored, true);
  assert.equal(event.antiTruncation.finishReason, "stop");
  if (result.stream) assert.equal(event.antiTruncation.streamDone, true);
}
console.log(JSON.stringify({ passed: true, maxTokensPerRequest: 512, results }, null, 2));
