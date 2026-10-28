# Validation

[中文](VALIDATION.md) | English

## Standalone gateway 0.12.0: account rotation (2026-10-29)

Windows / Node.js 24.16.0: all 251 offline tests passed. New fixtures use synthetic credentials, temporary configuration directories and local mock upstreams. Coverage includes default-off behavior, sequential/concurrent distribution, failure thresholds and cooldown, all accounts unavailable, success resetting failures, configuration replacement resetting the pool, invalid input without failover, authentication timeout with no submission after late credentials resolve, overall deadlines and client cancellation without retry, stalled response-body failover, no replay after streaming starts, and OAuth-to-Express switching with rebuilt URL, headers and native request body. Console tests cover save/reload, credential redaction, blank retention and account removal.

An isolated console started with rotation off. Adding a synthetic account and saving a 25-second timeout persisted across reload; the credential field was blank with its saved indicator and runtime status listed both accounts. Desktop dark at 1280 pixels and mobile light at 390 pixels showed no horizontal overflow or browser errors. Daily configuration and the running production instance were unchanged.

Release-file syntax and credential/private-path scans passed in a clean release snapshot.

No real inference, multi-account quota or billing validation was performed. Cooldown is local failure scheduling, not a balance check. Retried attempts may already incur upstream charges; estimates do not aggregate failed-attempt usage. Docker and cross-platform verification are recorded by this version's GitHub Actions runs.

## Standalone gateway 0.11.0 and SillyTavern integration 0.6.0: Gemini 4 Argon output limits and long decode (2026-10-20)

All 237 offline tests passed. New and rewritten coverage:

- Caps: Express and full mode on the standalone gateway × normal, buffered and streaming profiles × client streaming on/off × `max_tokens` and `max_completion_tokens`, 24 combinations, each with one upstream request and matching headers and logs; a custom upstream at 32,768 with long decode off and unchanged with it on; the Tavern plugin's connection test (quiet), buffered and image-input requests; TauriTavern at 65,536.
- Long decode: three unary requests joined; two streamed requests joined (with a mid-stream checkpoint token, usage added up and a single finish reason); a failed later request; an interrupted request that is not continued; the no-progress stop. On the gateway, the native API, full mode switched from the compatible endpoint to the native one, and a streamed anti-truncation argument joined across requests; in the Tavern plugin, the URL and limit with the option off and on.
- The streamed anti-truncation cases assume the continued request carries on with the same function argument; that has no live evidence.

Live requests (short requests permitted by the user, reusing the service account from the local environment, credentials unchanged): 3 calls, Gemini 4 Argon, `global`, Standard, LOW thinking, a client limit of 100,000 and a prompt asking for one word.

| Request | Result |
| --- | --- |
| Long decode on, streaming anti-truncation | `v1beta1` streamGenerateContent accepted `maxOutputTokens` 100,000; one request, restored to OK, stop; 181 input and 42 output tokens |
| Long decode on, buffered (full mode switched from the compatible endpoint to native) | `v1beta1` generateContent accepted 100,000; one request, OK, stop; 185 input and 44 output tokens |
| Long decode off, buffered | `v1` compatible endpoint with `max_tokens` 32,768; one request, OK, stop; 185 input and 44 output tokens |

After the fixed tool name was merged, the same 3 requests were sent again with the release code: URLs, limits and finish reasons matched the table, with 140 input and 22 output tokens each (the tool description is shorter). The gateway's built-in prices estimate about USD 0.004 for both rounds. Not covered: a reply that continues across requests, Express/Flex/Priority on `v1beta1`, live Tavern plugin requests, the installed Tavern interface, TauriTavern on a device, and long-form quality.

## Docker gateway 0.8.0 (2026-10-16)

All 206 offline tests passed on Windows and inside a Linux amd64 container. Compose checks cover initial setup, Host/Origin/CSRF and API authentication, published ports, service-name networking, non-root/read-only operation, CJK WebP rendering, persistence across recreation, health and graceful shutdown. The ARM64 image also receives a locally emulated Compose check; this is not an ARM hardware performance test.

Live validation used an isolated amd64 container with a read-only mount of the user-authorized local service account, Gemini 3.7 Flash, global and Standard. Three sequential requests were capped at 512 output tokens each, with prompt retries disabled. Credentials were not copied into the repository or image; the file hash was unchanged and the test containers were removed.

