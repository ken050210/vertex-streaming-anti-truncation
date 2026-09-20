# Vertex Streaming Anti-Truncation

[中文](README.md) | English

A local gateway for Vertex AI / Gemini 3.7 Flash that carries reply text through a synthetic function call and restores it as OpenAI SSE text while generation is still running. It works with SillyTavern's custom OpenAI connection.

Experimental release. Gemini 3.7 Flash is the only model offered. Requires Node.js 22+ and has no third-party runtime dependencies.

## Credits

The synthetic text-tool transport design comes from [Antigravity-gateway](https://github.com/Xeltra233/Antigravity-gateway) by [Xeltra233](https://github.com/Xeltra233).

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

You need a Google Cloud project with the Vertex AI API enabled, plus a service account with permission to call the model or a short-lived OAuth access token. Vertex requests are billed to your Google Cloud account.

```sh
git clone https://github.com/ken050210/vertex-streaming-anti-truncation.git
cd vertex-streaming-anti-truncation
npm ci --ignore-scripts
```

Copy `.env.example` to `.env`: use `Copy-Item .env.example .env` in Windows PowerShell or `cp .env.example .env` on Linux/macOS. Set:

- `GATEWAY_API_KEY`: a random local access key you generate, at least 16 characters.
- `VERTEX_PROJECT_ID`: your Google Cloud project ID. `VERTEX_LOCATION` defaults to `global`.
- `GOOGLE_APPLICATION_CREDENTIALS`: the path to a service-account JSON file outside the repository. On Windows, `C:/keys/service-account.json` works.
- To use a short-lived Google OAuth access token, remove the previous setting and set `VERTEX_ACCESS_TOKEN` instead. Choose exactly one authentication method.
- `PORT`: defaults to `4781`.

Generate a gateway key with this command, save it in `.env`, then start the service:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm start
```

The service binds only to `127.0.0.1`. `GET /healthz` checks the process; every other endpoint requires `Authorization: Bearer <GATEWAY_API_KEY>`. The service-account private key signs a JWT locally. That JWT is sent to Google OAuth to obtain the short-lived access token used for model requests.

## SillyTavern

Under Chat Completion, select the custom OpenAI-compatible connection:

| Setting | Value |
| --- | --- |
| API URL | `http://127.0.0.1:4781/v1` |
| API Key | `GATEWAY_API_KEY` from `.env` |
| Model | `gemini-3.7-flash-antitruncation` |
| Streaming | Enabled |

If your preset already uses a similar text-tool transport script, keep only one wrapper enabled.

The gateway accepts the Anthropic-style field `thinking: {type: "disabled"}` as a no-op, matching Vertex's compatible endpoint. It does not disable Gemini thinking. Use `extra_body.google.thinking_config` for Gemini thinking settings.

## Scope and limits

Streaming text requests use native function-argument streaming when their fields can be translated. Non-streaming requests use Vertex's OpenAI-compatible endpoint. Unsupported extension fields, media or extra message metadata retain their original values and fall back to that compatible endpoint, which may wait for the full reply. The response header `x-anti-truncation-transport` then reads `tool-transport-buffered-fields`.

Requests with existing tools/functions, explicit tool selection, tool history, JSON/Schema output or multiple candidates skip the wrapper. Genuine tools, usage, thinking metadata and finish reasons such as `length` or `content_filter` are preserved. Interrupted streams fail; the gateway does not continue or retry them automatically.

“Anti-truncation” describes transporting and restoring text that has been received. It cannot recover text the model never generated or the network never delivered, guarantee complete replies, or bypass model limits.

This package calls standard Vertex directly. It has no account scheduler, quota manager, database or GUI, and does not automatically upgrade requests to Flex/Priority.

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

The default tests use local fixtures, require no real credentials and incur no inference charges. The live smoke test measures content-bearing reads and their time span, then matches response request IDs to the logs. See [docs/VALIDATION.en.md](docs/VALIDATION.en.md) for the validation scope.
