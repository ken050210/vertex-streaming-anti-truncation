# Vertex Streaming Anti-Truncation

中文 | [English](README.en.md)

为 Vertex AI / Gemini 3.7 Flash 提供工具调用抗截断传输。网关在生成过程中把正文逐段还原为 OpenAI 格式 SSE，可接入 SillyTavern 的自定义 OpenAI 连接。

实验版，只提供 Gemini 3.7 Flash。需要 Node.js 22+，无第三方运行时依赖。

## 来源

合成工具传输方案参考 [Xeltra233](https://github.com/Xeltra233) 的 [Antigravity-gateway](https://github.com/Xeltra233/Antigravity-gateway) 和 [Discord 原讨论](https://discord.com/channels/1134557553011998840/1543451029553545346)。

[ken050210](https://github.com/ken050210) 将本地 router 中的实现提取为这个独立 JavaScript 网关，主要处理 Vertex 的流式输出。它是独立项目；原作者没有参与或背书本版本。两个项目都采用 MIT 许可证，原项目的版权声明和完整许可证见 [LICENSES/Antigravity-gateway-MIT.txt](LICENSES/Antigravity-gateway-MIT.txt)，本项目许可证见 [MIT](LICENSE)。完整来源说明见 [NOTICE.md](NOTICE.md)。

## 流式输出如何工作

原项目已经有 SSE 增量解析。如果 Vertex 的 OpenAI 兼容接口等到工具参数完整后才返回，客户端仍会一次性收到正文。本项目对可翻译的文本请求使用 Vertex 原生函数参数流，收到一段就还原并发送一段。

| 项目 | 路径与侧重点 |
| --- | --- |
| Antigravity Gateway | 通用 OpenAI 兼容网关，具备合成工具传输和 SSE 增量解析等功能 |
| 本项目 | 使用原生 `streamGenerateContent`，开启 `streamFunctionCallArguments`，把收到的 `partialArgs` 转成普通 `delta.content` |

测试会让模拟上游停在首段，等客户端收到正文后再允许上游结束，以此检查是否提前交付。真实请求的分段速度仍取决于模型；[Google 将流式函数参数列为 Preview](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/function-calling#streaming_function_call_arguments)。

```text
SillyTavern / OpenAI-compatible client
  → local gateway: synthetic text tool
  → Vertex native partialArgs stream
  → incremental JSON decoding
  → ordinary SSE delta.content
```

## 启动

需要已启用 Vertex AI API 的 Google Cloud 项目，以及有模型调用权限的服务账号或短期 OAuth access token。Vertex 调用按你的 Google Cloud 账户计费。

```sh
git clone https://github.com/ken050210/vertex-streaming-anti-truncation.git
cd vertex-streaming-anti-truncation
npm ci --ignore-scripts
```

将 `.env.example` 复制为 `.env`：Windows PowerShell 使用 `Copy-Item .env.example .env`；Linux/macOS 使用 `cp .env.example .env`。然后填写：

- `GATEWAY_API_KEY`：自己生成的随机本地访问密钥，至少 16 字符。
- `VERTEX_PROJECT_ID`：Google Cloud 项目 ID。`VERTEX_LOCATION` 默认 `global`。
- `GOOGLE_APPLICATION_CREDENTIALS`：仓库之外的服务账号 JSON 路径。Windows 可写成 `C:/keys/service-account.json`。
- 如需用短期 Google OAuth access token，删掉上一项，改填 `VERTEX_ACCESS_TOKEN`。两种鉴权方式只能选一种。
- `PORT`：默认 `4781`。

用以下命令生成随机网关密钥，填入 `.env` 后启动：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm start
```

服务只监听 `127.0.0.1`。`GET /healthz` 检查进程状态；其余接口都需要 `Authorization: Bearer <GATEWAY_API_KEY>`。服务账号私钥只在本机签署 JWT，JWT 发给 Google OAuth 换取短期 access token，再用于模型请求。

## 接入 SillyTavern

在“聊天补全 → 自定义（兼容 OpenAI）”连接中设置：

| 设置 | 值 |
| --- | --- |
| API URL | `http://127.0.0.1:4781/v1` |
| API Key | `.env` 中的 `GATEWAY_API_KEY` |
| 模型 | `gemini-3.7-flash-antitruncation` |
| 流式传输 | 开启 |

如果预设已经有同类工具调用抗截断脚本，只保留一处包装。

网关兼容 `thinking: {type: "disabled"}` 这个 Anthropic 格式字段，但会按 Vertex 兼容接口的原行为忽略它；它不会关闭 Gemini 思考。Gemini 思考设置使用 `extra_body.google.thinking_config`。

## 适用范围与限制

纯文本流式请求优先使用原生函数参数分段。非流式请求使用 Vertex OpenAI 兼容接口。遇到无法翻译的扩展字段、媒体或额外消息元数据时，网关保留原参数并回退到兼容接口，此时可能仍需等待全文。响应头 `x-anti-truncation-transport` 会显示 `tool-transport-buffered-fields`。

已有 tools/functions、显式工具选择、工具历史、JSON/Schema 输出或多候选的请求会跳过包装。真实工具、usage、思考元数据，以及 `length` / `content_filter` 等结束原因会保留。流中断会报错；网关不自动续写或重试。

“抗截断”指通过工具参数传输并恢复已收到的文本。它不能恢复模型未生成或网络未收到的内容，也不能保证消除截断或绕过模型限制。

独立包直接调用标准 Vertex，不包含多账号调度、额度管理、数据库或 GUI，也不会自动升级到 Flex/Priority。

## 查看验收结果

JSON 日志记录请求 ID、状态、耗时和 `antiTruncation` 元数据，不记录提示词、回复正文、工具参数或密钥。`GET /admin/events` 返回进程内最近 200 条记录，重启后清空。需要持久日志时，将标准输出重定向到仓库之外。

一次正常结束的抗截断流式请求，应同时满足请求成功和以下状态：

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

`restored: false` 表示未还原或跳过，`null` 表示尚未确认。`restored: true` 加 `length` 仍表示输出达到长度限制。这些标志能确认传输还原和结束状态，不能证明同一回复在不用网关时一定会截断。

```sh
npm run verify
# 可选：服务启动后，显式发送两条收费的短请求（各最多 512 tokens）
npm run smoke -- --live
```

默认测试使用本地模拟数据，不需要真实凭据，也不产生推理费用。烟测会统计正文到达次数和时间跨度，并用响应请求 ID 核对日志。验证范围见 [docs/VALIDATION.md](docs/VALIDATION.md)。