| Path | Result and evidence boundary |
| --- | --- |
| JSON reply | Client checks passed: nonempty content, restored=true, finish_reason=stop |
| Native streaming | Client checks passed: 7 content events/reads, first content at about 50.88 seconds and a 414 ms content span, DONE received, restored=true and stop |
| CJK text rendered as an image, non-stream reply | HTTP 200; the completed gateway event records one encoded page, restored=true, stop and complete nonempty content; about 3.80 seconds |

For the original third request, the temporary harness incorrectly expected the streaming fallback label `tool-transport-buffered-fields` instead of the correct non-stream label `tool-transport`. It failed before reading the body. The exact `DOCKER_OK` reply was not checked at that time, and no automatic retry was made; that request's successful completion was supported only by its gateway event.

### Image reply body follow-up (2026-10-16)

After separate user authorization, the corrected harness was saved as `scripts/docker-image-live.mjs`. It sends exactly one image request, captures the complete response body before assertions, then checks the non-stream transport, reply content and gateway event with the same request ID. Every failure stops without retrying. Five offline regression cases cover success, a wrong transport label, extra reply text, a mismatched event and an HTTP failure, including body retention on failure. The former temporary entry point now delegates to this single-request script.

One live follow-up used the published `ghcr.io/ken050210/vertex-streaming-anti-truncation:0.8.0` image with the same local service account, Gemini 3.7 Flash, global, Standard, a 512-output-token cap and prompt retries disabled. The Chinese prompt was “请只回复英文标记 DOCKER_OK，不要解释。” (reply only with the English marker DOCKER_OK, without explanation).

| Check | Observed result |
| --- | --- |
| Image input | `encoded`, `all` mode, one WebP page, 19,112 bytes |
| Client response | HTTP 200, `tool-transport`, body content exactly `DOCKER_OK` |
| Restoration and completion | `restored=true`, `finish_reason=stop`; `request_complete` event and `complete` integrity |
| Correlation | `416c71b0-4b4f-483b-bc30-c8f3db68b0e1`; exactly one generation event in the isolated gateway, `promptRetried=false` |
| Timing | Completed at 2026-10-15 23:35:18 UTC; 4,082 ms server latency, 4,108 ms client time including event checks |
| Cleanup and credentials | Test container removed; credential mounted read-only with an unchanged file hash |

The full body and event are retained locally in the ignored file `runtime/docker-image-live-result-2026-10-16.json`. Following this harness fix, `npm run verify` passed 115 release-file checks and 211 offline tests. This follow-up validates a short image request and its reply body on the published image; it does not establish long-form quality, browser acceptance or compatibility with every reverse proxy.

To run this check yourself, first pull the image above and explicitly provide credentials. This sends one real request:

```sh
node scripts/docker-image-live.mjs --live --credentials /absolute/private/service-account.json
```

The receipt defaults to a unique file under `runtime/`. Use `--report <path>` to select another receipt path and `--image <reference>` to select an image already present locally. Normal `npm run verify` does not send live requests.

Local fixtures, live standalone requests and historical router checks cover different parts of the system.

## Update experience (2026-10-14, main source update)

From the SillyTavern 1.19.0 source: `enableServerPluginsAutoUpdate` (on by default) runs `git pull` on Git-installed server plugins at every start; third-party UI extensions update automatically only when their manifest sets `auto_update` and Tavern's own version changed. This extension does not set it, so it is only updated by hand.

`npm run verify` passed the check of 101 release files and 203 tests, including a new unit test of the version rule. The real extension entry ran in the Claude desktop app's built-in Chromium browser against a simulated status endpoint: with no server plugin it asked for an install and blocked Continue; 0.3.0 was reported as too old with the update steps for both install methods, and Continue was blocked; 0.3.1, 0.4.0 and 0.5.0 all let Continue through, and a manual check suggested updating the server, reported it ready, or suggested updating the extension respectively. Not observed in a real Tavern.

## TauriTavern (2026-10-14, released in SillyTavern integration 0.4.0)

