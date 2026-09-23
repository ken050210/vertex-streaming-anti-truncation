# Changelog

[中文](CHANGELOG.zh-CN.md) | English

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
