# Attribution and provenance

[中文](NOTICE.zh-CN.md) | English

The synthetic text-tool transport design is credited to [Antigravity-gateway](https://github.com/Xeltra233/Antigravity-gateway) by [Xeltra233](https://github.com/Xeltra233). Its MIT license names Xeltra233 as the copyright holder, Copyright (c) 2026. The full upstream license is preserved in [LICENSES/Antigravity-gateway-MIT.txt](LICENSES/Antigravity-gateway-MIT.txt).

The reference revision reviewed for this release is [`e83fc1a505e501d3ac6a13c12816df1ceb55b86b`](https://github.com/Xeltra233/Antigravity-gateway/tree/e83fc1a505e501d3ac6a13c12816df1ceb55b86b), dated 2026-09-08. The [related Discord discussion](https://discord.com/channels/1134557553011998840/1543451029553545346) may require membership to read.

This repository contains an independent JavaScript implementation extracted from ken050210's local router. It does not contain a fork of the upstream Go source. The upstream project already supports incremental SSE parsing; this release adds a Vertex-native `partialArgs` bridge so supported requests can deliver text during generation. It is not an official Antigravity Gateway release.

The distribution contains transport and Vertex modules, a standalone HTTP server, tests and documentation. Personal configurations, account routing, runtime state, credentials, conversation data and private repository history are excluded.

Google, Vertex AI, Gemini and SillyTavern are named to describe compatibility. Their maintainers do not endorse this project. The protocol reference is Google's documentation for [streaming function call arguments](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/function-calling#streaming_function_call_arguments).

Text-to-image input is inspired by Antigravity-gateway experimental revision 004067b34f42cd6a9ba9b147a0cad02b88c10c7b (imagectx). This is an independent JavaScript implementation with deliberate compatibility differences. Bundled NotoSansCJKsc-Regular.otf is from https://github.com/notofonts/noto-cjk/tree/main/Sans/OTF/SimplifiedChinese and is redistributed under the SIL Open Font License in assets/fonts/OFL.txt. @napi-rs/canvas and its platform binaries retain their upstream license notices through npm.
