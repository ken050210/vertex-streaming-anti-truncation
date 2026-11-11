# Gemini 4 Argon

中文 | [English](GEMINI4.en.md)

核对日期：2026-10-14。正式模型 ID 为 `gemini-4-argon`，Vertex OpenAI 兼容接口使用 `google/gemini-4-argon`。推荐使用 `global`；Google 也列出 `us`、`eu`。

## 升级方式

酒馆插件部分随 SillyTavern 集成 0.4.0（`sillytavern-v0.4.0`）发布，更早的安装包不含此适配。独立网关部分随网关 0.8.0 发布，支持源码和 Docker 部署。

- 独立网关：停止网关后，在本仓库执行 `git pull --ff-only`、`npm ci --ignore-scripts`，再启动。若本地有冲突，先处理自己的修改，不要覆盖配置；保存的模型、凭据、输出额度和超时不自动改变。
- 酒馆 Git 安装：同步更新 UI 扩展和服务端插件至同一个 `main` 提交，服务端运行 `npm ci --ignore-scripts`，再重启酒馆、刷新页面。具体目录和迁移方式见[酒馆更新说明](SILLYTAVERN.md#更新与已有手动安装)。
- 一键安装包用户：下载 `sillytavern-v0.4.0` 的安装包再运行一次；或从更新后的源码运行 `npm run package:sillytavern`，使用新生成的 `dist/sillytavern` 安装包。不要把 Git 副本直接覆盖到安装包管理的目录上。

本次开发验收只生成并检查了安装包，没有更新现有酒馆安装。

## 添加模型

在独立网关的“模型与版本”页面手动输入 `gemini-4-argon`，勾选所需的正常、非流式抗截断和流式抗截断版本，添加后保存。也可以先拉取目录。已有 3.7/3.8 配置与默认入口不自动替换。

连接配置支持完整服务账号 JSON、Express 快速模式 API Key、短期 OAuth token。Express 调用 Argon 时必须填写 API Key 所属的项目 ID 或项目编号，请求地址才会明确包含 `projects/{项目}/locations/global`；未填写时请求在本地返回 `express_project_required`，旧配置仍可读取和修改。快速 key 是 Vertex Express key，不等于任意 AI Studio key；账户能否调用 Gemini 4 仍取决于 Google 的权限与当前可用性。目录拉取失败时可以手动填写 ID，目录也不证明模型调用权限。

可以自定义上游 **Gemini 模型 ID** 与客户端显示名称。独立网关除了官方 Vertex，也可以改接提供 Gemini 模型的 OpenAI 兼容服务，见[自定义上游](GATEWAY.md#自定义上游)。这时 Argon 的思考等级等参数照原样发给上游，是否生效由上游决定；流式抗截断也不走 Vertex 原生参数流。酒馆的“自定义 OpenAI 连接”可以连接本地网关，这与网关自己接哪个上游是两回事。

## 请求兼容

- `reasoning_effort: low|medium|high` 转成 `thinking_level: LOW|MEDIUM|HIGH`。未指定时保留模型默认 MEDIUM；`auto` 也保留默认。旧客户端的 `none/min/minimal` 对应 LOW，`max/xhigh` 对应 HIGH，不能彻底关闭思考。显式 `extra_body.google.thinking_config` 优先。
- 数字 `thinking_budget` / `thinkingBudget` 和显式 `cached_content` 返回本地 400，并给出固定错误码；不静默丢弃用户的预算或缓存语义。
- 去掉 Google 迁移清单要求移除的采样参数、惩罚参数与 `n`。原有预填充转 USER 开关扩展到 Argon；仅转换末尾纯文本，保留工具与思考历史。
- 原生酒馆插件独立处理 Argon 思考等级，不依赖旧酒馆版本只认识 Gemini 2.5/3 的预算函数。需要用户所在酒馆能够选择或输入该模型。
- TauriTavern 适配版中，Argon 的思考等级与采样参数由 TauriTavern 自己处理，需要其版本已收录该模型；扩展只把超出的输出额度压到 65,536。见 [TauriTavern 说明](SILLYTAVERN.md#tauritavern)。
- 原生工具调用 ID 与思考签名通过不透明的 `vtx4.` 工具 ID 一起往返。客户端回传工具结果时必须完整保留服务返回的 ID。
- 输出额度超过单次上限时不再报错，见下方[输出上限与自动续写](#输出上限与自动续写)。
- 复杂请求可能需更长等待，可按需把已有超时设置调至 900,000 ms 或更高；升级不会改写旧超时。

## 输出上限与自动续写

本节内容随独立网关 0.11.0 与酒馆集成 0.6.0 发布；更早的版本在额度超限时返回 `gemini4_long_decode_required`。

Google 规定 Argon 单次请求最多输出 65,536 token（流式）或 32,768 token（非流式），思考也算在内。官方的 long decode（长解码）可以把一次回复拆成多次请求接着写，总共最多 1,048,576 token（要减去输入）；只有 `v1beta1` 接口支持。见 [Gemini 4 开发指南](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon)的 Long decodes 一节。

### 默认：按单次上限发送

自动续写默认关闭。输出额度超过单次上限时，按这次实际发给 Google 的请求是否流式，改按单次上限发送，不再返回 `gemini4_long_decode_required`，也不追加请求。客户端或预设里保存的值不会被改写。酒馆的“测试消息”只发一句 Hi 也带着预设的额度，以前会因此报错，现在照常发送。

| 入口 | 按多少发送 |
| --- | --- |
| 独立网关直连 Google（原生或兼容接口） | 发给 Google 的是流式请求时 65,536，否则 32,768。非流式抗截断（缓冲版本）即使向客户端输出 SSE，也是非流式请求 |
| 独立网关的自定义上游 | 一律 32,768，因为中转怎样调用 Google 网关看不到 |
| 酒馆插件接管的请求 | 开启酒馆流式输出并选择「流式抗截断」时为 65,536，包括当前轮或全部会话转图。非流式请求（如测试消息）、缓冲模式和仅转图时为 32,768 |
| TauriTavern | 65,536（它总是发流式请求） |
| 插件不接管、交给酒馆原流程的请求 | 不改动 |

响应头 `x-gemini-output-tokens-requested`、`x-gemini-output-tokens-applied`、`x-gemini-long-decode` 和网关日志的 `outputLimit` 记录请求的额度、实际发送的额度和是否启用续写；酒馆面板会显示本次按多少发送。额度在单次上限以内的请求不受影响。

### 回复真写满单次上限时

自动续写关闭、而这次回复确实写到了单次上限时：

- 回复停在上限处，结束原因是长度截断（Google 的 `MAX_TOKENS`，OpenAI 格式为 `length`）。不报错，也不显示为正常写完。
- 思考也占额度：思考越长，正文越少；极端时正文为空。
- 流式抗截断会保留已经写出的部分。缓冲方式（非流式抗截断）可能拿不到正文：2026-10-14 在 Gemini 3.7 Flash 上把上限设为 300 实测，Google 只返回思考和 `MAX_TOKENS`，没有返回工具调用，最终正文为空；也可能是那 300 的额度先被思考用完，Argon 上没有复测。普通请求（不抗截断）按 Google 的常规行为保留已写部分，本项目没有专门实测。
- 在酒馆里可以点“继续”接着写，这会再发一次请求，正常计费。

### 开启自动续写

在独立网关的「连接配置 → SillyTavern 兼容与重试」中勾选「Gemini 4 Argon 超长回复自动续写」，仅命令行模式用 `GEMINI_LONG_DECODE=true`。新装酒馆插件使用单次上限。过渡版为先前已启用自动续写的配置保留旧入口，关闭并刷新后收起。

- 只对输出额度超过单次上限的 Argon 请求生效：改用 `v1beta1` 原生接口，按客户端的额度发送（超过 1,048,576 时按 1,048,576）。Google 写满一次后返回 `CONTINUATION` 和续写令牌，网关或插件带着令牌把同一请求再发一次，直到 Google 正常结束，再拼成一条回复交给客户端：结束原因只出现一次，用量逐次相加。
- 只有回复真的写超单次上限才会追加请求；短回复仍是一次请求，费用不变。
- 独立网关直连时，平时走兼容接口的请求（完整模式下的正常、缓冲版本）会改走原生接口。原生接口无法无损表达的请求（例如带 `logprobs`）仍按单次上限发送，响应头 `x-gemini-long-decode` 为 `false`。
- 自定义上游：额度原样转发，不压低；是否支持由上游决定。
- TauriTavern：不可用，仍按 65,536 发送。请求由 TauriTavern 的后台发出，扩展无法跟随续写令牌。

### 兼容性风险

开启前请了解：

- **抗截断与续写的配合未经真实超长输出验证。** 流式抗截断假定续写请求会接着同一个工具参数往下写；如果 Google 改为重新开始或换一种结构，回复会以 `anti_truncation_native_` 开头的错误结束，不会把不完整的内容当成正常回复。缓冲方式下工具调用跨请求时是什么样子目前未知，同样可能失败。
- **Express、Flex、Priority 在 `v1beta1` 上未验证。** 2026-10-20 只用服务账号、Standard、global 发过不触发续写的短请求。
- **费用。** 每续写一段都会重新发送完整上下文，并再计一次输入费用；Google 的隐式缓存可能打折，价格没有核实。网关日志的用量和费用估算按所有请求相加。
- **等待时间。** 整次请求（包括所有续写）仍受上游超时限制：独立网关默认 10 分钟，可在设置里调到最多 30 分钟；酒馆插件固定 10 分钟。很长的回复可能因此超时。
- **中途失败。** 流式回复已经发出的部分收不回，结尾以错误事件结束；非流式回复整条报错，已写内容不会交付。不自动重试。某一次续写没有产出任何内容时停止并报 `long_decode_no_progress`，避免无限循环。
- **总上限。** 输入加输出超过模型的总上限时由 Google 决定如何处理，未验证。

### 验证状态

离线测试用模拟响应覆盖各入口的压低规则、非流式和流式的多次续写拼接、续写失败和无进展停止。真实请求只发过短请求（2026-10-20，服务账号、Standard、global，合并发布代码前后各 3 条，每条约 140～185 输入、20～45 输出 token）：开启续写时 `v1beta1` 的流式和非流式请求都接受 100,000 的额度并一次完成；关闭时缓冲请求按 32,768 发送成功。真正跨请求的续写还没有真实验证，会根据实际使用超长输出的反馈调整。

## 常见本地错误

| 错误码（HTTP 400） | 处理方式 |
| --- | --- |
| `express_project_required` | 在快速模式中补填 API Key 所属的项目 ID 或项目编号并保存，以指定 global 地区。 |
| `invalid_gemini4_thinking_level` | 使用 `low`、`medium` 或 `high`，显式 Google 配置使用 `thinking_level`。 |
| `unsupported_gemini4_thinking_budget` | 删除数字预算，改用思考等级。 |
| `unsupported_gemini4_cached_content` | 删除显式缓存引用；此处不提供该功能。 |
| `gemini4_long_decode_required` | 只有本次更新之前的网关或酒馆服务端插件会返回。更新到当前版本；或把输出额度降到 32,768（非流式）／65,536（流式）以内。 |
| `invalid_tool_history` | 保留服务返回的完整 `tool_call.id`；损坏的历史需要修正后再发送。 |

## 母仓库

[LLM Subscription Router](https://github.com/ken050210/llm-subscription-router) 同步加入 `gemini-4-argon`、`抗截断-gemini-4-argon` 和 `实验性-流式抗截断-gemini-4-argon`。模板与已有运行配置是两份数据，拉取源码不会替换已有运行配置；添加时复用自己的 Vertex 账号与路由。母仓库的普通 OpenAI-compatible 账号支持自定义上游 URL；本独立网关现在也支持 OpenAI 兼容格式的[自定义上游](GATEWAY.md#自定义上游)。

## 官方依据

- [Vertex Gemini 4 开发指南](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon)
- [Vertex 模型迁移清单](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/migrate)
- [Gemini API 新模型说明](https://ai.google.dev/gemini-api/docs/latest-model)

代码测试、真实短请求、Express 账户权限、酒馆安装后的浏览器验证和长篇生成质量是不同验收项；本次具体结果见[验收说明](VALIDATION.md)。
