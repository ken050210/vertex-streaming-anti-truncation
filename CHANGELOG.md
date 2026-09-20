# Changelog

[中文](CHANGELOG.zh-CN.md) | English

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
