# Unicode input migration audit — 2026-10-02

## Changes

- Synchronized the router's message-only matcher fix: removed serialized JSON fallback, preserving tool names, schemas, model IDs, media and unrelated extra fields. Retained compact character rules, actual-floor metadata, fixed logging projection and expansion limits.
- Added default-off gateway `unicodeInput` / `UNICODE_INPUT`, applying before prefill, transport selection and retry across every model. Configuration snapshots keep in-flight requests unchanged. Local floor metadata is stripped regardless of toggle state.
- Added independent Vertex UI extension toggle (plugin v0.2.0). Encoding occurs in the browser before anti-truncation routing; off/tools/schema/search bypasses use the original Tavern route with encoded message text. The backend retains its existing pure-text transport contract.
- Added a separately named, default-disabled Tavern Helper import for loopback custom API port 4781. It supplies the actual user floor, preserves custom body configuration, and does not enable encoding itself.
- Added Chinese/English gateway documentation and plugin installation/behavior notes. Existing v0.1.0 release links remain historical; v0.2.0 is local only.

## Evidence

- Gateway `npm run verify`: 79 release files checked, 217/217 tests passed; final static check including this audit passed for 80 files. New tests cover protocol-key collisions, configuration default/validation and persisted apply/restart, all three modes with streaming on/off, tools/schema bypass, local source stripping, missing floor, expansion overflow, Request/CSRF/abort preservation, and bridge endpoint scoping.
- Router `npm run verify`: 58 JavaScript files, 13 PowerShell scripts checked; 201/201 tests passed. Existing unrelated dirty files were retained.
- `npm run package:sillytavern`: generated server and extension packages under `dist/sillytavern`, with SHA256 manifest. The browser package includes the shared browser-compatible encoder.
- `git diff --check`: both gateway and router passed.
- Router pre-change read-only status: healthy Docker runtime, ownership verified, loopback-only, controller verified. No runtime configuration or credentials changed.
- Browser preview attempted against isolated local fixtures; the in-app browser returned ERR_BLOCKED_BY_CLIENT. No visual acceptance claim. The temporary preview server was stopped.

## Remaining acceptance

No live model calls, production runtime restarts, installed Tavern updates, GitHub publication, or commits. Source writeback and local package generation are complete; production activation and real Tavern/Vertex behavior remain unverified. Encoding may increase input tokens/latency and does not guarantee model comprehension.
