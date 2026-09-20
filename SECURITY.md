# Security and privacy

[中文](SECURITY.zh-CN.md) | English

The CLI binds to `127.0.0.1`, requires a gateway key for model and admin endpoints, and constructs upstream URLs only for Google Vertex AI. Keep the listener local and the Google service-account file outside this repository. Environment files, credentials and logs are excluded from releases.

Request logs do not contain prompts, replies, tool arguments or credentials. HTTP failures from the provider return a fixed error code and status instead of the provider's raw body. The event list holds at most 200 records in memory. The streaming parser bounds its event and JSON state; it does not collect complete replies for logging. Non-streaming JSON completions have an 8 MiB limit.

Each request makes at most one generation attempt. Client cancellation aborts the upstream request. If a protocol error occurs after text has reached the client, the connection closes and the log records the failure.

`npm run verify` uses local fixtures. `npm run smoke -- --live` sends two billable requests, each capped at 512 output tokens. This standalone gateway has no access to quota limits or cooldown state in another router.

For bug reports, include the version, status code, `requestId` and `antiTruncation` metadata. Omit `.env`, service-account files, bearer tokens and private conversation text.
