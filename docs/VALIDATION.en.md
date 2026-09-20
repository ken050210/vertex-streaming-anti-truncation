# Validation

[中文](VALIDATION.md) | English

The standalone package's local tests and the live requests made before extraction cover different parts of the system.

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

The 0.2.0 browser check used isolated fixture credentials and a simulated upstream: Express/Flex save/apply, progressive text restoration, light/dark themes and narrow layouts. This does not prove live credentials, Gemini 3.7 availability or a particular account's Express/Flex/Priority entitlement.

These tests use local fixtures and make no Vertex calls. CI is configured for Node.js 22 and 24 on both Linux and Windows. See [Actions](https://github.com/ken050210/vertex-streaming-anti-truncation/actions) for actual run results.

The standalone CLI was also checked on Windows with Node.js 24.16.0: health returned 200, an unauthenticated model request returned 401, and the authenticated model list was correct. The service bound to loopback. This check used dummy credentials and sent no model requests.

## Live requests before extraction

On 2026-09-20, the original router integration tested the same streaming transport core with two fixed-text requests, each capped at 512 output tokens. Both the non-streaming and streaming requests returned HTTP 200, restored text and `stop`. The stream delivered content in 7 reads over 911 ms and ended with `[DONE]`. This shows that the Vertex reply arrived progressively in that run.

Those results belong to the original router integration. The new standalone HTTP service was validated with local fixtures; paid Vertex requests and a SillyTavern UI check were not repeated for this package. A health check only shows that the process is reachable.

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
