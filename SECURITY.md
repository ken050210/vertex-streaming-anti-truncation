# Security and privacy

[中文](SECURITY.zh-CN.md) | English

The gateway and console bind to `127.0.0.1`. Model and admin endpoints require a gateway key, and upstream URLs are fixed to Google Vertex AI. Keep the listener local and credentials outside this repository. Environment files, credentials and logs are excluded from releases.

The console checks Host and Origin, denies cross-site requests, uses expiring HttpOnly/SameSite sessions and CSRF tokens, and limits failed sign-in attempts. On first launch the terminal displays a bootstrap link; it stops working after a gateway key is saved. Configuration responses expose only credential-presence booleans. No keys enter browser storage. Test replies are shown only in the signed-in page and are not saved in logs.

GUI settings (including credentials) are stored as plaintext in `~/.vertex-streaming-anti-truncation/settings.json`, or `GATEWAY_STATE_DIR`. Use a private directory. Files/directories request mode 0600/0700 on POSIX; Windows uses the directory's inherited ACLs. Saves validate before replacing the file, use a process lock, check the revision and rename a flushed temporary file. A stale revision or unavailable replacement port leaves the existing service intact. Other local software with access to this user's files remains within the trust boundary.

Request logs do not contain prompts, replies, tool arguments or credentials. HTTP failures from the provider return a fixed error code and status instead of the provider's raw body. The event list holds at most 200 records in memory. The streaming parser bounds its event and JSON state; it does not collect complete replies for logging. Non-streaming JSON completions have an 8 MiB limit.

Each request makes at most one generation attempt. Client cancellation aborts the upstream request. If a protocol error occurs after text has reached the client, the connection closes and the log records the failure.

`npm run verify` uses local fixtures. `npm run smoke -- --live` sends two billable requests, each capped at 512 output tokens. This standalone gateway has no access to quota limits or cooldown state in another router.

For bug reports, include the version, status code, `requestId` and `antiTruncation` metadata. Omit `.env`, service-account files, bearer tokens and private conversation text.