`npm run verify` passed the check of 101 release files and 202 tests. The 11 new tests in `test/tauritavern.test.mjs` use a simulated Tavern route and cover: the request staying on Tavern's own route with its headers and abort signal, native tool fields in Additional Parameters, merging existing JSON parameters and bypassing YAML ones, piece-by-piece restoration (the first piece arrives before the upstream ends), JSON and buffered-SSE delivery, native finish codes for length limits, five interrupted/malformed/upstream-error cases that neither report success nor echo provider error text, Tavern's own error text, cancellation without an error event, Continue, the Argon output limit before sending, and the absence of Node-only imports in everything the extension loads.

Browser engine: the real extension entry `index.js` was loaded in the Claude desktop app's built-in Chromium browser with stand-ins for the host globals and Tavern's route. The panel offered only off/Unicode input and no plugin check button. Six simulated requests covered streamed restoration, buffered JSON, buffered SSE, an interrupted stream (error event), an interrupted buffered reply (HTTP 502 with the code in the panel) and Tavern's error text.

Local TauriTavern (Windows portable), once on 2.1.1 and once on 2.3.0: after copying the extension into the user's extension folder and starting the app, Tavern's saved settings contained this extension's defaults (removed before the 2.3.0 start and written again after it), so the entry module and its imports evaluated in WebView2 and mounted on the Vertex panel. No generation request was sent there and no credentials or connection settings were changed.

The user confirmed by eye that the transport selector appears on the Vertex panel in TauriTavern 2.3.0.

