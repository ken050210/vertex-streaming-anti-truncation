# Changelog

[中文](CHANGELOG.zh-CN.md) | English

## 0.1.0 (experimental)

The first standalone release extracts the Gemini 3.7 Flash text-tool transport from a local Node.js router.

- Supported streaming requests use native Vertex `partialArgs` and deliver ordinary OpenAI SSE text during generation.
- Requests retain the compatible fallback when translation would drop fields. Existing client tools, structured output and other conflicts skip wrapping.
- Request logs record restoration, finish reason and stream completion, linked to the response request ID.
- The package includes setup instructions, SillyTavern settings, local protocol tests and bilingual documentation.
- [Xeltra233 / Antigravity-gateway](https://github.com/Xeltra233/Antigravity-gateway) is credited for the transport design, with its MIT license preserved.

The default checks use simulated upstream responses. See [validation](docs/VALIDATION.en.md) for what has and has not been tested.
