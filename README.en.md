# Vertex Streaming Anti-Truncation

[中文](README.md) | English

A local gateway for Vertex AI / Gemini with a model library and optional text-tool transport. Save normal, buffered anti-truncation and streaming anti-truncation aliases for each upstream model, then select them from SillyTavern's custom OpenAI connection.

Experimental release with configurable Gemini models. The existing Gemini 3.7 Flash alias remains the default. Model and function-argument streaming availability depend on Google. Requires Node.js 22.9+ and has no third-party runtime dependencies.

## Credits

The synthetic text-tool transport design comes from [Antigravity-gateway](https://github.com/Xeltra233/Antigravity-gateway) by [Xeltra233](https://github.com/Xeltra233).

## Console preview

These screenshots use demo configuration and a simulated upstream, showing the Chinese-language console in light and dark themes. The ports shown are demo ports; the defaults are `4780` for the console and `4781` for the API.

**Overview**: gateway status, client connection details, saved model profiles and recent requests.

![Light overview with gateway status, client connection details and recent requests](docs/screenshots/console-overview.jpg)

<details>
<summary>Connection settings: project ID, service account / Express API key, Standard / Flex / Priority</summary>

![Connection settings with project ID, complete service-account JSON, authentication modes and service tiers](docs/screenshots/console-connection.jpg)

</details>

<details>
<summary>Model library: discover models and save normal, buffered and streaming anti-truncation profiles</summary>

![Dark model library with a demo catalog and three profiles for each of two models](docs/screenshots/console-models.jpg)

</details>

<details>
<summary>Connection test: streaming output, restoration status and arrival statistics</summary>

![Dark connection test with a simulated streaming reply, restoration result and arrival statistics](docs/screenshots/console-streaming-test.jpg)

</details>

## How streaming works

The original project already parses SSE incrementally. If Vertex's OpenAI-compatible endpoint waits for complete tool arguments before returning them, the client still receives the reply all at once. For supported text requests, this gateway uses Vertex's native function-argument stream and forwards each decoded fragment as it arrives.

| Project | Path and focus |
| --- | --- |
| Antigravity Gateway | A general OpenAI-compatible gateway with synthetic text-tool transport and incremental SSE parsing |
| This project | Calls native `streamGenerateContent`, enables `streamFunctionCallArguments`, and converts received `partialArgs` into ordinary `delta.content` |

The HTTP test holds the simulated upstream open until the client receives the first text fragment. This checks that delivery begins before completion. Actual delivery timing still depends on the model; [Google lists streaming function call arguments as Preview](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/function-calling#streaming_function_call_arguments).

```text
SillyTavern / OpenAI-compatible client
  → local gateway: synthetic text tool
  → Vertex native partialArgs stream
  → incremental JSON decoding
  → ordinary SSE delta.content
```

## Setup

Choose a full Vertex service-account JSON, an Express mode API key, or a short-lived OAuth access token. Full mode requires a Google Cloud project with the Vertex AI API enabled and permission to call the model. Inference is billed to your Google Cloud account.

```sh
git clone https://github.com/ken050210/vertex-streaming-anti-truncation.git
cd vertex-streaming-anti-truncation
npm ci --ignore-scripts
npm start
```

Open the console link printed in the terminal (default `http://127.0.0.1:4780/`). On first launch, use the setup link containing a local bootstrap key. On Windows you can also double-click `Start-GUI.cmd`. No `.env` is required for GUI setup.

The console includes light/dark themes, responsive layout, overview, connection settings, metadata-only request logs and a bounded test page:

- Enter the target project ID and paste/import the **complete service-account JSON**, or select **Express API Key** or **OAuth Token**. A service account's project can be filled automatically and overridden for cross-project access. Express uses a projectless global endpoint; its optional project field is only a note.
- Select **Standard, Flex or Priority**, an API port, timeout and anti-truncation setting. Express and non-standard tiers require `global`.
- Generate and copy a local gateway key before saving. Saved credentials are write-only; blank fields retain previous values. Use that key for client access and subsequent console sign-in.
- Save and apply without interrupting active replies. Port conflicts preserve the old listener and configuration. Starting, saving and validating do not call Google. The test page requires an explicit click and consent for each request, capped at 512 output tokens, with cancellation and streaming arrival statistics.

Settings are stored as plaintext in `~/.vertex-streaming-anti-truncation/settings.json`, outside the repository. Keep this directory private. Override it with `GATEWAY_STATE_DIR`; change the console port with `GUI_PORT` (default `4780`). The API port defaults to `4781`. Saves use revision checks and atomic replacement. Restarting the console loads saved settings and starts the gateway. Saved GUI settings take precedence over `.env`; an existing `.env` can initialize an unsaved setup. Secrets are never stored in browser storage or returned by configuration APIs.

### Model library and variants

Enter credentials under **连接配置**, then open **模型与版本** and click **拉取 Model List**. Discovery uses the current connection form plus saved credentials, without starting inference or saving the draft. Search and select multiple models, check the variants to add, then click **保存全部配置** to save both connection and model drafts. Refresh the model list in your client afterwards.

| Variant | Behavior | Generated alias |
| --- | --- | --- |
| Normal | No wrapper; follows the client's `stream` setting | `<model>` |
| Buffered anti-truncation | Restores a complete upstream response; delivers it at once as SSE if requested | `<model>-antitruncation-nonstream` |
| Streaming anti-truncation | Native argument streaming for SSE; ordinary restored JSON otherwise | `<model>-antitruncation-stream` |

Save up to 100 profiles with unique public names, including Chinese aliases. Each row can change its upstream ID and mode. `/v1/models` exposes saved profiles. The add action skips existing upstream/mode pairs; manual edits may retain multiple aliases for the same pair. Saving an empty list exposes no models. Existing `gemini-3.7-flash-antitruncation` settings retain their name and previous enabled/disabled behavior on upgrade; explicit profiles replace the legacy global switch.

Discovery uses Google's paginated [publisher model catalog](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1beta1/publishers.models/list) and filters Gemini IDs. Catalog presence does not establish project access, region, modality or tier support. The [Express API reference](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/express-mode/api-reference) does not guarantee listing support: if an API key cannot list models, use a service account for discovery or manually enter `gemini-…`, `google/gemini-…` or `publishers/google/models/gemini-…`. Errors preserve existing profiles and do not return a fabricated fallback catalog.

### CLI-only setup

Copy `.env.example` to `.env`: use `Copy-Item .env.example .env` in Windows PowerShell or `cp .env.example .env` on Linux/macOS. Set:

- `GATEWAY_API_KEY`: a random local access key you generate, at least 16 characters.
- `VERTEX_PROJECT_ID`: your Google Cloud project ID. `VERTEX_LOCATION` defaults to `global`.
- `GOOGLE_APPLICATION_CREDENTIALS`: the path to a service-account JSON file outside the repository. On Windows, `C:/keys/service-account.json` works.
- Alternatively set `VERTEX_ACCESS_TOKEN`, or use `VERTEX_API_KEY` for Express mode (no project required). Choose exactly one authentication method.
- `VERTEX_SERVICE_TIER`: `standard` (default), `flex` or `priority`. Set `ANTI_TRUNCATION=false` to disable wrapping.
- `PORT`: defaults to `4781`.

Generate a gateway key with this command, save it in `.env`, then start the service:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm run gateway
```

The service binds only to `127.0.0.1`. `GET /healthz` checks the process; every other endpoint requires `Authorization: Bearer <GATEWAY_API_KEY>`. The service-account private key signs a JWT locally. That JWT is sent to Google OAuth to obtain the short-lived access token used for model requests.

## SillyTavern

Under Chat Completion, select the custom OpenAI-compatible connection:

| Setting | Value |
| --- | --- |
| API URL | `http://127.0.0.1:4781/v1` |
| API Key | The local gateway key from GUI setup or `GATEWAY_API_KEY` from `.env` |
| Model | A saved alias from the refreshed list; default `gemini-3.7-flash-antitruncation` |
| Streaming | Optional; buffered anti-truncation waits for the complete response |

If your preset already uses a similar text-tool transport script, keep only one wrapper enabled.

The gateway accepts the Anthropic-style field `thinking: {type: "disabled"}` as a no-op, matching Vertex's compatible endpoint. It does not disable Gemini thinking. Use `extra_body.google.thinking_config` for Gemini thinking settings.

## Scope and limits

Streaming text requests use native function-argument streaming when their fields can be translated. In Standard service-account/OAuth mode, non-streaming requests use Vertex's OpenAI-compatible endpoint. Unsupported extension fields, media or extra message metadata retain their original values and fall back to that compatible endpoint, which may wait for the full reply. The response header `x-anti-truncation-transport` then reads `tool-transport-buffered-fields`.

Express, Flex and Priority use native endpoints for both regular and streaming requests. Supported inputs include text, inline base64 images, function tools and history, JSON/Schema output, candidate counts, and common sampling/thinking settings. Remote image URLs, legacy `functions`, `parallel_tool_calls`, logprobs and unknown extensions return `400 unsupported_native_fields` when they cannot be preserved. The gateway does not silently discard those fields or switch tiers. Real tools and structured output bypass wrapping but still use native translation.

Requests with existing tools/functions, explicit tool selection, tool history, JSON/Schema output or multiple candidates skip the wrapper. Genuine tools, usage, thinking metadata and finish reasons such as `length` or `content_filter` are preserved. Interrupted streams fail; the gateway does not continue or retry them automatically.

“Anti-truncation” describes transporting and restoring text that has been received. It cannot recover text the model never generated or the network never delivered, guarantee complete replies, or bypass model limits.

Tiers are selected explicitly and never automatically upgraded, downgraded or retried. Flex/Priority send Google's tier headers. The requested tier and actual `usage.traffic_type` are logged separately; missing upstream tier metadata remains unknown. Model/account availability, including Express tier support, requires real upstream verification. See the official [Express endpoint](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/express-mode/overview), [Flex](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/flex-paygo) and [Priority](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/priority-paygo) documentation. This package has no multi-account scheduler or quota manager.

## Response and Schema validation

Every profile checks completion output and finish reasons. Streams also require a terminal reason for every candidate and `[DONE]`. Empty or reasoning-only successful replies, broken tool arguments, error events and premature EOF fail validation. Length limits and refusals remain explicit; the gateway does not invent a successful stop. After content reaches the client, an error closes the stream without replaying the request.

Native routes use `responseJsonSchema` and `parametersJsonSchema`. They preserve `additionalProperties: false`, nullable types, local `$defs`/`$ref`, and arrays without `items`. Property names such as `$schema` remain intact; only dialect metadata at schema nodes is removed. Unsupported constraints, including `oneOf` and `pattern`, return `400 unsupported_native_schema` with a parameter path before authentication or inference. Standard compatible requests continue forwarding the original schema to Vertex.

Completed native JSON/Schema responses are parsed and checked against the supported constraints, including closed objects, required fields and array contents. `strict: true` is accepted for response schemas within that subset. Invalid output fails without automatic repair. Ordinary story text is not accumulated for logging; explicit structured output and tool arguments use bounded temporary validation buffers. Formats remain annotations, and length/filter endings are reported without requiring a finished JSON value.

Logs and the console add `responseIntegrity` metadata for complete, length-limited, filtered/refused, tool, empty, interrupted, failed and cancelled results. It contains only fixed enums and booleans. Match errors to events using the response request ID.

## Checking a request

JSON logs contain request IDs, status, duration and `antiTruncation` metadata. They exclude prompts, reply text, tool arguments and credentials. `GET /admin/events` returns the most recent 200 records held in memory; restarting clears them. Redirect standard output to a file outside the repository if you need persistent logs.

A wrapped stream that finishes normally should have a successful request status and all of these values:

```json
{
  "antiTruncation": {
    "transport": "tool-transport-native-streaming",
    "restored": true,
    "finishReason": "stop",
    "streamDone": true
  }
}
```

`restored: false` means restoration did not occur or the wrapper was skipped. `null` means it has not been confirmed. A reply with `restored: true` and `length` still reached an output limit. These fields confirm restoration and the finish state; they do not prove that the same reply would have been truncated without the gateway.

```sh
npm run verify
# Optional: with the server running, send two billable requests capped at 512 tokens each.
npm run smoke -- --live
```

The smoke command uses saved GUI settings, falling back to environment variables when no file exists. Add `--env` to explicitly target a CLI-only service configured through `.env`. It selects the first streaming anti-truncation profile by default; use `--model your-alias` to select another. The GUI test page supports normal and buffered profiles too.

The default tests use local fixtures, require no real credentials and incur no inference charges. The live smoke test measures content-bearing reads and their time span, then matches response request IDs to the logs. See [docs/VALIDATION.en.md](docs/VALIDATION.en.md) for the validation scope.
