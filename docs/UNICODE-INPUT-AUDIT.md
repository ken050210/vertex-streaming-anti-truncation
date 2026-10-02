# Unicode input migration audit — 2026-10-02

## Changes

- Synchronized the router's message-only matcher fix: removed serialized JSON fallback, preserving tool names, schemas, model IDs, media and unrelated extra fields. Retained compact character rules, actual-floor metadata, fixed logging projection and expansion limits.
- Added default-off gateway `unicodeInput` / `UNICODE_INPUT`, applying before prefill, transport selection and retry across every model. Configuration snapshots keep in-flight requests unchanged. Local floor metadata is stripped regardless of toggle state.
- Added independent Vertex UI extension toggle (plugin v0.2.0). Encoding occurs in the browser before anti-truncation routing; off/tools/schema/search bypasses use the original Tavern route with encoded message text. The backend retains its existing pure-text transport contract.
- Added a separately named, default-disabled Tavern Helper import for loopback custom API port 4781. It supplies the actual user floor, preserves custom body configuration, and does not enable encoding itself.
- Added Chinese/English gateway documentation and plugin installation/behavior notes. Existing v0.1.0 release links remain historical; v0.2.0 is available from the source branch; no new release tag was created.

## Evidence

- Gateway `npm run verify`: 79 release files checked, 217/217 tests passed; final static check including this audit passed for 80 files. New tests cover protocol-key collisions, configuration default/validation and persisted apply/restart, all three modes with streaming on/off, tools/schema bypass, local source stripping, missing floor, expansion overflow, Request/CSRF/abort preservation, and bridge endpoint scoping.
- Router `npm run verify`: 58 JavaScript files, 13 PowerShell scripts checked; 201/201 tests passed. Existing unrelated dirty files were retained.
- `npm run package:sillytavern`: generated server and extension packages under `dist/sillytavern`, with SHA256 manifest. The browser package includes the shared browser-compatible encoder.
- `git diff --check`: both gateway and router passed.
- Router pre-change read-only status: healthy Docker runtime, ownership verified, loopback-only, controller verified. No runtime configuration or credentials changed.
- Installed both Tavern components at v0.2.0 after a full stopped-service data/config/plugin backup; restarted Tavern and the managed router. Installed package checksums matched, protected config/secret hashes stayed unchanged, and Tavern health returned HTTP 200.
- Live acceptance: eight bounded benign requests (1024 output-token limit each). Router normal + SSE passed with stop and a single SSE DONE. An ephemeral gateway passed normal, buffered SSE and native streaming SSE with expected text; both anti-truncation paths reported restoration and one DONE. Installed Tavern frontend interception + production endpoints passed off, buffered and streaming modes with expected text; both anti-truncation modes reported restoration, and streaming had one DONE.
- Tavern's original non-streaming adapter omits finish_reason; that field could not be checked on its off path. The initial harness assertion exposed this adapter limitation; its successful request was retained rather than repeated. Buffered and streaming finish states were checked.
- Edge UI confirmed the Unicode checkbox, backend readiness, persistence across reload, and successful restoration to the original OFF state. Anti-truncation mode remained OFF. No user chat was generated or modified.
- The standalone gateway had no running instance or saved configuration; live checks used a temporary loopback instance that was closed afterward. No persistent credential/config file was created.

## Acceptance limits

These short smoke requests establish deployment and basic request/response compatibility, not long-context comprehension or reduced truncation rates. Long replies, real user conversations, live tools/schema/search and restart-on-boot behavior were not exercised. Encoding may increase input tokens/latency and does not guarantee model comprehension. Router changes remain local and uncommitted; only this gateway repository is authorized for remote push.