Live Vertex requests (approved by the user, reusing SillyTavern's saved service account without changing it): six, on Gemini 3.7 Flash, global, Standard, at most 1024 output tokens each, fixed short prompts, no retries, about 6.8k tokens in total. Interception, request shaping and restoration ran this repository's code. TauriTavern's Rust backend was not in the loop: a temporary script built the Vertex body by the rules of its v2.3.0 source (consecutive same-role turns kept separate, ten safety settings, thinking level, Additional Parameters replacing top-level fields) and forwarded Google's events in its route's framing. Google accepted all six bodies; every event carried `role` and fields such as `modelVersion`/`responseId`, and none was mistaken for Tavern's error text.

| Request | Result |
| --- | --- |
| Streaming transport, Tavern streaming | 309 characters identical to the sample; nine argument pieces from Google, eight content-bearing reads, first content at about 2.70 s over about 855 ms; STOP, restored=true |
| Buffered transport, Tavern non-streaming | One complete function call over the streaming route; JSON content identical, stop/STOP, thoughts kept |
| Buffered transport, Tavern streaming | Identical, delivered in one read, STOP |
| Continue (nudge prompt), streaming | Only the suffix (a newline plus the last six lines, equal to the sample when appended), nothing repeated; the panel reported the suffix request |
| Output limit 300, streaming | 329 characters delivered, identical to what the model had written into the arguments and a prefix of the sample; the ending stayed MAX_TOKENS, no STOP |
| Output limit 300, non-streaming | Google returned thoughts and MAX_TOKENS without a function call; the extension returned empty content with `length`/MAX_TOKENS, not a completed reply |

These are single short samples, not benchmarks of speed, long output or open-ended writing.

Read from source, not observed at runtime: TauriTavern v2.1.1, v2.3.0 and `main` (2026-10-10) all apply Additional Parameters after building the upstream body and forward Vertex streaming events unchanged.

Install documentation and install paths (same day): an AI agent that had never seen the repository did a paper exercise from the docs alone, given only "install the anti-truncation plugin from this repository". The first run found no routing between the three products, the only install commands belonging to the gateway, UI-only steps for the extension and for verification, the installer's command-line usage documented only in a code comment, a packaged UI folder that cannot load in TauriTavern, and a Release ZIP sharing its version number with `main`. The docs were revised accordingly. A second run on the revised docs settled the route by the second file, produced commands matching the [install guide (Chinese)](AGENT-INSTALL.md) for all three cases (SillyTavern, TauriTavern, unknown) and did not read source code. The further gaps it reported (inconsistent version wording, handling of existing copies, confirming Tavern is closed) were also closed; no third run followed.

Install paths actually executed: from a fresh clone without `node_modules`, `node scripts/package-sillytavern.mjs` and `node dist/sillytavern/install.mjs <folder> --skip-deps` completed against a simulated Tavern folder without terminal input, with exit code 0, both halves in place and `config.yaml` backed up before server plugins were enabled. On a running SillyTavern 1.19.0 without accounts, `/api/plugins/vertex-anti-truncation/status` returned 0.3.1, ready. After `git clone --depth 1` into the user extension folder of TauriTavern 2.3.0 the extension loaded. Not executed: the installer against a real Tavern, the three commands of the Git route, TauriTavern's in-app **Install extension**, and any install on a phone (SillyTavern in Termux, the TauriTavern app). The automated tests for the installer and the TauriTavern path passed on Linux, macOS and Windows (Node.js 22.9, 22, 24) in GitHub Actions.

Not covered: a live request sent by TauriTavern's own backend (needs Vertex credentials saved there) and its piece-by-piece display on the page, Express/Flex/Priority, installing and updating through TauriTavern's extension manager, Android/iOS/macOS WebViews, and Gemini 4 Argon in TauriTavern (only its `dev` branch listed the model when checked).

## Gemini 4 Argon (2026-10-14; Tavern plugin part released in 0.4.0)

Verification passed 191 local tests. After the documentation update, the pre-commit check passed for 98 release files. New coverage includes thinking-level mapping, explicit config precedence, rejection before inference for numeric budgets/caches/long-decode limits, prefills, native function-call ID/signature round trips, and an Express/OAuth × transport × JSON/SSE mock matrix. The SillyTavern package was generated without installing it into the existing Tavern.

The user authorized at most eight upstream calls, each capped at 512 output tokens, using fixed short prompts and stopping on the first error. All eight passed with HTTP 200 and stop, without retries, on the existing service account, global, Standard. Three exercised this gateway: normal and buffered requests returned OK; the native tool stream restored 454 characters over seven content-bearing reads, with first content at 1.97 s and a 566 ms content span. These are single short samples, not performance or long-context quality benchmarks.

Five calls exercised the parent router through its existing smoke script against a temporary instance of the same source with retries disabled and a shared hard call limit. Its native tool stream delivered seven content-bearing reads over 739 ms and passed restoration audit checks. The daily Docker router was separately rebuilt and checked for health, ownership, loopback binding, controller readiness and the three new model IDs.

Live Express entitlement, Argon Priority/Flex, installed Tavern browser behavior, and long-form quality remain unverified. Continuation-token long decode is not implemented. The Tavern plugin part ships in `sillytavern-v0.4.0`; the gateway part is a `main` source update. See the [setup and update guide](GEMINI4.en.md).

## Standalone package

### SillyTavern integration 0.4.0: TauriTavern and Gemini 4 Argon adaptations (2026-10-14)

At release `npm run verify` passed the check of 101 release files and 202 tests, and the last commit before the release passed GitHub Actions on Linux, macOS and Windows (Node.js 22.9, 22, 24). The code is what the "TauriTavern" and "Gemini 4 Argon" sections above validated; both halves now read 0.4.0.

Package: the ZIP holds 63 entries, all with forward-slash paths; extracted, it matches the `npm run package:sillytavern` output file for file, with both halves at 0.4.0. Its installer ran against a simulated Tavern folder without terminal input: the first run installed the image renderer from the network, backed up `config.yaml` and enabled server plugins, exiting 0; a second run updated in place without touching `config.yaml`, exiting 0.

Not verified: the installer on a real SillyTavern or in Termux, and 0.4.0 loading in a real Tavern; the sections above list the rest.

### SillyTavern integration 0.3.1: Continue support, streaming fix and one-step installer (2026-10-09)

At release, `npm run verify` passes 93 release-file checks and 183 local tests. New fixtures cover explicit `type: "continue"`, both prefill and continuation-nudge request shapes, ordinary assistant prefills staying unchanged, refusal when the plugin version is not ready, retained Unicode status, and a single upstream call across streaming, buffered and image modes. Simulated replies verify unchanged suffix delivery, progressive arrival, preserved reasoning and usage, honest length endings and no retry on 429.

An additional 60 offline cases use the locally installed Tavern's actual `postProcessPrompt`, `convertGooglePrompt` and budget conversion code: three Gemini model IDs, none/merge/strict/single processing, system-prompt on/off, prefill/nudge forms, and image/Unicode paths. The original request stays unchanged, existing text remains in context, and the final user instruction requests only the continuation. All-conversation image mode does not reinsert plaintext to locate the continuation.

Six subsequent live requests used the saved Tavern service account with Gemini 3.7 Flash, global, Standard tier, and a 1024-output-token cap per request. An isolated loopback HTTP backend loaded the changed plugin and Tavern's actual converter. Each fixture supplied a Chinese passage and an existing prefix ending mid-sentence. All six returned HTTP 200 with an exact suffix, no repeated prefix, a `STOP`/`stop` ending and exactly one upstream submission.

| Request | Client response | Observed result |
| --- | --- | --- |
| Continue prefill + buffered anti-truncation | JSON | Restored, suffix only |
| Continuation nudge + buffered anti-truncation | Buffered SSE | Restored, one DONE |
| Continue prefill + streaming anti-truncation | Native stream adapted to SSE | 7 content reads; first at about 1777 ms, content span 545 ms |
| Continuation nudge + streaming anti-truncation | Native stream adapted to SSE | 7 content reads; first at about 1728 ms, content span 553 ms |
| Current-turn image + anti-truncation off | Buffered SSE | No eligible text to render; original text sent with the continuation instruction, one DONE |
| All-conversation image + buffered anti-truncation | JSON | Actual image input, restored, suffix only |

Reported usage totaled 4480 input, 1086 output-text and 1165 thinking tokens, or 6731 tokens overall. SHA-256 checks of Tavern's `config.yaml`, user `settings.json` and `secrets.json` matched before and after. No Tavern installation, restart or chat mutation occurred. These short completion fixtures establish transport compatibility, not open-ended story quality, long-context continuity or overall repetition rates. Live Tavern page interaction remains unverified.

**Streaming fix.** With streaming anti-truncation enabled in a real Tavern, replies still appeared all at once when generation finished. Tavern's global `compression()` compressed the plugin's `text/event-stream` reply and emitted output only when its buffer filled or the reply ended; the six live requests above used a temporary backend without compression, so they did not expose this. With the plugin mounted on Tavern's own `express` and `compression()`, a simulated upstream sending ten pieces over 3 seconds, and a client sending `Accept-Encoding: gzip, deflate, br, zstd`: before the fix the reply was brotli-compressed and read once at 3.2 seconds; with `Cache-Control: no-store, no-transform` on streamed replies it was not compressed and arrived in 11 reads from 26 ms to 3.1 seconds. The installed 0.3.0 copy reproduced the same failure. A regression test checks for `no-transform` on streamed replies.

**Installation and loading.** Both 0.3.1 halves were placed into the existing manual and Git copies of a local SillyTavern 1.19.0; after a restart, `/api/plugins/vertex-anti-truncation/status` reported 0.3.1 ready. A real Vertex long reply streaming in the Tavern page has not been observed yet. The one-step installer is covered by temporary-directory tests and one install-and-update run with `npm ci` against a simulated Tavern folder; it has not been run on a real Tavern.

### Unreleased fixes and refinements (2026-10-07 to 10-08)

At the time of writing, the working tree passes 176 local tests with `node --test test/*.test.mjs` and 88 release-file checks with `node scripts/check.mjs`. Every test uses port 0, a temporary state directory, dummy credentials and a simulated upstream; no real Google, proxy, browser or SillyTavern call was made. New fixtures cover the fields and redaction of provider error details (including the request's own credential, and stream error events from both the compatible and native endpoints), a stalled error body returning the provider status after about 5 seconds with prompt retry on or off, the first save signing out other sessions opened with the setup link, line wrapping that stays inside the page, and WebP page output. In a scratch copy, removing the two error-body timers made the stalled-body fixture time out, and restoring the earlier summed-width line wrapping let ink reach x=1023, past the 988px text edge, so the line-wrapping fixture failed.

Not yet verified: live WebP image requests on the compatible and native endpoints; a real connection through a proxy with `NODE_USE_ENV_PROXY` (the test covers only the `NO_PROXY` direct path); Google's real error envelopes and ErrorInfo reasons, and whether the 240-character cap is useful; what the compatible endpoint sends for stream usage when the request does not set `include_usage`; `MALFORMED_FUNCTION_CALL` on real Flex, Express or streaming traffic; an actual run of the new CI matrix (macOS, Node.js 22.9.0); the console with a screen reader, at narrow widths and in the dark theme; the Tavern panel's new messages, and a WebP image passing through Tavern's own `convertGooglePrompt` to Vertex.

### 0.6.0 Unicode and image input, SillyTavern integration 0.3.0 (2026-10-02 to 10-04)

At the 0.6.0 commit, `npm run verify` passes 85 release-file checks and 135 local tests (rerun on a clean export of that commit). Live evidence is small and shows only deployment and basic request/response compatibility. Unicode input passed short requests with extension UI v0.2.0 (then a separate checkbox): a temporary gateway instance in normal, buffered and streaming anti-truncation modes, and the installed Tavern in off, buffered and streaming modes. Image input had a single PNG-encoded streaming request through a local OpenAI-compatible relay to Vertex (200, stop and DONE, exact transcription), not through this gateway's own authentication path.

These checks do not establish long-context comprehension, fewer truncations, progressive delivery for image requests or reduced filtering, and live import and persistence of the UI 0.3.0 selector remain unverified. See [image input validation](IMAGE-INPUT-VALIDATION.md), the [Unicode input acceptance record](UNICODE-INPUT-AUDIT.md) and the [2026-09-30 review (Chinese)](AUDIT-2026-09-30.md).

### 0.5.2 settings lock, probe tier and code cleanup (2026-09-26)

`npm run verify` passes syntax/credential/private-path checks for 58 release files and 85 local tests. A new fixture covers stale locks: a fresh lock still returns 409, and a lock older than a minute is cleared so the save succeeds. Reverting the fix in a scratch copy made the fixture fail. Local runs confirmed that with an upstream sending a chunk every 300 ms and a 1-second timeout, the stream is cut off after about 1.1 s and logged as `504 upstream_timeout`, and that a console on port 80 answered 403 before the fix and 200 after it. In a browser against a local simulated upstream, the connection test showed `ON_DEMAND_PRIORITY` for streaming and nonstream requests, and a lock conflict showed the Chinese message.

The cleanup was checked old against new. The same SSE inputs (plain streams, partial arguments, comment lines, `\r\n` and `\r` line endings, error events, truncation, malformed JSON, data after DONE, invalid UTF-8) were fed whole, byte by byte and at random split points through every stream stage and the full gateway chain of both implementations. All 768 comparisons matched events, error codes and log metadata, and native request bodies and support decisions matched for six request shapes. The completion check now decodes invalid UTF-8 to U+FFFD like the other stages instead of failing on its own; inside the gateway it only receives text re-encoded by an earlier stage, so request outcomes are unchanged.

Twelve live Gemini 3.7 Flash requests (Standard tier, 512-token cap each) ran through an isolated loopback gateway with credentials held only in memory. Eight, before the cleanup, checked suspected problems: Vertex accepts `stopSequences: [null]` and empty text parts, so neither was changed; the four streamed replies that reached the tool call all started with it, with no plain text first; the compatible endpoint reports the tier only in `usage.extra_properties.google.traffic_type`; and three requests spent all 512 tokens on thinking and ended with `length` and no text. Four, after the cleanup, covered streaming anti-truncation (10 native partial reads), a normal stream, a normal nonstream reply and buffered anti-truncation delivered as SSE. All returned 200 with stop and logged `ON_DEMAND`, and both anti-truncation replies were restored. Express, Flex, Priority and native real-tool streams were not exercised live; the last relies on the comparison above.

### 0.5.1 Priority on the compatible endpoint (2026-09-25)

`npm run verify` passes syntax/credential/private-path checks for 57 release files and 84 local tests. A new fixture covers full-mode Priority: nonstream anti-truncation and normal-mode streams reach the compatible `/chat/completions` endpoint with both Priority headers, "streaming" mode's progressive output still reaches native `streamGenerateContent`, and the log reads the actual tier from `usage.extra_properties.google.traffic_type`. Reverting the tier-reading change in a scratch copy made the new fixture fail.

Two live Gemini 3.7 Flash requests (512-token cap) ran at the Priority tier through an isolated loopback gateway with credentials held only in memory. Nonstream anti-truncation returned 200 with stop and restored text; a normal-mode stream returned 200 with stop and DONE. Both logs recorded `ON_DEMAND_PRIORITY` with integrity outcome `complete`. Express Priority was not exercised live.

### 0.5.0 retry rules, unsupported parameters and timeout (2026-09-25)

`npm run verify` passes syntax/credential/private-path checks for 57 release files and 83 local tests. New fixtures cover refusal rejections in JSON and SSE, custom rules replacing the default, native `promptFeedback` matching, rule validation and environment parsing, documented field removal on both the compatible and native request paths, and a local server showing the dispatcher's header timeout follows its setting (100 ms fails, 5 s succeeds). Reverting each change in a scratch copy made its new tests fail.

One live Gemini 3.7 Flash streaming request (512-token cap) ran through an isolated loopback gateway with existing credentials held only in memory. It sent temperature, top_p, both penalties and SillyTavern's disabled-thinking field: the gateway removed the four documented fields up front, used native progressive streaming (7 reads), returned 200 with stop and DONE, restored the text and logged `ON_DEMAND`. No retry rule was exercised live, and no call longer than 300 s was attempted; those paths rely on the fixtures above.

### 0.4.1 completion diagnostics (2026-09-23)

All 77 local tests pass, with syntax/credential/private-path checks for 56 release files. Regression fixtures failed before the fix and now cover missing/null/wrong-type messages, delta-only non-streaming replies, the failing choice in a multi-candidate response, malformed tool arguments and unknown finish-reason redaction. Normal and buffered gateway requests preserve failure metadata in both client errors and events. Empty/reasoning-only completions retain their empty outcome. No malformed response is accepted as successful, restored or eligible for custom-text recovery.

An independent fixture confirms byte-for-byte preservation of unmatched compatible replies with recovery enabled, including fragmented Unicode, a valid answer quoting the trigger phrase and a response larger than 64 KiB. Each case makes one simulated upstream submission. No live Google inference was performed in this standalone checkout and no daily configuration or credentials were changed. Historical raw failure bodies were not retained; this update does not establish the exact upstream cause of an old `invalid_choice` event or recover absent output.

### 0.4.0 roleplay compatibility (2026-09-23)

`npm run verify` passed syntax/credential/private-path checks for 55 release files and all 74 local tests. Added coverage includes disabled profiles and upstream-401 visibility, transient failures, configuration recovery, protected 3.7/3.8 Flash prefills, JSON/SSE recovery in all three modes over compatible/native protocols, HTTP-200 error objects, fragmented SSE errors, bounded retry/cancellation/body limits, progressive output without late replay, and console persistence of 192000-byte text with JSON escape expansion.

An isolated real console with a mocked upstream verified sign-in, default toggles, a 27625-character save and page reload, disabled-profile hiding, successful recovery and its log indicator. Empty enabled-retry text displayed a validation error. Layout checks at 1280 and 390 pixels and in both themes showed no horizontal overflow; the browser reported no console errors. All credentials and replies were fixtures.

No live Google inference was performed and no daily credentials or runtime configuration were changed. Mock recovery does not establish that long custom text solves real upstream rejection or that prefill conversion preserves roleplay continuation behavior. The 0.3.x live results below are historical.

`npm run verify` runs syntax, credential and local-path checks, followed by local tests covering:

- Split JSON, escapes, Unicode, byte boundaries and parser bounds.
- Native `partialArgs` conversion, plain-text fallback, genuine tools and usage.
- HTTP authentication, model listing, field validation, Google host restrictions and request limits.
- HTTP delivery of text before the simulated upstream is allowed to finish.
- Field-preserving fallback and wrapper bypass for existing tools or structured output.
- Client cancellation, interrupted streams, upstream errors, length endings and no retries after output starts.
- Request-ID correlation and logs that exclude replies, prompts, random tool names and credentials.
- Console session, Host/Origin/CSRF boundaries, write-only credentials, revision conflicts, occupied ports, persistence and key rotation.
- Projectless Express endpoints, full service accounts with explicit target projects, Flex/Priority headers, native regular/streaming responses and actual tier logs.
- Native-only rejection of unsupported fields before inference, without automatic tier fallback.

Version 0.3.1 passes 53 local tests, adding empty/reasoning-only completions, terminal reasons for each candidate, missing DONE, invalid tool arguments, HTTP-200 error wrappers, Schema preflight and structured-output validation. Validation does not repair output; logs contain only fixed states and booleans. A desktop browser preview using the actual event-rendering functions and CSS checked seven integrity outcomes and request IDs. This was a component fixture, not a repeat of the full sign-in/configuration workflow.

Version 0.3.0 adds local tests for catalog authentication/pagination/errors, legacy migration, model persistence, alias routing, and normal/buffered/streaming modes with both JSON and SSE clients. Browser checks used a simulated catalog and upstream to save six profiles for two models, reject duplicate names, discard edits, reload saved profiles and select each mode for testing. Buffered replies arrived together; streaming replies arrived progressively. These checks do not verify real catalog permissions or model access.

The 0.2.0 browser check used isolated fixture credentials and a simulated upstream: Express/Flex save/apply, progressive text restoration, light/dark themes and narrow layouts. This does not prove live credentials, Gemini 3.7 availability or a particular account's Express/Flex/Priority entitlement.

These tests use local fixtures and make no Vertex calls. CI is configured for Node.js 22 and 24 on Linux, Windows and macOS, plus the minimum supported Node.js 22.9.0 on Linux; each job has a 15-minute limit. See [Actions](https://github.com/ken050210/vertex-streaming-anti-truncation/actions) for actual run results.

The standalone CLI was also checked on Windows with Node.js 24.16.0: health returned 200, an unauthenticated model request returned 401, and the authenticated model list was correct. The service bound to loopback. This check used dummy credentials and sent no model requests.

## Live standalone 0.3.1 requests

On 2026-09-22, an isolated loopback instance on Windows / Node.js 24.16.0 used service-account credentials held only in memory for three fixed-text Gemini 3.8 Flash requests, each capped at 512 output tokens:

- Standard normal non-streaming: HTTP 200, nonempty text and `stop`.
- Standard streaming anti-truncation: HTTP 200 and native argument streaming; 454 characters arrived in 7 content-bearing reads over 610 ms, with `restored: true`, `stop`, `[DONE]` and actual tier `ON_DEMAND`.
- Flex native strict Schema: HTTP 200 and a matching closed object. An array without `items` retained both `null` and a nested array; the response ended with `stop` and reported `ON_DEMAND_FLEX`.

All three request IDs matched their log events, with `responseIntegrity.outcome` set to `complete`. No daily settings were written and the temporary listener was closed. Live Express, Priority, other models, Google catalog permissions and SillyTavern UI behavior were outside this check.

## Live requests before extraction

On 2026-09-20, the original router integration tested the same streaming transport core with two fixed-text requests, each capped at 512 output tokens. Both the non-streaming and streaming requests returned HTTP 200, restored text and `stop`. The stream delivered content in 7 reads over 911 ms and ended with `[DONE]`. This shows that the Vertex reply arrived progressively in that run.

Those historical results belong to the original router integration and do not replace standalone checks; see the preceding section for 0.3.1 live standalone results. The default `npm run verify` continues to use only local fixtures. A health check only shows that the process is reachable.

## Check your own setup

After following the README and starting the service, run:

```sh
npm run smoke -- --live
```

This sends two client requests, each capped at 512 output tokens. With prompt recovery enabled, this can make up to four upstream submissions, and retries include the custom input text. It checks restoration for the normal reply, then checks nonempty text, `stop`, `[DONE]` and restoration for the stream. It also requires at least two content-bearing reads spanning at least 100 ms. Finally, it matches the response's `x-request-id` to `/admin/events`. With image input enabled, the command stops before sending any request, because image requests use the buffered fallback and cannot pass the streaming check.

The receipt contains metadata only. Read counts and timing depend on the model, network and buffering; one run cannot guarantee the same delivery pattern for every reply.

## What these checks do not establish

Short requests and simulated streams do not prove that long replies will avoid truncation. The gateway cannot restore content the model never generated or the network never delivered. A model may also return ordinary text directly, in which case the log reports `restored: false`.

Multiple Gemini models can now be configured; this does not establish live compatibility for every model. Compatibility with other providers, public remote deployment and other clients has not been established.
