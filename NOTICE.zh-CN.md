# 署名与来源

中文 | [English](NOTICE.md)

合成工具传输方案来自 [Xeltra233](https://github.com/Xeltra233) 的 [Antigravity-gateway](https://github.com/Xeltra233/Antigravity-gateway)。原项目采用 MIT 许可证，版权声明为 Copyright (c) 2026 Xeltra233。完整原许可证保留在 [LICENSES/Antigravity-gateway-MIT.txt](LICENSES/Antigravity-gateway-MIT.txt)。

本次发布核对的原项目版本为 [`e83fc1a505e501d3ac6a13c12816df1ceb55b86b`](https://github.com/Xeltra233/Antigravity-gateway/tree/e83fc1a505e501d3ac6a13c12816df1ceb55b86b)，日期为 2026-09-08。[相关 Discord 讨论](https://discord.com/channels/1134557553011998840/1543451029553545346) 可能需要加入服务器才能阅读。

本仓库是从 ken050210 本地 router 提取的独立 JavaScript 实现，没有包含原项目 Go 源码的 fork。原项目已有 SSE 增量解析；本版本增加 Vertex 原生 `partialArgs` 转换，让符合条件的请求能在生成过程中发送正文。本版本并非 Antigravity Gateway 官方发布。

发布包包含传输和 Vertex 模块、独立 HTTP 服务、测试与文档。个人配置、账号路由、运行状态、凭据、对话数据和私有仓库历史均未包含。

Google、Vertex AI、Gemini 和 SillyTavern 的名称用于说明兼容对象，其维护者没有为本项目背书。协议参考为 Google 的[流式函数参数文档](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/function-calling#streaming_function_call_arguments)。
