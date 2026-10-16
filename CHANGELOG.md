# Changelog

[中文](CHANGELOG.zh-CN.md) | English

## Unreleased — anti-truncation requests can hit the Vertex cache

Available from `main` (2026-10-16); versions are unchanged. The standalone gateway, the SillyTavern server plugin and the TauriTavern adaptation all include it.

- The synthetic anti-truncation tool is now always named `router_emit` instead of a fresh random name per request (`router_emit_` plus 24 hex digits). Tool declarations sit near the start of the prompt, so a changing name made every request start differently: Vertex implicit caching never matched, and character settings and chat history were billed at full price every turn. Requests that carry client tools already bypass anti-truncation, so the fixed name cannot collide with a real tool.
- Continue no longer switches to a different tool description; only the final instruction differs, so it shares the cache with ordinary requests.
- Live comparison (Gemini 3.7 Flash, a ~30k-token conversation): after the change, every request from the second on reused about 80% of the prompt (24,501 of 30,430 tokens); before it, all three requests reused none. Caching remains Vertex's decision: a ~6k-token prompt was not cached even when identical and sent without tools. See [Validation](docs/VALIDATION.en.md).
- Presets or cards that change the front of the prompt every turn still get very few cache hits. In a real Tavern test (Gemini 4 Argon, a large preset of about 136k tokens and a card with an MVU status table), resending the same prompt reused 98.5%, but every normal turn reused nothing: the status table updates each turn and sits before the chat history, and Vertex does not reuse a cache when the prompt changes partway through. For normal turns to hit, the preset or card must put the content that changes each turn after the chat history and keep it short; the plugin cannot change this.
- Update the half that actually runs: the server plugin in SillyTavern (a Git install updates itself when Tavern starts), the extension in TauriTavern, or the gateway source or image.

## Standalone gateway 0.8.0 — Docker deployment

- Publish Node 24 Linux images on GHCR for amd64 and arm64, with `latest`, `0.8.0` and commit tags. The default Compose file pulls the image; `compose.build.yaml` enables a source build. Includes a persistent settings volume, non-root execution, a read-only root filesystem and a local liveness check.
- Native installs keep their loopback default. Container listening and explicit console/API public URLs support mapped ports and HTTPS reverse proxies while retaining Host/Origin, session and CSRF checks.
- Add bilingual deployment instructions and an isolated Compose smoke test for setup, authentication, persistence across recreation, service networking, CJK rendering and shutdown. No real inference is part of this test.

## Unreleased — update experience

Available from `main` (2026-10-14); the version stays 0.4.0.

- The extension no longer requires the server plugin to report exactly its own version, only 0.3.1 or later. SillyTavern auto-updates a Git-installed server plugin on every start but never the extension, so after each release those users used to hit a version mismatch that blocked Continue and image input.
- The panel now tells a missing server plugin from an outdated one and gives the update steps for each install method; when the versions differ but are compatible, a manual check suggests updating the older half.
- The Tavern guide's update section now explains, per install method, how to update and what Tavern updates on its own.

## SillyTavern integration 0.4.0

The standalone gateway stays at 0.7.0. Tag `sillytavern-v0.4.0`. Both halves now read 0.4.0; when upgrading from 0.3.x, update both together, since the panel reports a version mismatch while only one half is updated.

- Releases the two sections below: the TauriTavern adaptation and the Tavern plugin part of the Gemini 4 Argon adaptation.
- The one-step package matches the release commit on `main`. It also works for SillyTavern in Termux; TauriTavern does not use the package.
- See [validation](docs/VALIDATION.en.md).

## TauriTavern adaptation

