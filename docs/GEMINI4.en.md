# Gemini 4 Argon

[中文](GEMINI4.md) | English

Checked on 2026-10-14. The model ID is `gemini-4-argon`; Vertex's OpenAI-compatible API uses `google/gemini-4-argon`. Use `global`; Google also lists `us` and `eu`.

## Updating

The Tavern plugin part ships in SillyTavern integration 0.4.0 (`sillytavern-v0.4.0`); earlier packages do not include it. The gateway part ships in gateway 0.8.0, available as source and Docker images.

- Standalone gateway: stop it, run `git pull --ff-only` and `npm ci --ignore-scripts` in this checkout, then restart. Resolve any local conflicts without overwriting your configuration. Saved models, credentials, token limits and timeouts are preserved.
- Git-installed Tavern integration: update both the UI extension and server plugin to the same `main` commit, run `npm ci --ignore-scripts` in the server plugin, restart Tavern and refresh the page. The [Tavern guide](SILLYTAVERN.md) covers locations and migration.
- One-step package installations: download the `sillytavern-v0.4.0` package and run it again, or run `npm run package:sillytavern` from updated source and use the generated `dist/sillytavern` installer. Do not copy a Git installation over an installer-managed directory.

This development validation generated and checked the package; it did not update the existing Tavern installation.

## Adding the model and choosing credentials

In the model manager, enter `gemini-4-argon`, select the normal, buffered or streaming anti-truncation profiles you want, add them and save. Catalog discovery is optional; discovery failure does not prevent manual entry, and a catalog entry does not prove inference permission. Existing 3.7/3.8 profiles and defaults are retained.

The gateway supports full service-account JSON, Vertex Express API keys and short-lived OAuth access tokens. Express uses `global` and does not require a project ID. An Express key is not an arbitrary AI Studio key; Gemini 4 entitlement and availability still depend on Google and the account. Live Express entitlement for Argon has not been tested here.

You can customize Gemini model IDs and client-facing names. Besides Google's Vertex endpoints, the standalone gateway can use an OpenAI-compatible service that serves Gemini models; see [Custom upstream](GATEWAY.en.md#custom-upstream). Argon's thinking level and similar fields are then sent upstream as-is, and whether they take effect is up to that service; streaming anti-truncation does not use Vertex's native argument stream there. Connecting Tavern's custom OpenAI connection to this local gateway is a separate matter from which upstream the gateway uses.

## Request compatibility

- `reasoning_effort: low|medium|high` maps to `thinking_level: LOW|MEDIUM|HIGH`. Omitted effort or `auto` keeps the model default, MEDIUM. Legacy `none/min/minimal` maps to LOW and `max/xhigh` to HIGH; thinking cannot be disabled. Explicit `extra_body.google.thinking_config` takes precedence.
- Numeric `thinking_budget` / `thinkingBudget` and explicit `cached_content` fail locally with HTTP 400. Their budget or cache semantics are not silently discarded.
- Sampling controls, penalties and `n` listed for removal by Google's migration checklist are omitted. The optional assistant-to-user prefill conversion now includes Argon; it only converts trailing plain text and preserves tool and thinking history.
- The native Tavern plugin handles Argon thinking levels independently of older Tavern budget helpers. Your Tavern must still let you select or enter the model ID.
- In the TauriTavern adaptation, TauriTavern itself handles Argon's thinking level and sampling parameters and must already list the model; the extension only caps a larger output limit at 65,536. See the [TauriTavern section (Chinese)](SILLYTAVERN.md#tauritavern).
- Native function-call IDs and thought signatures round-trip in opaque `vtx4.` tool-call IDs. Clients must preserve these IDs when returning tool results.
- Output limits above one request's maximum no longer fail; see [Output limits and long decode](#output-limits-and-long-decode).
- For complex requests, the existing timeout may need to be raised to 900,000 ms or more. Updating does not change it automatically.

## Output limits and long decode

This section ships in standalone gateway 0.11.0 and SillyTavern integration 0.6.0; earlier versions fail an oversized limit with `gemini4_long_decode_required`.

Google limits one Argon request to 65,536 output tokens when streamed and 32,768 when not, thinking included. Google's long decode continues a reply across further requests, up to 1,048,576 tokens minus the input, on the `v1beta1` API only. See the Long decodes section of the [Gemini 4 guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon).

### Default: send the single-request limit

Long decode is off by default. A larger output limit is sent as the limit of the request actually made to Google, streaming or not, instead of failing with `gemini4_long_decode_required`; no request is added. The value saved in the client or preset is not changed. Tavern's connection test sends only "Hi" but carries the preset's limit, and used to fail for that reason.

| Entry point | Limit sent |
| --- | --- |
| Standalone gateway to Google (native or compatible API) | 65,536 when the request to Google streams, otherwise 32,768. Buffered anti-truncation is a unary request even when the client asks for SSE |
| Standalone gateway, custom upstream | Always 32,768, since the gateway cannot see how the relay calls Google |
| Requests the Tavern plugin takes | 65,536 when Tavern requests streaming and the plugin uses streaming anti-truncation, including text-to-image input. Non-streaming requests (such as connection tests), buffered mode and image-only mode use 32,768 |
| TauriTavern | 65,536 (it always streams) |
| Requests the plugin leaves to Tavern's own route | Unchanged |

