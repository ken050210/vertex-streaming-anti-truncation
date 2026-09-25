# Validation

[中文](VALIDATION.md) | English

Local fixtures, live standalone requests and historical router checks cover different parts of the system.

## Standalone package

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

The 0.2.0 browser check used isolated fixture credentials and a simulated upstream: Express/Flex save/apply, progressive text restoration, light/dark themes and narrow layouts. This does not prove live credentials, Gemini 3.7 availability or a particular account's Express/Flex/Priority entitlement.

These tests use local fixtures and make no Vertex calls. CI is configured for Node.js 22 and 24 on both Linux and Windows. See [Actions](https://github.com/ken050210/vertex-streaming-anti-truncation/actions) for actual run results.

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

This sends two client requests, each capped at 512 output tokens. With prompt recovery enabled, this can make up to four upstream submissions, and retries include the custom input text. It checks restoration for the normal reply, then checks nonempty text, `stop`, `[DONE]` and restoration for the stream. It also requires at least two content-bearing reads spanning at least 100 ms. Finally, it matches the response's `x-request-id` to `/admin/events`.

The receipt contains metadata only. Read counts and timing depend on the model, network and buffering; one run cannot guarantee the same delivery pattern for every reply.

## What these checks do not establish

Short requests and simulated streams do not prove that long replies will avoid truncation. The gateway cannot restore content the model never generated or the network never delivered. A model may also return ordinary text directly, in which case the log reports `restored: false`.

Multiple Gemini models can now be configured; this does not establish live compatibility for every model. Compatibility with other providers, public remote deployment and other clients has not been established.

Version 0.3.0 adds local tests for catalog authentication/pagination/errors, legacy migration, model persistence, alias routing, and normal/buffered/streaming modes with both JSON and SSE clients. Browser checks used a simulated catalog and upstream to save six profiles for two models, reject duplicate names, discard edits, reload saved profiles and select each mode for testing. Buffered replies arrived together; streaming replies arrived progressively. These checks do not verify real catalog permissions or model access.