Released in SillyTavern integration 0.4.0. See the [TauriTavern section (Chinese)](docs/SILLYTAVERN.md#tauritavern).

- The UI extension now works on its own in [TauriTavern](https://github.com/Darkatse/TauriTavern), which cannot run the server plugin. There the extension shapes the request and restores the reply itself: the transport instruction is appended to Tavern's own Vertex request and the native `tools`/`toolConfig` travel in its Additional Parameters. TauriTavern keeps the credentials, prompt conversion, sampling and thinking settings.
- Both transport modes read Google's raw streaming events as TauriTavern forwards them, so native finish codes are kept; buffered mode does not stream arguments and delivers one checked, complete reply. Unicode input and the Continue adaptation work; image input does not. YAML Additional Parameters for Vertex cannot be merged, so that request uses plain Vertex and the panel says why.
- `anti-truncation`, `vertex-text-stream`, `vertex-protocol` and `gemini4` no longer import `node:crypto` at module top level, so a WebView can load them. Gateway and SillyTavern server-plugin behaviour is unchanged.
- Add an [install guide for AI agents (Chinese)](docs/AGENT-INSTALL.md) and a "Which one to install" section at the top of both READMEs: how to tell SillyTavern from TauriTavern, a command-line-only install, what to ask the user and how to check the result. The Tavern guide gains command-line equivalents for its UI steps and notes that the Release ZIP predates `main` and that the packaged UI folder cannot be used in TauriTavern. A new section covers phones: SillyTavern in Termux and the TauriTavern app.
- 202 local tests passed. The extension completed six requests against a simulated Tavern route in a Chromium engine and loaded in a local TauriTavern 2.1.1 and 2.3.0. Six live Vertex requests (Gemini 3.7 Flash) covered streaming, buffered, Continue and output-limit cases; their bodies were built by a script following TauriTavern's source, so a request sent by its own backend remains unverified. See [validation](docs/VALIDATION.en.md).

## Gemini 4 Argon

The Tavern plugin part is released in SillyTavern integration 0.4.0; the gateway part is a `main` source update from 2026-10-14 and the gateway version stays 0.7.0. Use the [source update instructions](docs/GEMINI4.en.md#updating).

- Adapt `gemini-4-argon` across normal, buffered and native-streaming profiles, and the SillyTavern Vertex plugin. Use thinking levels instead of numeric budgets, filter documented unsupported parameters and extend the optional text-prefill conversion.
- Preserve native function-call IDs together with thought signatures. Reject explicit caching, numeric thinking budgets and limits requiring unimplemented continuation-token long decode before inference.
- 191 local tests and three bounded live gateway requests passed; native streaming delivered seven content-bearing reads. Express is covered by mocks. See [validation](docs/VALIDATION.en.md) for exact boundaries.

## SillyTavern integration 0.3.1

The standalone gateway stays at 0.7.0. Tag `sillytavern-v0.3.1`.

- Tavern Continue requests use a suffix-only transport instruction with Continue prefill on or off, buffered or streaming anti-truncation, and image input. Existing messages and Tavern's continuation nudge are preserved, and Tavern still appends the reply. No automatic retry or additional model turn is introduced.
- Fix streaming anti-truncation arriving all at once in Tavern. Tavern's global `compression()` compressed the plugin's `text/event-stream` reply and held it until the end; streamed replies now send `Cache-Control: no-store, no-transform`, so text reaches the page as Vertex produces it. All earlier plugin versions are affected.
- Continuation is identified by `type: "continue"`, not by an assistant-role preset. Ordinary requests and tool/Schema bypasses keep their behavior. Both plugin halves must match; the panel reports adaptation after the server confirms it.
- New one-step package: `npm run package:sillytavern` now includes an installer (double-click `install-windows.cmd` on Windows, `sh install.sh` elsewhere). One run places the server plugin and UI extension, installs the image renderer, and enables server plugins in `config.yaml` after backing it up. It stops without overwriting or deleting anything when it finds a Git or manual copy. Covered by temporary-directory tests and one install-and-update run with `npm ci` against a simulated Tavern folder; not yet installed into a real Tavern.
- Passed 183 local tests and 60 offline cases using Tavern's actual prompt converter. Six live Gemini 3.7 Flash / Standard requests through an isolated backend reused Tavern's credentials: every suffix matched exactly without repeating the prefix, and both native streams delivered seven content chunks. Tavern's configuration, credentials and settings files stayed unchanged. This short-text check does not establish open-ended or long-context continuation quality; live Tavern page interaction remains unverified.
- The streaming fix was reproduced with Tavern's own `express` and `compression()` and a simulated upstream sending ten pieces over 3 seconds: before the fix the reply arrived in one read after 3.2 seconds, after it in 11 reads starting at 26 ms. Installed into a running SillyTavern 1.19.0, the plugin reports 0.3.1 ready. A real Vertex reply streaming in the Tavern page has not been observed yet.

## 0.7.0 (experimental)

Fixes and refinements after 0.6.0. The SillyTavern plugin stays at 0.3.0 (tag `sillytavern-v0.3.0`).

- **Provider error details.** Provider HTTP errors (`upstream_http_error`) and provider error events that arrive before any output (`upstream_stream_error` from the compatible endpoint, `native_stream_error`) now include `upstreamError` in the client error: Google's status, its ErrorInfo reason and the error message with markup, email addresses, key-like strings, long tokens and the request's own credential removed, capped at 240 characters. Logs and the event list keep only the status and reason. On native routes, `responseIntegrity.nativeFinishReason` records Google's own finish code, such as `MALFORMED_FUNCTION_CALL`.
- **Clearer failures.** New error codes: `credential_error` (502: the token exchange failed, or the key or token contains characters that cannot be sent in an HTTP header), `upstream_unreachable` (502: DNS, connection, TLS or proxy failure) and `image_render_failed` (503: local rendering failure). `upstream_protocol_error` now means only a genuine protocol or stream violation. A broken or stalled error body no longer hides the provider status or `Retry-After`: the error body is read for at most about 5 seconds, with or without prompt retry. An oversized request now actually receives `413 request_too_large`; an upload that never finishes ends with `504 upstream_timeout` at the deadline.
- **Streams.** On native routes and buffered SSE replies, the empty-choices usage chunk is sent only when the request sets `stream_options.include_usage: true`. `router_anti_truncation` now arrives on the finish chunk instead of a separate empty-choices chunk.
- **Native translation.** A parameterless function call without `args` is accepted. Only leading system/developer messages become `systemInstruction`; later ones are sent in place as user text. Images in system/developer messages return 400. An image's `detail` sets the request-wide media resolution only when every image asks for the same level. `unsupported_native_schema` paths now name the tool's index and the node that holds an unresolved `$ref`.
- **Credentials and settings.** The gateway key must be 16–512 visible ASCII characters with no spaces; Express API keys and access tokens containing non-ASCII characters (such as smart quotes) are rejected when saved. A failed early token refresh keeps using the still-valid cached token. An invalid environment value no longer blocks the console: environment settings are ignored and the reason is shown. The first save stores only the selected mode's credential, and a checkbox can delete the other modes' saved credentials. Changing the gateway key signs out other console sessions; the first save also signs out other sessions opened with the setup link, and other saves keep sign-ins. After an API port change, the old port answers `503 gateway_port_changed`. `npm run gateway` without any credential variable now names the variables to set.
- **Upgrade note.** A gateway key, Express API key or access token saved earlier with non-ASCII characters (including letters such as `é`) now stops the gateway from starting, both at console autostart and with `npm run gateway`. The console still opens: sign in with the old key and save a visible-ASCII replacement.
- **Console.** Chinese messages for more errors. The connection test shows the transport, the failure cause and the request ID, and no longer stops at Node's default 300-second wait. The request log shows Unicode and image-input results and readable transport labels. The region chosen before Express, Flex or Priority forced `global` comes back, and an unsaved draft survives a session expiry. Screen-reader and contrast fixes.
- **Input encoding.** Image pages are now lossless WebP instead of PNG: the pixels are identical and full pages are smaller. Line wrapping no longer blocks the event loop for seconds on long text, and text never runs past the page edge. Invisible format characters (ZWSP, ZWNJ, WJ, BOM, VS15) no longer reject a request. In `all` mode a trailing Gemini 3.7/3.8 text prefill becomes a user turn before rendering. Unicode input leaves matches inside tags or existing `⟦U:…⟧` blocks elsewhere in a message unchanged; only complete one-line tags in the surrounding text count for this.
- **SillyTavern integration.** The panel shows the image page count, says when nothing was converted and when an image request is still delivered without streaming, and names the cause when image input refuses a request. Before an image request, the frontend checks that the server plugin's version matches. Plain anti-truncation requests over 8 MiB use Tavern's own route.
- **Tooling and docs.** CI adds macOS, the minimum supported Node.js 22.9.0 and a 15-minute job limit. `Start-GUI.cmd` checks for Node.js 22.9+ first. The release check detects more credential and path leaks, including this package's gateway-key format. The docs add proxy setup (`NODE_USE_ENV_PROXY`), first-run import from the environment, how to report a security problem and the credit to 灰鸠「GoldRush」 for the Unicode encoding rules.
- Checked with local tests and simulated upstreams only; no live Google, proxy, browser or SillyTavern check has been made for these changes yet. See [validation](docs/VALIDATION.en.md).

## 0.6.0 (experimental) / SillyTavern integration 0.3.0

- Add an installable SillyTavern integration: a UI extension and a server plugin add the anti-truncation selector to Tavern's own Google Vertex AI connection panel, reuse Tavern's saved credentials and run inside the Tavern process. It is off by default. Install and update both halves together; the panel checks that their versions match. See the [guide (Chinese)](docs/SILLYTAVERN.md).
- Add opt-in Unicode input. The default-off `UNICODE_INPUT` switch applies to all models and encodes the Han characters and ASCII letters of the latest real user floor as `⟦U:…⟧`. Clients must send `router_unicode_input.user_floor`: a missing floor returns `400 unicode_floor_required`, and an encoded request over the size limit returns `413 unicode_input_too_large`. A Tavern Helper script supplies the floor for custom API connections. See the [acceptance record](docs/UNICODE-INPUT-AUDIT.md).
- Add opt-in current-turn/all-conversation text-to-PNG input, mutually exclusive with Unicode; preserve system instructions and tool contracts.
- Bundle Noto CJK font and canvas runtime dependency; package dependency lock and font license.
- Bound rendering and fail explicitly on unsupported input; keep fixed-field diagnostics. See [image input validation](docs/IMAGE-INPUT-VALIDATION.md).
- The Tavern panel uses one 输入转码 (input encoding) selector with off, Unicode, image (current turn) and image (whole conversation), so Unicode and image input stay mutually exclusive.
- Fixes: on the streaming anti-truncation path, native prompt blocks with codes such as `OTHER` or `JAILBREAK` are reported as `content_filter` instead of `error`, and `native_finish_reason` keeps Google's original code. SSE parsing accepts CRLF and mixed line endings, including a CRLF split across chunks. Concurrent recovery of a stale settings lock is serialized, so one writer cannot delete another's new lock. Cancellation and the deadline also stop waits for authentication and the request body. See the [2026-09-30 review (Chinese)](docs/AUDIT-2026-09-30.md).
- Pass 135 local tests and 85 release-file checks. See [validation](docs/VALIDATION.en.md).

## 0.5.2 (experimental)

- A settings lock left behind by a process that exited mid-save no longer makes every later save fail: locks older than a minute are cleared. Saving while another process saves shows a Chinese message in the console.
- The connection test shows the actual tier the compatible endpoint reports (for example `ON_DEMAND_PRIORITY`) instead of "not reported", matching the request log.
- The console opens when `GUI_PORT` is 80 instead of answering every request with 403.
- Document that `UPSTREAM_TIMEOUT_MS` is also the total limit for one request: a stream still running at that point is cut off and logged as `504 upstream_timeout`. The README and the console's timeout hint say so; behavior is unchanged.
- Tidy the code: one shared SSE parser replaces five separate ones, native request translation now sits next to the checks that decide whether a request translates without loss, and unused code and exports are removed. Client-visible behavior is unchanged except that an SSE event over 2 MiB reports `sse_event_limit` everywhere and compatible streams no longer carry a stray blank line before each event.
- Pass 85 local tests, 58 release-file checks, an old-vs-new comparison over 768 split streams and 12 bounded live requests. See [validation](docs/VALIDATION.en.md).

## 0.5.1 (experimental)

- Priority with a service account or access token now uses the OpenAI-compatible endpoint, like Standard. Requests there no longer fail with `unsupported_native_fields`; "streaming" mode still uses native progressive output, and Express and Flex remain native-only.
- Read the actual tier from `usage.extra_properties.google.traffic_type`, where the compatible endpoint reports it, so Priority logs show `ON_DEMAND_PRIORITY` instead of an unknown tier.
- Pass 84 local tests, 57 release-file checks and two bounded live Priority requests. See [validation](docs/VALIDATION.en.md).

## 0.5.0 (experimental)

- Make prompt-submission retry rules configurable: one rule per line in the console, or `GEMINI_PROMPT_RETRY_MATCHES` separated by `|`. Rules are case-insensitive substrings; the default is only "The prompt could not be submitted". Matching now also reads OpenAI-compatible `refusal` fields, where Vertex's compatible stream reports this block, and native `promptFeedback` block reasons. Generated text is still never scanned.
- Drop fields Google documents as unsupported before the first submission, for example penalties, candidate count and sampling on Gemini 3.7/3.8 Flash. The `x-gemini-dropped-params` header and `droppedParams` log field list the removed names.
- `UPSTREAM_TIMEOUT_MS` now bounds waiting for response headers and between body chunks. Node's built-in fetch previously stopped after 300 s regardless of the setting.
- Report specific anti-truncation restoration codes instead of a generic protocol error.
- Pass 83 local tests, 57 release-file checks and one bounded live streaming request. See [validation](docs/VALIDATION.en.md).

## 0.4.1 (experimental)

- Distinguish missing messages, invalid message types and unexpected streaming chunks from invalid candidate objects. Preserve the failing candidate's known finish reason without accepting malformed output.
- Keep non-streaming and buffered validation metadata when errors reach the gateway handler. Empty replies retain their classification; client errors and console events expose the same fixed diagnostics without recording private content.
- Verify that enabled prompt recovery preserves unmatched response bytes, including fragmented Unicode and bodies beyond the inspection limit. These errors do not trigger text insertion or extra submissions.
- Pass 77 local tests and 56 release-file checks. This update fixes diagnostics; it cannot recover an upstream response that contains no message.

## 0.4.0 (experimental)

- Add independently configurable model visibility, Gemini 3.7/3.8 Flash text-prefill conversion and one-time prompt submission recovery. Visibility and prefill conversion default on; recovery defaults off and requires custom text.
- Preserve disabled profiles in the console while excluding them from client model lists. A known upstream 401 also hides the shared connection; transient failures remain visible.
- Recover matching HTTP, HTTP-200 JSON and initial SSE errors before client output, using the same model, credentials and service tier. Insert user text after leading system/developer messages; never retry after content starts or loop on a second rejection.
- Add a persistent text editor, approximate token/UTF-8 counts, validation, request-log indicators and explicit test cost limits. Custom text and credentials are excluded from logs.
- Pass 74 local tests plus isolated console save/reload, hidden-model, retry-log and responsive theme checks. No paid inference was performed for this update. See [validation](docs/VALIDATION.en.md).

## 0.3.1 (experimental)

- Validate ordinary, tool and restored completions, including every streaming candidate's finish reason and DONE. Empty replies, malformed tool arguments, upstream error events and interrupted streams fail without automatic replay; length limits and refusals remain visible.
- Use native JSON Schema fields to preserve closed objects, property names, nullable values, local references and unconstrained arrays. Reject unsupported constraints locally with a parameter path, then validate completed native structured output without repairing it.
- Add response-integrity metadata and console labels linked to request IDs. Logs still exclude prompts, replies, tool arguments and credentials.
- Pass 53 local tests and three bounded live Gemini 3.8 requests: Standard normal, progressive anti-truncation, and Flex strict Schema. See [validation](docs/VALIDATION.en.md) for the scope and remaining limits.

## 0.3.0 (experimental)

- Fetch and search Google's paginated Gemini publisher catalog using the selected credentials; explain access failures and support manual model IDs.
- Save up to 100 named model profiles, including normal, buffered anti-truncation and streaming anti-truncation variants of one upstream model. Existing aliases and behavior are preserved on upgrade.
- Expose saved aliases through `/v1/models`, route requests by alias, and return the selected alias in JSON/SSE responses. Buffered profiles make a non-streaming upstream request even when a client expects SSE.
- Select profiles in the console test page and client setup; include model, mode and upstream ID in request logs.
- Keep provider authentication failures separate from local sign-in, and reject interrupted/error SSE responses for normal profiles too.
- Verify discovery, pagination failures, migration, persistence and transport combinations with local fixtures. No real inference was performed for this update.

## 0.2.0 (experimental)

- Add a local console with overview, connection settings, request logs, bounded tests, light/dark themes and responsive layout.
- Support target project IDs, complete service-account JSON paste/import, Express API keys and existing OAuth tokens.
- Add explicit Standard / Flex / Priority selection with native regular/streaming requests and separate requested/actual tier metadata.
- Persist configuration outside the repository with revision checks, write-only secrets and hot application that preserves active replies.
- `npm start` launches the console; `npm run gateway` retains CLI-only operation. Windows users can run `Start-GUI.cmd`.
- Add local protocol, security boundary and persistence tests. GUI/tier combinations were validated with local fixtures; no paid upstream tests were run for this release.

## 0.1.0 (experimental)

The first standalone release extracts the Gemini 3.7 Flash text-tool transport from a local Node.js router.

- Supported streaming requests use native Vertex `partialArgs` and deliver ordinary OpenAI SSE text during generation.
- Requests retain the compatible fallback when translation would drop fields. Existing client tools, structured output and other conflicts skip wrapping.
- Request logs record restoration, finish reason and stream completion, linked to the response request ID.
- The package includes setup instructions, SillyTavern settings, local protocol tests and bilingual documentation.
- [Xeltra233 / Antigravity-gateway](https://github.com/Xeltra233/Antigravity-gateway) is credited for the transport design, with its MIT license preserved.

The default checks use simulated upstream responses. See [validation](docs/VALIDATION.en.md) for what has and has not been tested.