The `x-gemini-output-tokens-requested`, `x-gemini-output-tokens-applied` and `x-gemini-long-decode` headers and the gateway log's `outputLimit` record the requested limit, the limit sent and whether long decode applies; the Tavern panel shows the limit sent. Limits within one request are unaffected.

### When a reply reaches the limit

With long decode off, a reply that actually reaches the single-request limit:

- Stops there with a length finish reason (Google's `MAX_TOKENS`, OpenAI's `length`). It is neither an error nor reported as complete.
- Shares the limit with thinking: longer thinking leaves less text, and in the extreme case none.
- Keeps the text already written with streaming anti-truncation. Buffered (unary) anti-truncation may return no text: a 2026-10-14 test on Gemini 3.7 Flash with a 300-token limit got only thinking and `MAX_TOKENS`, no function call, so the delivered text was empty. The thinking may have used up the 300 tokens first; this was not retested on Argon. Plain requests without anti-truncation keep the written text per Google's usual behavior; this project has not tested that specifically.
- Can be extended with Tavern's Continue, which sends one more request billed as usual.

### Turning long decode on

In the standalone gateway, check "Gemini 4 Argon 超长回复自动续写" under 连接配置 → SillyTavern 兼容与重试, or set `GEMINI_LONG_DECODE=true` in CLI mode. In the Tavern plugin, check the option of the same name in the Vertex panel. Both are off by default and saved separately.

- Only Argon requests whose limit exceeds one request's maximum are affected. They use the native `v1beta1` API with the client's limit (1,048,576 at most). When Google ends a request with `CONTINUATION` and a continuation token, the gateway or plugin sends the same request again with the token until Google finishes, and delivers one reply: a single finish reason and usage added up across the requests.
- Requests are added only when a reply actually exceeds the single-request limit. A short reply is still one request at the same cost.
- On the standalone gateway, requests that normally use the compatible endpoint (normal and buffered profiles in full mode) switch to the native API. Requests the native API cannot carry without loss, such as ones with `logprobs`, keep the single-request limit, with `x-gemini-long-decode: false`.
- A custom upstream gets the client's limit unchanged; whether it supports that is up to the upstream.
- TauriTavern: not available, and the limit stays 65,536. TauriTavern's backend sends the request, so the extension cannot follow continuation tokens.

### Compatibility risks

Before turning it on:

- **Anti-truncation has not been tested with a real long reply.** Streaming anti-truncation assumes the continued request carries on with the same function argument. If Google restarts it or changes its structure, the reply ends with an error starting with `anti_truncation_native_`; incomplete text is not reported as a complete reply. How a function call spans requests in buffered mode is unknown, and may fail the same way.
- **Express, Flex and Priority on `v1beta1` are untested.** On 2026-10-20 only short requests that did not continue were sent, with a service account, Standard and `global`.
- **Cost.** Each continuation resends the full context and is billed for input again. Google's implicit caching may discount it; prices were not checked. The gateway log adds usage and cost estimates across all requests.
- **Waiting time.** The whole request, continuations included, stays within the upstream timeout: 10 minutes by default on the standalone gateway (up to 30 in settings), fixed at 10 minutes in the Tavern plugin. A very long reply may time out.
- **Failures midway.** A streamed reply cannot take back what it already sent and ends with an error event; a unary reply fails as a whole and the written text is not delivered. Nothing is retried automatically. A continuation that produces no output stops the loop with `long_decode_no_progress`.
- **Overall limit.** What Google does when input plus output exceed the model's total limit is untested.

### Validation status

Offline tests with simulated responses cover the cap for each entry point, joining unary and streamed continuations, failed continuations and the no-progress stop. Only short live requests were sent on 2026-10-20 (service account, Standard, `global`, three before and three after combining the release code, about 140–185 input and 20–45 output tokens each): with long decode on, streamed and unary `v1beta1` requests accepted a 100,000 limit and finished in one request; with it off, a buffered request was sent with 32,768 and succeeded. A reply that actually continues across requests has not been tested live; the behavior will be adjusted from feedback by users who need long outputs.

## Local errors

| HTTP 400 code | Action |
| --- | --- |
| `invalid_gemini4_thinking_level` | Use low, medium or high; use `thinking_level` inside an explicit Google config. |
| `unsupported_gemini4_thinking_budget` | Remove the numeric budget and use a thinking level. |
| `unsupported_gemini4_cached_content` | Remove the explicit cache reference. |
| `gemini4_long_decode_required` | Returned only by a gateway or Tavern server plugin from before this change. Update, or lower the limit to 32,768 (unary) / 65,536 (streaming). |
| `invalid_tool_history` | Restore the complete tool-call ID returned by the server before resending. |

## Parent router

[LLM Subscription Router](https://github.com/ken050210/llm-subscription-router) adds `gemini-4-argon`, `抗截断-gemini-4-argon` and `实验性-流式抗截断-gemini-4-argon`. The tracked template and existing runtime configuration are separate: pulling source does not replace runtime configuration. Reuse your Vertex account and route when adding these models. The parent's ordinary OpenAI-compatible account type permits custom upstream URLs; this standalone gateway now supports an OpenAI-compatible [custom upstream](GATEWAY.en.md#custom-upstream) too.

## Sources and validation

- [Vertex Gemini 4 guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon)
- [Vertex migration checklist](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/migrate)
- [Gemini API model guide](https://ai.google.dev/gemini-api/docs/latest-model)

[Validation results](VALIDATION.en.md) distinguish local tests, bounded live calls, Express entitlement, installed Tavern interaction and long-form quality.
