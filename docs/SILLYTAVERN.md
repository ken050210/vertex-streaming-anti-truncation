# SillyTavern 与 TauriTavern 的 Vertex 扩展

扩展把「抗截断传输」加到酒馆的「API 连接 → Google Vertex AI」面板。它使用你选好的模型、地区、服务等级和酒馆里已有的凭据。抗截断默认关闭。

| 你用的酒馆 | 安装位置 | 如何确认加载 |
| --- | --- | --- |
| [TauriTavern（TT 酒馆）](#tauritavern) | 在 TT 里安装完整仓库作为 UI 扩展 | Vertex 面板底部显示 TauriTavern 说明 |
| [SillyTavern 1.19.x](#选哪种装法) | UI 扩展装在浏览器端，插件装在运行酒馆的服务器上 | 面板的「检查插件连接」显示服务端已就绪 |
| [手机浏览器或 Termux](#手机上怎么装) | 在运行酒馆的设备上安装 | 依所用酒馆核对上面对应的一行 |

已经装好的用户可以直接看[传输模式](#使用)、[标签截停](#自定义标签截停)或[更新方法](#更新与已有手动安装)。命令行代装步骤见[给 AI 助手的安装指引](AGENT-INSTALL.md)。

## TauriTavern

在「扩展程序 → 安装扩展」粘贴下面的 Git URL，分支留空。TT 使用 Rust 后台，只需 UI 扩展，桌面版与手机 App 的界面入口相同。[TauriTavern 项目](https://github.com/Darkatse/TauriTavern)

```text
https://github.com/ken050210/vertex-streaming-anti-truncation
```

重新加载后，打开「API 连接 → Google Vertex AI」。底部应显示「TauriTavern 扩展已加载」。选择抗截断模式后，展开「传输与截停」即可配置截停规则和预设正文工具名。

桌面端也可以先关闭 TT，把完整仓库克隆到 `<数据目录>/default-user/extensions/vertex-streaming-anti-truncation`。便携版通常使用程序旁的 `data`，安装版使用应用数据目录下的 `com.tauritavern.client/data`。如果上一级目录里有 `tauritavern-runtime.json`，以它的 `data_root` 为准。SillyTavern 的 ZIP 和 `dist/sillytavern/extension/` 都省略了 TT 需要的模块，手动安装也要用完整仓库。

### TT 如何接收回复

TT 后台负责提示词转换、凭据、采样参数和思考设置。扩展把所需的 `tools` 和 `toolConfig` 合并到「附加参数」(`custom_include_body`)，仍向酒馆的 `/api/backends/chat-completions/generate` 发送一次请求。附加参数可以留空或填 JSON 对象。填了 YAML 时，面板会说明原因，本次走普通 Vertex。

两种抗截断模式都读取 TT 转发的 `streamGenerateContent` 事件，以便检查 Google 的原始结束原因。流式抗截断配合酒馆流式开关使用 `streamFunctionCallArguments`，文字到一段显示一段。非流式抗截断等正文通过检查后整段交付。命中截停规则时，两种模式都会在结束标签处结束读取，按酒馆要求的格式交付回复。

TT 支持 Unicode 转码、“继续”和用户上传的图片。将文字渲染为图片需要 SillyTavern 的服务端组件。Gemini 4 Argon 的思考和采样由支持该模型的 TT 版本处理，2.3.0 稳定版未收录它。TT 上的 Argon 请求最多使用 65,536 个输出 token，超过时面板显示实际额度。超长回复自动续写需要能跟随 Google 续写令牌的后台，TT 面板不提供这个选项。

客户端工具参数完整后才交给 TT 执行，正文可以逐段显示。TT 自己负责把调用 ID、思考签名和工具结果转换成下一轮历史。官方 2.4.0 后端通过了工具执行和回传测试，旧版兼容性取决于它的原生历史转换。[验证所用的 TT 修订](https://github.com/Darkatse/TauriTavern/commit/fff9af0333be97697be2313981699ab0ce35c236) · [验收记录](VALIDATION.md)

## 手机上怎么装

| 手机上的用法 | 操作 |
| --- | --- |
| TauriTavern App | 在 App 里按 [TT 安装步骤](#tauritavern)装 UI 扩展 |
| 浏览器连接电脑或服务器上的 SillyTavern | 在那台电脑或服务器上安装，手机刷新网页即可 |
| Termux 运行 SillyTavern | 在运行酒馆的 Termux 窗口按 Ctrl+C，关闭酒馆后运行下面的命令 |

```sh
cd ~
git clone --depth 1 https://github.com/ken050210/vertex-streaming-anti-truncation
cd vertex-streaming-anti-truncation
node scripts/package-sillytavern.mjs
node dist/sillytavern/install.mjs ~/SillyTavern
```

如果酒馆不在 `~/SillyTavern`，换成实际路径。安装程序会列出改动，按回车开始。装好后照常启动酒馆，刷新网页，在 Vertex 面板点「检查插件连接」。运行 `node -v` 可查看版本，需要 Node.js 22.9+。Termux 可以用 `pkg install nodejs` 安装。以后更新时进入 `~/vertex-streaming-anti-truncation`，运行 `git pull --ff-only` 后再执行上面最后两行。

安装程序通过了 Windows、Linux 和 macOS 自动测试。Termux 和手机 TT 的安装流程仍待真机验证。图片渲染组件提供 Android arm64 版本，安装失败时只影响文字转图。

## 选哪种装法

SillyTavern 需要 Node.js 22.9+。扩展按 1.19.0 的 Vertex 面板、提示词转换和回复读取接口适配。下列两种装法选一种，已有安装请先看[更新与迁移](#更新与已有手动安装)。

### 一键安装包

1. 从[项目发布页](https://github.com/ken050210/vertex-streaming-anti-truncation/releases)选择以 `sillytavern-v` 开头的版本，下载对应的酒馆 ZIP 安装包。同页有 `SHA256.txt` 可校验。酒馆至少要启动过一次，生成 `config.yaml`。
2. 关闭酒馆并解压。Windows 双击 `install-windows.cmd`，按提示拖入酒馆文件夹。macOS、Linux 或 Termux 运行 `sh install.sh 酒馆文件夹路径`。命令行代装用 `node install.mjs "酒馆文件夹路径"`。
3. 重启酒馆，刷新网页，按下方[确认安装](#确认安装)检查。

安装程序先检查重复安装，再放置前后端文件。它会在修改 `config.yaml` 前备份原文件，按需开启 `enableServerPlugins`。启用后，酒馆也会加载 `plugins` 下已有的其他插件。替换文件失败时，安装程序恢复原目录。遇到 Git、扩展管理器或手动安装的副本时，它会列出位置并停止。

渲染图片所需的依赖由安装程序联网运行 `npm ci --ignore-scripts` 安装。离线时可加 `--skip-deps`，以后联网再运行安装程序即可补装。无终端输入时程序直接执行，运行前应先关闭酒馆。成功退出码为 0，失败时会打印原因并返回非零退出码。其他 SillyTavern 版本可以接受安装，但加载兼容性需要另行检查。

### 从 GitHub 安装

1. 在「扩展程序 → 安装扩展」填写 `https://github.com/ken050210/vertex-streaming-anti-truncation`，分支留空。按需选择只给自己或所有用户安装。若手动克隆，单用户目录用 `data/<用户名>/extensions/vertex-streaming-anti-truncation`，默认用户是 `default-user`。全用户目录用 `public/scripts/extensions/third-party/vertex-streaming-anti-truncation`。
2. 在 **SillyTavern 根目录**运行酒馆自带的命令安装服务端插件。

```sh
node plugins.js install https://github.com/ken050210/vertex-streaming-anti-truncation
```

3. 进入刚安装的**插件目录**，确认 `cd` 成功后再安装图片渲染依赖。在酒馆根目录运行 `npm ci` 会重装酒馆自己的依赖。

```sh
cd plugins/vertex-streaming-anti-truncation
npm ci --ignore-scripts
```

4. 备份酒馆的 `config.yaml`，把已有的 `enableServerPlugins` 改为 `true`，然后重启并刷新网页。跳过图片依赖时，抗截断和 Unicode 仍可用，文字转图会返回 `503 image_renderer_unavailable`。补装依赖后需重启。

### 确认安装

在「API 连接 → Google Vertex AI → 抗截断传输」点「检查插件连接」。出现“服务端插件已就绪”说明浏览器能访问插件。可直接访问状态端点的安装也能用 `http://127.0.0.1:8000/api/plugins/vertex-anti-truncation/status` 检查，端口以 `config.yaml` 为准。响应应含 `id: "vertex-anti-truncation"`、版本号和 `ready: true`。这一步只检查插件连接，模型调用和图片渲染需要单独验证。

### 从本地源码打包

在仓库中运行以下命令。打包只用 Node.js 自带模块。要运行 `npm run verify` 自检，先安装依赖。

```sh
npm run package:sillytavern
```

可以直接运行 `dist/sillytavern` 里的安装程序。手动安装时，对照下表复制文件，再按 Git 安装的第 3、4 步安装依赖并启用插件。

| 安装包内 | SillyTavern 内 |
| --- | --- |
| `dist/sillytavern/server/vertex-anti-truncation` | `plugins/vertex-anti-truncation` |
| `dist/sillytavern/extension/vertex-anti-truncation` | `public/scripts/extensions/third-party/vertex-anti-truncation` |

## 使用

| 抗截断传输 | 你会看到什么 |
| --- | --- |
| 关闭（默认） | 普通 Vertex 回复。输入转码有自己的开关 |
| 非流式抗截断 | 正文通过完整性检查后整段显示，即使酒馆开着流式输出 |
| 流式抗截断 | 酒馆开启流式输出时逐段显示，关闭时返回完整回复 |

SillyTavern 插件复用酒馆的提示词后处理、角色名、系统提示词、媒体转换、停止串、采样和思考设置。Express、Flex、Priority 的地区设为 `global`。完整服务账号使用酒馆保存的项目 ID。Express 可填密钥所属项目的 ID 或编号，调用 Gemini 4 Argon 时必须填写。凭据保存在酒馆服务端。

插件接管的 Argon 请求会把超额的预设按单次上限发送，流式 65,536、非流式 32,768 token，含思考。写满后可在酒馆点「继续」。需要自动分段续写时，在独立网关启用。升级前已开启此功能的 SillyTavern 用户在本过渡版仍可使用和关闭旧设置，每次续写会重发上下文并计费。关闭并刷新后入口收起。[输出上限与自动续写](GEMINI4.md#输出上限与自动续写)

### 正文传输工具名

在「传输与截停 → 预设正文工具名」填写预设实际声明的函数名，例如 `game_content`。插件复用原声明，将这个调用里的 `content` 显示为正文，其他工具调用仍交给酒馆。目标须在本次请求中唯一同名，且只有一个必填字符串参数 `content`。目标未声明、参数不符、工具被禁用或请求点名其他工具时，本次跳过抗截断，原因显示在插件面板。填入的工具名沿用原有设置。清空后使用内置的 `router_emit`。

仅指定专门交付正文的工具。插件还原正文后，酒馆收到的是普通文本，预设为这个调用设置的动作和工具格式化回调不会执行。SillyTavern 需要配套服务端支持 `preset-transport-tool`，TT 和 PayGo 由扩展直接处理。

## 自定义标签截停

开启抗截断后，展开「传输与截停」，勾选「自定义标签截停」并填标签名和完整出现次数。新配置默认关闭，启用时预填 `tucao` 和 `2`。升级保留原先实际生效的规则，包括依赖旧默认值开启的配置。折叠后仍会显示当前规则。

| 标签名 | 次数 | 保留到哪里 |
| --- | ---: | --- |
| `tucao` | 2 | 第二对完整 `<tucao>…</tucao>` 的结束标签 |
| `A` | 1 | 第一对 `<A>…</A>` 的结束标签 |
| `UpdateVariable` | 1 | 第一对完整变量更新标签的末尾，适用于它已经是本轮最后一个必要块的预设 |

标签名填名称本身，例如 `logic_check`。允许 1 到 64 个 ASCII 字母、数字、下划线、点、冒号或连字符，首字符须为字母或下划线。次数是正整数。

只数当前正文中大小写完全一致、无属性的标签对。单独的 `</A>` 不算，同名嵌套只算最外层一对，流式分块断在标签中间也能识别。原生思考、历史消息和客户端工具参数不参与计数。点“继续”会为新增续文重新计数。没达到次数就按原结束原因交付回复。

**命中的结束标签会保留，它之后的内容全部丢弃。** 例如 Izumi 预设若把同轮 MVU 更新写在第二段吐槽后，默认规则会把变量更新一起截掉。这种布局可以改用最后一个必要块的标签，或关闭截停。额外模型的变量更新是独立请求，有自己的计数。

流式回复在命中标签时立即停显。**截停后接收用量**有三种选择。

| 选项 | 同一条上游请求的处理方式 |
| --- | --- |
| 立即断流（默认） | 保留当前已收到的数据块中的用量，然后断开。 |
| 最多等 250 毫秒 | 短暂等待 Google 回报最终用量。超时就断开。 |
| 等 Google 自然结束 | 持续读取同一条流到结尾，收集 Google 回报的用量。标签后的正文、思考和工具调用都会丢弃，这部分生成仍可能计费。 |

原先勾选等待的用户升级后仍为 250 毫秒。等待期间可以点酒馆的停止按钮。手动停止、连接中断或服务端超时都可能让本次拿不到最终用量。使用分段续写的请求命中标签后仍立即断流，以免触发下一次付费续写。非流式原生回复会保留 Google 回报的整次用量，包括裁掉的部分。

原生酒馆、TauriTavern 和 PayGo 的费用扩展均可从标准字段 `usageMetadata` 读取截停请求的最终用量。插件在 JSON 回复内或流式 `[DONE]` 前提供一次 `vertexUsageReceipt`。其中 `final: false` 表示缺少完整的服务端计数，已收到的字段保存在回执内部。原生酒馆服务端还可用实际发送的文本和可见正文生成 `estimate`，标明分词方法与是否为纯文本。缓存命中和思考 token 只能由 Google 提供。金额由费用扩展按单价估算，实际费用以账单为准。

SillyTavern 的服务端需要报告 `stop-after-tag-pairs` 能力，面板提示版本太旧时可更新服务端或关闭此开关。

## 继续已有回复

酒馆发送 `type: "continue"` 时，扩展保留原消息和酒馆的续写提示，在最后一条传输指令中要求模型从原文结尾接写，只返回新增文本。酒馆会把它直接追加到原消息，保留原有的拼接方式。打开或关闭 Continue prefill 都适用。普通发送、重新生成、滑动切换候选和预设的 assistant 预填充按各自原有流程处理。

非流式抗截断、流式抗截断和 SillyTavern 的文字转图请求都支持这个指令。面板会显示本次已请求新增续文。关闭抗截断和图片输入或遇到旁路请求时，由酒馆处理“继续”。模型仍可能重复原文，插件不编辑历史消息或自动删除重复段落。

## 输入转码

这项设置独立于传输模式，默认关闭。展开「输入转码」先选方式，再选范围。两种酒馆都能选 Unicode 或优化转码，SillyTavern 另有「文字转图」，可选当前轮或全部会话。折叠时仍可看到当前选择，改动从下一次 Vertex 请求生效。

### Unicode

「Unicode · 当前输入」读取最新真实用户楼层，只转换请求消息中与原文匹配的文本。单楼层游戏卡没有用户消息，或最新用户楼层为空时，扩展改读聊天变量「我的行动」（预设用 `{{getvar::我的行动}}` 取值）。两处都没有内容会停止发送。原文在请求中找不到时，面板会提示，本次按原文发送。已开启 Unicode 的旧设置继续使用这个模式。

「Unicode · 全部上下文」直接遍历本次请求中的系统提示、开发者提示、用户和 AI 历史及当前输入。独立的工具结果、调用参数、签名和附件保留原样。此模式也适用于没有用户楼层的预填充和“继续”。扩展只编码文本中的汉字和 ASCII 字母，已有标签、编码块和标点会保留。

转码发生在浏览器分流之前。普通 Vertex 和工具、Schema、搜索等旁路请求也会转码。聊天、预设、工具定义、Schema 和图片地址保留原样。已有编码块不会重复编码，也不会追加解码指令。转码后的请求超过 8 MiB 会停止发送。预设若已启用同类功能，关闭其中一处可以避免原文匹配失败。短请求的验证范围见 [Unicode 验收记录](UNICODE-INPUT-AUDIT.md)。

### 优化转码（实验）

「优化转码 · 当前输入」转换消息里匹配本轮用户输入的副本。「优化转码 · 全部上下文」转换系统、开发者、用户和 AI 消息的文本。两种范围都保留工具结果、调用参数和附件。旧的 Unicode 设置继续使用原有格式。

扩展准备两种汉字写法。一种从每段连续汉字的第一个字起，隔字写成 Unicode 转义。另一种为最多 256 个高频字编一张本次请求共用的字表，其余汉字写成十六进制码点。读法说明只附一次。扩展用酒馆自己的 Gemma 分词器比较两种写法，计入说明和字表，选择估算 token 较少的一种发送。面板显示实际选中的格式。分词器不可用时按 UTF-8 长度估算。分词不调用模型。

这两种格式通常比中文原文费 token。Gemini 4 Argon 的四稿对照测试中，两份短稿均保留了姓名和字面标记，两份长稿分别出现过续写越过停笔点和上游内容过滤。

### 图片

SillyTavern 服务端将选中的文本渲染为无损 WebP 页面，系统指令保留文字。「当前轮」转换最后一条 AI 消息之后的用户文本，「全部会话」转换普通用户和 AI 文本。“继续”或 assistant 预填充之后没有可转换文本时，按原文发送，面板会说明原因。两种范围都支持流式抗截断，面板显示本次页数和传输方式。

每个文本片段至少占一页，每次最多 100 页。base64 图片和请求中的其余内容合计限 8 MiB，相当于最多约 6 MiB 图片。中文约可容纳 2.4 万至 4.5 万字（约 20 至 28 页），具体取决于内容和换行。长聊天可选「图片·当前轮」。

| 错误 | 处理方式 |
| --- | --- |
| `413 request_too_large` 或 `413 image_input_too_large` | 前者表示转换前的请求过大，后者表示渲染后超限。缩短输入或改用当前轮 |
| `400 image_input_unsupported_characters` | 根据报错里的消息位置和 Unicode 码点查找控制字符、无效序列或两种随包字体都缺的字形。常见爱心 ❤、❤️、笑脸、旗帜、肤色和职业组合可直接渲染 |
| `503 image_renderer_unavailable` | 在服务端插件目录运行 `npm ci --ignore-scripts` 安装渲染依赖，确认随包字体存在，然后重启 |
| `503 image_render_failed` | 服务端渲染或编码失败，按面板报错排查 |

选了图片输入后，服务端不可用或请求内容不受支持时会停止发送。字体和许可证随服务端包提供，前端扩展目录无需安装 npm 依赖。[图片输入验收记录](IMAGE-INPUT-VALIDATION.md)

## 范围与边界

### 与 Vertex PayGo 同用

普通 SillyTavern 同时启用 ST-Vertex-PayGo 及其配套服务端时，仍在 PayGo 里选择 Standard、Flex、Priority 和 PayGo Only。抗截断扩展在同一次生成请求上转换输入和还原正文，PayGo 负责准备票据、选择凭据及记录用量。图片模式另外调用本机抗截断服务端的转码接口。此接口只接收所选范围和消息，不调用模型。

使用流式模式时，正文随 PayGo 提供的函数参数到达。上游一次性返回完整参数时，正文也会一次到达。PayGo 准备失败或图片转换失败会结束本次请求。

PayGo 0.6.1-pre1 没有分段续写接口。启用 long decode 且 Gemini 4 请求超过单次上限时，面板会提示调整设置。兼容测试使用了同版本的前后端。[PayGo 扩展](https://github.com/mananekoha114/ST-Vertex-PayGo) · [PayGo 服务端](https://github.com/mananekoha114/ST-Vertex-PayGo-Server)

### 查看生成错误

酒馆的错误提示和扩展面板显示上游提供的说明。Google 通过 `promptFeedback` 拒绝输入时，可看到原因码、原文说明和已标记为拦截的类别。流式正文开始后出现的错误也会显示。经第三方后端时，能显示的内容取决于该后端返回的字段。

### 请求处理

扩展接管同源的 `/api/backends/chat-completions/generate` Vertex POST 请求。它在提示词末尾加一条 user 指令，让模型通过工具参数交付正文。已收到的内容仍需通过回复完整性检查。达到长度上限或被过滤时保留上游结束原因，未命中标签的残缺参数或意外断流会报错。TT 的流式还原失败会产生错误事件，非流式返回 HTTP 502。TT 自己报告的凭据、配额等错误会按酒馆原样显示。

- **客户端工具。** 默认在客户端工具后添加内置正文工具，填写预设正文工具名时复用对应声明。模型可以在同一轮交付正文并调用其他工具，工具参数完整后才交给酒馆处理。保留调用的思考签名与 Gemini 4 调用 ID。若只有正文工具带签名，后续第一个无签名工具使用 Google 的 `skip_thought_signature_validator` 历史兼容标记，原正文工具的思考上下文无法带入下一轮。
- **旁路。** 默认内置工具遇到强制工具选择时旁路。指定预设工具时允许 `required` 和点名该工具。旧式 functions、无法转换的工具声明（如 Schema 含 `default` 或 `pattern`）、结构化输出、多个候选、原生联网搜索、图片生成、非 Gemini 模型、反向代理及超过 8 MiB 的普通抗截断请求，都会走酒馆原流程。只要一个已注册工具无法转换，当次请求就会旁路。面板会显示原因。
- **请求和日志。** 默认只发一次生成请求。传输指令和工具声明会占用少量 token。酒馆继续处理登录和 CSRF 防护，SillyTavern 服务端插件只向 Google 官方域名发送请求。其他扩展若替换全局 `fetch` 且不调用先前的实现，本扩展可能收不到请求。

## 更新与已有手动安装

| 当初的装法 | 更新步骤 |
| --- | --- |
| SillyTavern 一键安装包 | 关闭酒馆，下载新版 ZIP，再运行安装程序。需要跟随源码时可重新打包安装 |
| SillyTavern Git 安装 | 在「扩展程序 → 管理扩展程序」更新 UI。服务端默认在酒馆启动时拉取更新。若关闭了 `enableServerPluginsAutoUpdate`，在插件目录运行 `git pull --ff-only`。依赖有变化时，在同一目录运行 `npm ci --ignore-scripts`，再重启酒馆 |
| TauriTavern | 只更新 UI 扩展并重新加载 TT。手动克隆的安装可以先关闭 TT，在扩展目录运行 `git pull --ff-only` |

SillyTavern 扩展要求服务端至少为 0.3.1。服务端和扩展版本不同时，面板会指出较旧的一方。工具调用需要服务端报告 `client-tools`，缺少时带工具的请求旁路。标签截停另查 `stop-after-tag-pairs`。更早的扩展（含 0.4.0 安装包）要求两边版本一致，服务端自动更新后出现版本不匹配时，请更新 UI 扩展。很旧的服务端还可能对超出单次上限的 Argon 请求返回 `gemini4_long_decode_required`。[Gemini 4 升级说明](GEMINI4.md#升级方式)

一个用户只应加载一份扩展。要从手动复制改用 Git，先关闭抗截断并停用旧扩展，把已备份的旧前后端目录移到加载路径以外，再分别安装。GitHub Release 的 ZIP 和面板版本号只在发版时更新，同一版本号下的源码差异需要看提交。可以在仓库的 **Watch → Custom → Releases** 订阅发版通知。

## 验证

TT 截停的离线测试覆盖跨块标签、普通文字、工具参数、流式和整段交付。隔离浏览器使用 TT 2.4.0 的前端请求代码和模拟原生后端，核对了默认规则、自定义规则和关闭后的完整输出，并在刷新后回读设置。TT 原生 App 的 WebView、移动端和真实模型截停仍待实测。[本次与历次验收](VALIDATION.md)

以往的验证范围有所不同。手动克隆完整仓库后，扩展在 TT 2.3.0 Windows 便携版中加载成功。TT 2.4.0 的两轮真实 Gemini 4 Argon 请求验证了工具执行、签名和结果回传。SillyTavern 1.19.0 插件后端用真实模型验收过两种转图范围的流式回复。历史版本的修复与已知问题见[更新记录](../CHANGELOG.zh-CN.md)。

## 卸载

先关闭抗截断并停用 UI 扩展。SillyTavern 还需把服务端目录移出 `plugins` 后重启酒馆。安装包装的目录名为 `vertex-anti-truncation`，Git 装的为 `vertex-streaming-anti-truncation`。TT 只需移走扩展目录里的对应文件夹，酒馆凭据和聊天留在原处。

SillyTavern 接口参考见 [UI Extensions](https://docs.sillytavern.app/for-contributors/writing-extensions/) 和 [Server Plugins](https://docs.sillytavern.app/for-contributors/server-plugins/)。
