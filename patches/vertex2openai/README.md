# vertex2openai 文本工具参数流补丁

本补丁针对 [bad-woman/vertex2openai 的 53a45b6](https://github.com/bad-woman/vertex2openai/tree/53a45b63bfef39e783edf8ea9c1e06800fc17496)，为单字符串工具启用参数增量流，覆盖本网关的文本传输用途。2026-10-19 已在云端通过 Gemini 4 Argon 的真实参数流和完整 HTTP 路径验收；实测使用标准 Vertex 服务账号，Express API Key 鉴权仍未实测。本仓库随网关 0.22.0 提供此补丁，需自行应用到指定上游版本。

该版本的 Express SDK 真流式路径调用 `generate_content_stream`，但没有设置 `stream_function_call_arguments`；转换器仅读取完整的 `fc.args`，每个片段都会分配新工具索引。只增加请求字段会丢失或错误拼接参数，必须同时修改响应转换。

## 适用条件

- vertex2openai 使用 Express SDK 通道，并关闭“假流式”；Cookie 通道不在本补丁范围内。
- 实际模型名为 Gemini 3 或更新版本，排除 Gemini 3.1 Flash-Lite。Google 将该功能列为 Preview；本页实测组合之外的模型、项目和端点仍需验证。
- 请求为流式、单候选、只有一个工具，强制调用该工具；参数为一个必填字符串属性，且 `additionalProperties: false`。属性名限 ASCII 字母、数字和下划线，首字符不能是数字。工具名称和属性名称无需绑定本项目。
- 安装的 google-genai 必须同时提供 `FunctionCallingConfig.stream_function_call_arguments`、`FunctionCall.partial_args` 和 `FunctionCall.will_continue`。补丁会检查 SDK 字段，旧 SDK 保持原有行为，不会宣称启用成功。

普通聊天、不符合上述 schema 的工具、多工具、非流式和假流式请求保持原路径。外层网关无需新增 Google 原生字段：它已经能还原 OpenAI 格式的工具参数增量。请求日志仍可能显示“兼容接口回退（可能等全文）”，此标签表示外层使用的协议，不能用它判断中转是否逐段交付。

## 应用与验证

在 vertex2openai 仓库目录执行，把路径替换为本补丁的实际位置：

```sh
git apply --check /path/to/stream-function-arguments.patch
git apply /path/to/stream-function-arguments.patch
python -m unittest discover -s tests -p test_text_tool_stream.py -v
```

若检查失败，先按当前上游版本重新合并，勿强行覆盖文件。检查 SDK 是否提供所需字段：

```sh
python -c "from google.genai import types; print('stream_function_call_arguments' in types.FunctionCallingConfig.model_fields, {'partial_args', 'will_continue'} <= types.FunctionCall.model_fields.keys())"
```

两个结果均应为 `True`。按项目原有方式重启或重建 vertex2openai 后，外层网关选择自定义上游的“流式抗截断”模型版本即可。真实验收应观察一次响应中的正文能否在结束前持续到达，并核对正常结束或错误状态；仅看到请求字段为 true 不能证明上游已接受。

补丁修改 `app/api_helpers.py`，新增 `app/text_tool_stream.py` 和 `tests/test_text_tool_stream.py`。响应转换保留同一个工具索引，只发送一次 ID 和名称，逐段转义并输出参数，保留签名扩展；支持 Google 的无值字符串结束片段。断流、未闭合参数和结束后数据会报错；MAX_TOKENS 与 SAFETY 仍分别返回 length 和 content_filter。文本工具流中途异常会发送错误事件，不会只发 DONE。

8 项离线测试执行实际转换函数和真流式生成器，SDK、网络和签名辅助函数使用替身；覆盖提前交付、参数拼接、稳定索引、签名扩展、完整参数回退、普通多工具、中断、长度及安全终止。

另用 google-genai 2.31.0 与 httpx MockTransport 完成了离线 SDK 检查：实际序列化的 HTTP 请求保留了参数流字段，真实 SDK 能解析包含无值字符串结束片段的响应并还原参数。该检查不访问 Google，仍不证明端点接受该选项或真实流式行为。

## 2026-10-19 云端实测

固定 `google-genai==2.31.0`、`gemini-4-argon`、`global`、低思考等级和 `max_tokens=1024`。每轮只有一次生成发送尝试，关闭各层自动重试，单请求截止为 120 秒。两轮成功结果如下；时间从各轮开始计起：

| 验证路径 | Google HTTP | 非空参数分片 | 首段有效文字 | OpenAI 结束 | 文字提前到达 | 返回总 token |
| --- | --- | --- | --- | --- | --- | --- |
| SDK + 生产生成器/转换器 | 200 | 5 | 9.735 秒 | 11.267 秒 | 1.532 秒 | 230 |
| 完整回环 HTTP 服务 + 默认续传缓冲 | 200 | 5 | 8.906 秒 | 11.324 秒 | 2.418 秒 | 233 |

两轮均实际发送 `stream_function_call_arguments: true`，收到 5 个非空 `partialArgs` 和一个空字符串结束片段，没有收到完整 `args` 替代增量。工具索引稳定为 0，ID/名称各发送一次，拼接参数为有效 JSON，Google 结束原因为 `STOP`，OpenAI 为 `tool_calls`，实际返回 `traffic_type=ON_DEMAND`。

完整 HTTP 验收经过 `main.app`、Bearer 鉴权、`/v1/chat/completions`、提示转换、`ExpressSDKUpstream`、SDK、生产转换器和默认续传缓冲。测试脚本仅替换 SDK 客户端初始化，使用服务账号的短期令牌；路由占位 Key 不发送给 Google。启动时的远程探测、回退与自动工具执行关闭。因此，这验证了生产参数流转换和 HTTP 路径，未验证 Express API Key 的鉴权与配额行为。

共记录 3 轮发送尝试：首轮没有 HTTP 响应，是否到达 Google 未知；修复测试脚本的环境代理接入和异常记录后，后两轮成功。生产补丁无需继续修改。云端验收补丁与本文件逐字节相同，完整 SHA256 见下方验收记录。

原 8 项测试全部通过。两轮真实录制数据的回放验证了正常结束、缺失结束、字符串中断、提前 STOP、结束后继续数据以及长度/安全截止。将两轮真实 OpenAI SSE 再交给本网关的 `wrapAntiTruncationStream` 离线回放，150 字和 163 字正文均完整还原，并在源流结束前输出，最终 `restored=true`、`finish_reason=stop`；此回放未新增 Google 请求。

[下载 2026-10-19 验收记录（JSON）](https://github.com/ken050210/vertex-streaming-anti-truncation/releases/download/gateway-v0.22.0/verification-20261019.json)。其中的补丁与输出摘要哈希来自当次验收。本次发布已在固定上游版本复核补丁应用及 8 项离线测试。

本补丁不处理容量/配额 429、Gemini 4 单次输出上限或两层网关之间的思考等级字段转换。

协议依据：[Google 参数流说明](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tools/function-calling#streaming_function_call_arguments)、[Python SDK 字段定义](https://github.com/googleapis/python-genai/blob/main/google/genai/types.py)。
