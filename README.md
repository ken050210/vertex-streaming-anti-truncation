# Vertex Streaming Anti-Truncation

中文 | [English](README.en.md)

为 Vertex AI / Gemini 提供本地模型管理与工具调用抗截断传输。每个上游模型可保存正常、非流式抗截断和流式抗截断版本，可接入 SillyTavern 的自定义 OpenAI 连接。

实验版，支持配置多个 Gemini 模型；默认保留 Gemini 3.7 Flash 的原有入口。模型与流式参数功能是否可用取决于上游。需要 Node.js 22.9+，无第三方运行时依赖。

## 来源

合成工具传输方案参考 [Xeltra233](https://github.com/Xeltra233) 的 [Antigravity-gateway](https://github.com/Xeltra233/Antigravity-gateway)。

## 控制台预览

以下截图使用演示配置与模拟上游数据，展示浅色和深色主题。截图中的端口为演示端口；默认控制台端口为 `4780`，API 端口为 `4781`。

**总览**：查看网关状态、客户端接入地址、模型版本与最近请求。

![浅色总览：网关状态、客户端接入和请求记录](docs/screenshots/console-overview.jpg)

<details>
<summary>连接配置：项目 ID、服务账号 / Express API Key、Standard / Flex / Priority</summary>

![连接配置：项目 ID、完整服务账号 JSON、鉴权方式和服务等级](docs/screenshots/console-connection.jpg)

</details>

<details>
<summary>模型与版本：拉取目录，同一模型保存正常、非流式抗截断和流式抗截断版本</summary>

![深色模型管理：示例模型目录及两个模型各自的三种版本](docs/screenshots/console-models.jpg)

</details>

<details>
<summary>连接测试：流式正文、还原状态与正文到达统计</summary>

![深色连接测试：模拟流式回复、正文还原结果和到达统计](docs/screenshots/console-streaming-test.jpg)

</details>

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

支持完整 Vertex AI 服务账号、Express 快速模式 API Key，以及短期 OAuth access token。完整模式需要已启用 Vertex AI API 的项目和模型调用权限。实际推理按你的 Google Cloud 账户计费。

```sh
git clone https://github.com/ken050210/vertex-streaming-anti-truncation.git
cd vertex-streaming-anti-truncation
npm ci --ignore-scripts
npm start
```

打开终端显示的本地控制台链接，默认地址为 `http://127.0.0.1:4780/`。首次启动会显示带设置密钥的链接；打开它即可进入设置。Windows 也可以双击 `Start-GUI.cmd`，无需预先创建 `.env`。

控制台支持深浅主题和窄屏布局：

- **连接配置**：填写项目 ID，粘贴或导入完整服务账号 JSON；也可切换到 Express API Key 或短期 OAuth Token。服务账号 JSON 中的项目 ID 可自动填入，也可覆盖为另一个有权限访问的目标项目。
- **服务等级**：显式选择 Standard、Flex 或 Priority。Express、Flex 和 Priority 使用 `global`。Express 的项目 ID 可选填，仅作备注，其请求端点不包含项目和地区。
- **本地网关**：设置 API 端口、超时和随机网关密钥。复制生成的网关密钥后再保存，后续凭据不回显；空白凭据字段保留已有值。
- **模型与版本**：拉取并搜索 Google 模型目录，批量添加所需版本；也可手动填写上游 ID。分别编辑客户端名称、上游模型与传输模式，最多保存 100 个版本。
- **总览与日志**：启动/停止网关，复制客户端 URL，检查请求状态、正文还原、结束原因以及请求档位/实际上游档位。记录仅保留最近 200 条。
- **连接测试**：选择已保存的模型版本，勾选后手动发送一次最多 512 token 的测试，支持流式和普通响应、取消，以及流式正文到达统计。保存、校验、启动与拉取目录均不触发推理。

配置保存到用户目录的 `~/.vertex-streaming-anti-truncation/settings.json`，可通过 `GATEWAY_STATE_DIR` 指定其他目录。凭据保存在本机明文文件中，请使用私人目录并限制文件访问。配置不会写进仓库或浏览器存储。保存采用版本检查和原子替换；端口冲突不会替换正在使用的配置。新请求使用新设置，正在进行的回复继续使用原设置。重启控制台会读取保存的配置并启动网关。用已设置的网关密钥再次登录。

`GUI_PORT` 可更改控制台端口，默认 `4780`；API 端口默认 `4781`。保存的 GUI 配置优先于 `.env`。尚无保存配置时，可从已有 `.env` 初始化。

### 添加多个模型及版本

1. 在“连接配置”填写凭据，再进入“模型与版本”点击 **拉取 Model List**。拉取使用当前表单与已保存的凭据，无需先启动网关。
2. 搜索并勾选一个或多个上游模型，选择需要的版本，点击添加。目录不可用时，也可填写 `gemini-…`、`google/gemini-…` 或 `publishers/google/models/gemini-…`。
3. 按需修改客户端模型名称，再点 **保存全部配置**。它会一起保存连接和模型草稿；刷新客户端的模型列表即可选择。

| 版本 | 行为 | 自动生成的名称 |
| --- | --- | --- |
| 正常 | 不加包装，遵循客户端的 `stream` 开关 | `<model>` |
| 非流式抗截断 | 上游完整返回后还原；客户端要求 SSE 时一次性交付正文 | `<model>-antitruncation-nonstream` |
| 流式抗截断 | 客户端开启流式时使用原生参数流；关闭时还原普通 JSON | `<model>-antitruncation-stream` |

三个版本可同时存在，分别通过 `/v1/models` 暴露。名称必须唯一，可以用中文。添加时跳过已有的“上游 + 模式”组合；手动编辑仍可为同一组合保留不同别名。空列表会使客户端没有可选模型。

升级会保留原来的 `gemini-3.7-flash-antitruncation` 名称：原先开启包装时迁移为流式抗截断，关闭时迁移为正常版本。新配置以每个版本的模式为准，不再受旧全局开关影响。

目录来自 Google 的 [Publisher Models 列表接口](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1beta1/publishers.models/list)，自动分页并筛选 Gemini。它是发布目录，不能证明目标项目、地区、档位或某种模态可以调用。Express 的[公开接口范围](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/express-mode/api-reference)未保证模型列表；如果 API Key 被拒绝，页面显示真实 HTTP 状态，可手动添加或改用服务账号拉取。失败不会清空已有模型，也不会用内置目录伪装拉取成功。

### 仅命令行模式

将 `.env.example` 复制为 `.env`：Windows PowerShell 使用 `Copy-Item .env.example .env`；Linux/macOS 使用 `cp .env.example .env`。然后填写：

- `GATEWAY_API_KEY`：自己生成的随机本地访问密钥，至少 16 字符。
- `VERTEX_PROJECT_ID`：Google Cloud 项目 ID。`VERTEX_LOCATION` 默认 `global`。
- `GOOGLE_APPLICATION_CREDENTIALS`：仓库之外的服务账号 JSON 路径。Windows 可写成 `C:/keys/service-account.json`。
- 如需用短期 Google OAuth access token，删掉上一项，改填 `VERTEX_ACCESS_TOKEN`。快速模式改填 `VERTEX_API_KEY`，不要求项目 ID。三种鉴权方式只能选一种。
- `VERTEX_SERVICE_TIER`：`standard`（默认）、`flex` 或 `priority`。`ANTI_TRUNCATION=false` 可关闭包装。
- `PORT`：默认 `4781`。

用以下命令生成随机网关密钥，填入 `.env` 后启动：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm run gateway
```

服务只监听 `127.0.0.1`。`GET /healthz` 检查进程状态；其余接口都需要 `Authorization: Bearer <GATEWAY_API_KEY>`。服务账号私钥只在本机签署 JWT，JWT 发给 Google OAuth 换取短期 access token，再用于模型请求。

## 接入 SillyTavern

在“聊天补全 → 自定义（兼容 OpenAI）”连接中设置：

| 设置 | 值 |
| --- | --- |
| API URL | `http://127.0.0.1:4781/v1` |
| API Key | GUI 中设置的本地网关密钥，或 `.env` 中的 `GATEWAY_API_KEY` |
| 模型 | 刷新列表后选择保存的版本；默认 `gemini-3.7-flash-antitruncation` |
| 流式传输 | 按需开启；非流式抗截断会等待完整回复 |

如果预设已经有同类工具调用抗截断脚本，只保留一处包装。

网关兼容 `thinking: {type: "disabled"}` 这个 Anthropic 格式字段，但会按 Vertex 兼容接口的原行为忽略它；它不会关闭 Gemini 思考。Gemini 思考设置使用 `extra_body.google.thinking_config`。

### 角色扮演兼容设置

在 **连接配置 → SillyTavern 兼容与重试** 中单独控制以下功能。旧配置升级后也使用这些默认值。

| 功能 | 默认 | 行为 |
| --- | --- | --- |
| 隐藏无可用路由的模型 | 开启 | `/v1/models` 隐藏停用版本及已知鉴权失败的连接；临时错误不影响显示 |
| Gemini 3.7 / 3.8 Flash 预填充转 USER | 开启 | 在抗截断包装前，把末尾纯文本 `assistant` 消息改为 `user`，原文不变 |
| 提示词提交失败重试 | 关闭 | 先在 GUI 填入自定义文本，启用后仅对指定提交错误追加一次请求 |

独立网关共用一套上游连接。模型页面的“启用”开关可以停用版本并保留名称和配置；停用版本即使因关闭隐藏而显示，也不能调用。上游返回 HTTP 401 后，该连接的版本会被隐藏。修正凭据后保存应用、重启，或下一次直接调用成功，会清除这项观察。HTTP 403/404/429、超时和 5xx 不用于隐藏模型，也不会主动发起推理探测。目录不能保证 Google 项目拥有某个模型的调用权限。

Google 的 [Gemini 3.7 Flash](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-7-flash#mandatory-api-rules-and-behavioral-conventions) 和 [3.8 Flash](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash#mandatory-api-rules-and-behavioral-conventions) 文档要求对话不能以 `model` 结束，并要求移除预填充。转为 USER 是本项目保留原文的兼容措施，改变了消息角色，不保证模型按原预填充续写。只处理文本字符串或全为文本的内容数组；带工具调用、思考或其他额外元数据的末条消息保持原样。

重试使用正则 `/\bThe prompt could not be submitted\b/i`：忽略大小写，内部空格必须相同，允许前后附带说明。匹配 `error.message` / 字符串 `error`；HTTP 非成功响应和 SSE `event: error` 也接受顶层 `message` 或纯文本错误。检查 HTTP 错误、200 错误对象及开头的 SSE 错误，初始检查上限 64 KiB；正常回答引用该句不触发，遇到正文、思考或工具输出等有效事件即停止检查。

自定义文本建议自行准备约 7000 tokens；页面计数只是粗估，未调用 Google tokenizer。文本最多 192000 UTF-8 字节，按原样插入到开头连续的 `system` / `developer` 消息之后、其余对话之前，不补齐、不重复、不截断。每个客户端请求最多重试一次，保持同一模型、凭据和服务等级；请求取消、超出大小限制或输出已开始时不会重试。第二次仍失败就结束。此功能可能增加输入费用、上下文占用和等待时间，不保证提交成功。

日志仅增加 `geminiCompatibility.prefillConverted` / `promptRetried` 两个布尔值，GUI 显示转换和重试标记；不记录自定义文本。响应头为 `x-gemini-prefill-converted` / `x-gemini-prompt-retried`。仅命令行模式使用 `HIDE_UNAVAILABLE_MODELS`、`GEMINI_PREFILL_TO_USER`、`GEMINI_PROMPT_RETRY_ENABLED`，以及指向仓库之外 UTF-8 文本文件的 `GEMINI_PROMPT_RETRY_TEXT_FILE`。

## 适用范围与限制

流式抗截断版本的纯文本流式请求优先使用原生函数参数分段。Standard 服务账号/OAuth 模式的非流式请求使用 Vertex OpenAI 兼容接口；无法翻译的扩展字段、媒体或额外消息元数据保留原参数并回退到兼容接口，此时可能仍需等待全文。响应头 `x-anti-truncation-transport` 会显示 `tool-transport-buffered-fields`。

Express、Flex 和 Priority 的普通/流式请求均走原生接口。支持文本、内嵌 base64 图片、函数工具与工具历史、JSON/Schema、候选数量及常用采样/思考参数。不支持远程图片 URL、旧式 `functions`、`parallel_tool_calls`、logprobs 或未知扩展字段，遇到无法保留的参数返回 `400 unsupported_native_fields`，不会静默丢弃或改走 Standard。已有工具或结构化输出仍会跳过抗截断包装，原生接口继续正常翻译请求。

已有 tools/functions、显式工具选择、工具历史、JSON/Schema 输出或多候选的请求会跳过包装，并继续遵循客户端的流式开关。真实工具、usage、思考元数据，以及 `length` / `content_filter` 等结束原因会保留。流中断会报错；网关不自动续写或重试已经开始输出的回复。

“抗截断”指通过工具参数传输并恢复已收到的文本。它不能恢复模型未生成或网络未收到的内容，也不能保证消除截断或绕过模型限制。

网关不会自动升级、降级或切换所选服务等级。Flex/Priority 发送官方服务等级标头，实际使用的等级以响应 `usage.traffic_type` 及日志 `trafficType` 为准；缺失时显示“上游未报告”。模型、账户及 Express 对档位的实际支持须由真实请求验证。参见 [Express 端点](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/express-mode/overview)、[Flex](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/flex-paygo) 和 [Priority](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/priority-paygo) 官方说明。独立包不含多账号调度或额度管理。

## 响应与 Schema 校验

所有模式均检查普通回复和 SSE 的有效输出、结束原因与 DONE。空回复、只思考却声称正常完成、错误事件、半截流和不完整工具参数会失败；长度上限、内容拦截与客户端取消分别记录。`responseIntegrity` 日志仅含固定状态，不含回复内容。

非流式异常区分 `invalid_choice`（候选项不是对象）、`missing_message`（消息缺失或为空）、`invalid_message`（消息类型错误）和 `unexpected_stream_chunk`（收到仅含 delta 的流式片段）。校验失败时仍保留已知结束原因与空回复状态，客户端错误中的 `responseIntegrity`、日志和 GUI 使用同一份固定字段。缺失消息仍是失败，不补造正文，也不会因此触发自定义文本重试；旧日志缺失的信息无法追补。

原生结构化输出通过 `responseJsonSchema`、工具参数通过 `parametersJsonSchema` 保留约束；不会删除 `additionalProperties`，不会误删同名业务属性，也不会缩窄无 items 数组。支持范围内的 `strict: true` 输出在完成时接受本地 Schema 校验。`oneOf`（上游语义与 JSON Schema 不同）、`pattern` 等不支持的约束在鉴权/推理前返回 `400 unsupported_native_schema` 和参数路径。

普通文字持续流式传递；仅显式结构化 JSON 与工具参数为校验使用有大小上限的临时缓冲。结构化流的最终校验失败会中断响应，不会自动补 JSON、续写或重试。Standard 兼容接口仍按原请求转发，其 Schema 约束由上游处理。

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
# 可选：发送两条短请求，每次最多 512 输出 tokens；开启重试时最多 4 次上游提交
npm run smoke -- --live
```

烟测默认使用已保存的 GUI 配置，没有保存配置时使用环境变量；仅命令行服务可加 `--env` 强制使用 `.env`。默认测试第一个流式抗截断版本，也可加 `--model 你的模型名称` 指定；正常和非流式版本可在 GUI 测试页验证。

默认测试使用本地模拟数据，不需要真实凭据，也不产生推理费用。烟测会统计正文到达次数和时间跨度，并用响应请求 ID 核对日志。验证范围见 [docs/VALIDATION.md](docs/VALIDATION.md)。
