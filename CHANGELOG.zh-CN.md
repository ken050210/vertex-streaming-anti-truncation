# 更新记录

中文 | [English](CHANGELOG.md)

## 0.1.0（实验版）

首个独立版本，从本地 Node.js router 提取 Gemini 3.7 Flash 工具调用抗截断传输。

- 符合条件的流式请求使用 Vertex 原生 `partialArgs`，在生成过程中发送普通 OpenAI SSE 正文。
- 如果翻译会丢失字段，保留兼容接口回退。已有客户端工具、结构化输出等冲突会跳过包装。
- 请求日志记录还原结果、结束原因和流完成状态，并关联响应中的请求 ID。
- 包含启动说明、SillyTavern 设置、本地协议测试和中英文文档。
- 标注方案来源 [Xeltra233 / Antigravity-gateway](https://github.com/Xeltra233/Antigravity-gateway)，保留其 MIT 许可证。

默认检查使用模拟上游响应。已完成和未完成的测试范围见[验收说明](docs/VALIDATION.md)。
