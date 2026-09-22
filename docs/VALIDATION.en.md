# Validation

[中文](VALIDATION.md) | English

Local fixtures, live standalone requests and historical router checks cover different parts of the system.

## Standalone package

`npm run verify` runs syntax, credential and local-path checks, followed by local tests covering:

- Split JSON, escapes, Unicode, byte boundaries and parser bounds.
- Native `partialArgs` conversion, plain-text fallback, genuine tools and usage.
- HTTP authentication, model listing, field validation, Google host restrictions and request limits.
- HTTP delivery of text before the simulated upstream is allowed to finish.
- Field-preserving fallback and wrapper bypass for existing tools or structured output.
- Client cancellation, interrupted streams, upstream errors, length endings and the absence of automatic retries.
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

This sends two billable requests, each capped at 512 output tokens. It checks restoration for the normal reply, then checks nonempty text, `stop`, `[DONE]` and restoration for the stream. It also requires at least two content-bearing reads spanning at least 100 ms. Finally, it matches the response's `x-request-id` to `/admin/events`.

The receipt contains metadata only. Read counts and timing depend on the model, network and buffering; one run cannot guarantee the same delivery pattern for every reply.

## What these checks do not establish

Short requests and simulated streams do not prove that long replies will avoid truncation. The gateway cannot restore content the model never generated or the network never delivered. A model may also return ordinary text directly, in which case the log reports `restored: false`.

Multiple Gemini models can now be configured; this does not establish live compatibility for every model. Compatibility with other providers, public remote deployment and other clients has not been established.

Version 0.3.0 adds local tests for catalog authentication/pagination/errors, legacy migration, model persistence, alias routing, and normal/buffered/streaming modes with both JSON and SSE clients. Browser checks used a simulated catalog and upstream to save six profiles for two models, reject duplicate names, discard edits, reload saved profiles and select each mode for testing. Buffered replies arrived together; streaming replies arrived progressively. These checks do not verify real catalog permissions or model access.
