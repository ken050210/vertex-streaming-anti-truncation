# SillyTavern 原生 Vertex 面板插件

本集成由 UI 扩展和服务端插件组成。抗截断选项直接显示在 **API 连接 → Google Vertex AI** 面板下方，复用酒馆的模型、已保存凭据、地区和服务等级。服务端插件随酒馆启动，不另开端口，不需要运行独立网关。

由 AI 助手代为安装时，先读[给 AI 助手的安装指引](AGENT-INSTALL.md)，那里有判断酒馆类型的方法和全程命令行的做法；本页多数步骤按界面操作书写。

本扩展同时是 TauriTavern（TT 酒馆）的适配版：TauriTavern 不能运行服务端插件，只安装 UI 扩展即可，做法和差别见 [TauriTavern](#tauritavern)。

适配依据：SillyTavern 1.19.0 的 `vertexai_form`、`SillyTavern.getContext()`、Google 提示词转换和原生响应读取逻辑。其他版本需要重新检查这些接口。

## 手机上怎么装

先看手机上的酒馆是怎么运行的：

| 手机上怎么用酒馆 | 装什么 | 在哪里操作 |
| --- | --- | --- |
| 在 Termux 里运行 SillyTavern，用手机浏览器打开 | 插件的两半：UI 扩展和服务端插件 | 全部在 Termux 里输入命令。“酒馆根目录”就是 Termux 里的 SillyTavern 文件夹，一般是 `~/SillyTavern` |
| 用 TauriTavern 的 App | 只装 UI 扩展 | 在 App 里：**扩展程序 → 安装扩展**，填本仓库的 Git URL，分支留空。不需要 Termux，也不用输入命令 |
| 手机浏览器连接电脑或服务器上的酒馆 | 装在运行酒馆的那台机器上 | 手机上不用装任何东西 |

独立网关在手机上一般用不到。

Termux 里的 SillyTavern：先在运行酒馆的那个窗口按 Ctrl+C 关闭酒馆，再逐行执行：

```sh
cd ~
git clone --depth 1 https://github.com/ken050210/vertex-streaming-anti-truncation
cd vertex-streaming-anti-truncation
node scripts/package-sillytavern.mjs
node dist/sillytavern/install.mjs ~/SillyTavern
```

酒馆不在 `~/SillyTavern` 时，把最后一行的路径换成实际位置。安装程序会先列出要做的事，按回车后开始。装完照常启动酒馆、刷新网页，在 **API 连接 → Google Vertex AI** 面板底部找“抗截断传输”，点“检查插件连接”。需要 Node.js 22.9 以上（`node -v` 查看，版本低时用 `pkg install nodejs` 装到最新版）。以后更新：进入 `~/vertex-streaming-anti-truncation`，运行 `git pull --ff-only`，再重复最后两行。

验证状态：安装程序的自动测试在 Linux、macOS 和 Windows 上通过，但 Termux 上的安装和 TauriTavern 手机 App 里的安装都没有实测过。图片渲染组件提供 Android arm64 版本，装不上时只影响图片输入。

## 选哪种装法

- **一键安装包**：一次装好两半，自带查重、配置备份和失败回滚。装进去的不是 Git 副本，不会随酒馆的插件自动更新或扩展管理器更新。
- **从 GitHub 安装**：两半分别安装，之后可以在酒馆里更新。

两种只选一种，不要混装。

## 一键安装包

安装包里有前端扩展、服务端插件和安装程序，运行一次就把两边装好，不需要 Git。需要 SillyTavern 1.19.x（按 1.19.0 适配；其他版本安装程序只给出警告，装上后可能无法加载）、Node.js 22.9+，并且酒馆至少启动过一次（已生成 `config.yaml`）。

1. 关闭酒馆，解压安装包。
2. Windows 双击 `install-windows.cmd`，按提示把酒馆文件夹拖进窗口后回车；macOS／Linux／Termux 在终端运行 `sh install.sh 酒馆文件夹路径`。
3. 启动酒馆、刷新网页，按下方“确认安装”检查。

在命令行里或由 AI 助手运行时，直接执行 `node install.mjs "酒馆文件夹路径"`，不要用 `install-windows.cmd`（它结尾会等待按键）。没有终端输入时安装程序不再等待确认，运行前先确认酒馆已关闭。成功时退出码为 0，失败时非 0 并打印“安装未完成：原因”。

安装程序把服务端插件放到 `plugins/vertex-anti-truncation`，前端扩展放到 `public/scripts/extensions/third-party/vertex-anti-truncation`（所有用户可用），然后联网运行 `npm ci --ignore-scripts` 安装图片渲染依赖。依赖装不上只影响图片输入，联网后再运行一次即可补上；离线时可加 `--skip-deps` 跳过。`config.yaml` 中 `enableServerPlugins` 未开启时改为 `true`，修改前在同目录备份原文件。开启后 `plugins` 文件夹里已有的其他服务端插件也会随酒馆加载。新文件先在酒馆目录内准备好再替换，替换出错时恢复原来的文件夹。

发现用 Git、扩展管理器或手动复制安装的副本（包括各用户自己的扩展目录）时，安装程序列出路径并停止，不覆盖也不删除，以免插件被加载两次。更新时下载新版安装包再运行一次；用安装包装的副本不是 Git 仓库，不会随酒馆的插件自动更新或扩展管理器更新。

安装包在 [GitHub Release `sillytavern-v0.6.2`](https://github.com/ken050210/vertex-streaming-anti-truncation/releases/tag/sillytavern-v0.6.2) 下载 `vertex-anti-truncation-sillytavern-0.6.2.zip`，可用同页的 `SHA256.txt` 校验。压缩包只在发版时更新，版本号也只在发版时改变；发版之后 `main` 上的新改动不会进入已发布的压缩包。要装 `main` 的最新代码，在本仓库运行 `npm run package:sillytavern`，生成的 `dist/sillytavern` 就是安装包内容；打包不需要先安装依赖。

## 从 GitHub 安装

需要 SillyTavern 1.19.x（按 1.19.0 适配）和 Node.js 22.9+。克隆或 `npm ci` 失败通常是访问 GitHub、npm 的网络问题，配置好代理后重试即可。同一个仓库同时提供前端扩展和服务端插件，但需要安装到两个不同的位置。

### 1. 安装前端扩展

打开酒馆 **扩展程序 → 安装扩展**，在 Git URL 输入框粘贴：

```text
https://github.com/ken050210/vertex-streaming-anti-truncation
```

命令行的等价做法是把仓库克隆到扩展目录：只给某个用户用时是 `data/<用户名>/extensions/vertex-streaming-anti-truncation`（默认用户名为 `default-user`），给所有人用时是 `public/scripts/extensions/third-party/vertex-streaming-anti-truncation`。

分支或标签框**留空**，跟随仓库默认分支；第 2 步的服务端插件同样从默认分支安装，两端版本一致。不要在这里填写旧标签 `sillytavern-v0.1.0`：服务端仍是默认分支的新版本，版本检查会失败，面板提示“服务端插件未就绪或版本不匹配”。按需选择“只给我安装”或“给所有人安装”。

### 2. 安装服务端插件（首次必需）

在 **SillyTavern 根目录**打开终端，运行酒馆自带安装命令：

```sh
node plugins.js install https://github.com/ken050210/vertex-streaming-anti-truncation
```

该命令克隆仓库到 `plugins/vertex-streaming-anti-truncation`。接着在 SillyTavern 根目录运行以下命令，安装图片输入所需的渲染依赖：

```sh
cd plugins/vertex-streaming-anti-truncation
npm ci --ignore-scripts
```

运行 `npm ci` 前确认上一条 `cd` 成功、当前目录是插件文件夹；在酒馆根目录运行会重装酒馆自己的依赖。跳过这一步时抗截断和 Unicode 转码仍可使用，但选择图片输入会返回 `image_renderer_unavailable`（HTTP 503）；补装后需重启酒馆。确认酒馆 `config.yaml` 中 `enableServerPlugins: true`，然后重启酒馆并刷新网页。手动修改时先备份该文件，把已有的那一行原位改成 `true`，不要在末尾再追加一行同名的键。

酒馆的“安装扩展”窗口只安装浏览器端文件，不能替代这一步。只安装前端时，面板会显示服务端插件未就绪；不要启用抗截断，先完成服务端安装。

### 3. 确认安装

进入 **API 连接 → Google Vertex AI → 抗截断传输**，点击“检查插件连接”，应显示“服务端插件已就绪”。此检查不访问 Google、不调用模型，也不检查图片渲染依赖是否已安装。命令行的等价检查是请求 `http://127.0.0.1:8000/api/plugins/vertex-anti-truncation/status`（端口以 `config.yaml` 为准；未开启账号和基础认证时可用），返回 `{"id":"vertex-anti-truncation","version":"0.3.1","ready":true}` 即服务端插件已加载。

默认关闭。选择流式抗截断时，还需开启酒馆原有的流式传输选项。

### 更新与已有手动安装

先看本插件是怎么装的：

- **一键安装包**：关闭酒馆，下载新版安装包再运行一次，两半一起更新。想在发新版时收到通知，可以在 GitHub 仓库页点 **Watch → Custom → Releases**。
- **Git**：两半分别更新。
  - 服务端插件：酒馆每次启动都会自动 `git pull` 用 Git 装的服务端插件（`config.yaml` 的 `enableServerPluginsAutoUpdate`，默认开启），但不会运行 `npm ci`。更新记录写明依赖有变化时，在插件目录手动运行 `npm ci --ignore-scripts`。关闭了自动更新时，在插件目录运行 `git pull --ff-only` 和 `npm ci --ignore-scripts`，然后重启酒馆。
  - UI 扩展：酒馆平时不会自动更新它，要在 **扩展程序 → 管理扩展程序** 里点它的更新按钮。勾选扩展程序面板顶部的“在扩展程序更新时通知”，酒馆会每天检查一次并提醒。
  - 所以发新版后，常见的情况是服务端已随酒馆启动变新，扩展还是旧的。
- **TauriTavern**：只有 UI 扩展，在 TT 的扩展管理里更新；用 Git 克隆装的，也可以在 TT 关闭时于该文件夹运行 `git pull --ff-only`。
- **AI 助手按四条命令装的**：重新执行那四条命令即可，安装程序会认出自己装的副本并更新。

版本检查：扩展只要求服务端插件不低于 0.3.1。服务端比扩展新或旧都能正常使用，点“检查插件连接”时面板会建议更新较旧的一方；服务端低于 0.3.1 或找不到时，面板说明原因和更新办法，“继续”和图片输入请求停止发送。这条规则从 2026-10-14 之后的 `main` 起生效。更早的扩展，包括 0.4.0 安装包里的，要求两边版本号完全相同：服务端先自动更新时，面板会提示版本不匹配并拦下“继续”和图片输入，在扩展管理器里更新扩展即可。带工具的请求另看服务端是否报告 `client-tools` 能力（0.5.0 起提供）：没有时这些请求照旧走酒馆原流程，面板写明“服务端插件较旧”，其他请求不受影响。服务端插件早于 Gemini 4 输出上限适配时，最大回复长度超过单次上限的 Argon 请求仍会被拒绝（`gemini4_long_decode_required`），面板提示更新服务端插件。Gemini 4 的升级说明见 [Gemini 4 升级方式](GEMINI4.md#升级方式)。

- 不要把相同扩展重复安装到“当前用户”和“所有用户”。
- 如果已经使用 ZIP 手动安装到 `vertex-anti-truncation`，无需再装一份。需要迁移为 Git 管理时，先关闭抗截断、停用旧 UI 扩展，并把旧前后端目录备份移到各自加载目录之外，再按上述步骤安装。保留酒馆凭据和设置。

## 从本地源码打包

在本仓库运行：

```sh
npm run package:sillytavern
```

打包只用 Node.js 自带模块，全新克隆后可以直接运行。`npm run verify` 是可选的自检，需要先 `npm ci --ignore-scripts`。

然后运行 `dist/sillytavern` 里的安装程序（见上方“一键安装包”），或手动把生成的两个目录分别复制到酒馆：

| 安装包目录 | 酒馆内的目标目录 |
| --- | --- |
| `dist/sillytavern/server/vertex-anti-truncation` | `plugins/vertex-anti-truncation` |
| `dist/sillytavern/extension/vertex-anti-truncation` | `public/scripts/extensions/third-party/vertex-anti-truncation` |

上表的前端目录只用于 SillyTavern。它不含 TauriTavern 需要的模块，不要复制到 TauriTavern，那里要用完整仓库（见 [TauriTavern](#tauritavern)）。

复制后在 `plugins/vertex-anti-truncation` 目录运行 `npm ci --ignore-scripts` 安装图片渲染依赖。服务端需启用 `enableServerPlugins: true`，然后重启酒馆、刷新网页。

当前 Release 为 [`sillytavern-v0.6.2`](https://github.com/ken050210/vertex-streaming-anti-truncation/releases/tag/sillytavern-v0.6.2)，ZIP 内含安装程序和上表两个目录。旧版 [`sillytavern-v0.5.0`](https://github.com/ken050210/vertex-streaming-anti-truncation/releases/tag/sillytavern-v0.5.0) 在工具执行后回传结果的请求会失败，请勿使用；[`sillytavern-v0.4.0`](https://github.com/ken050210/vertex-streaming-anti-truncation/releases/tag/sillytavern-v0.4.0) 遇到客户端工具时整次跳过抗截断；[`sillytavern-v0.3.1`](https://github.com/ken050210/vertex-streaming-anti-truncation/releases/tag/sillytavern-v0.3.1) 不含 Gemini 4 与 TauriTavern 适配；[`sillytavern-v0.1.0`](https://github.com/ken050210/vertex-streaming-anti-truncation/releases/tag/sillytavern-v0.1.0) 的 ZIP 不含 Unicode 与图片输入。

## 使用

抗截断与输入转码默认都关闭，不会更改现有连接。抗截断模式选择：

- **关闭（普通 Vertex）**：使用酒馆原有请求。
- **非流式抗截断**：一个上游请求，等待完整正文再交付。酒馆开启流式时，也只在完成后一次交付。
- **流式抗截断**：酒馆同时开启流式传输时，使用 Vertex 原生函数参数流，逐段还原正文。酒馆关闭流式时返回完整普通响应。0.3.0 及更早版本在酒馆中会被酒馆的压缩组件攒到回复结束才一次显示，看起来像非流式；请前后端一起更新到 0.3.1。

**Gemini 4 Argon 超长回复自动续写（long decode）**：面板里的勾选项，默认关闭，只影响插件接管的 Argon 请求。关闭时，最大回复长度超过单次上限（流式 65,536、非流式 32,768 token，含思考）会按单次上限发送，不再报错，预设不改动；回复真写满就停止并标记为长度截断，非流式抗截断写满时可能拿不到正文，可点“继续”接着写。开启后改用 Google 的 `v1beta1` 接口，写满后自动续写并拼成一条回复，最多写到预设的长度；每续写一段都重发完整上下文、多计一次费用，整次请求最长 10 分钟。与抗截断传输的配合尚未用真实超长输出验证，可能中途失败。规则、风险和验证状态见 [Gemini 4 输出上限与自动续写](GEMINI4.md#输出上限与自动续写)。

Express、Flex、Priority 需要将地区设为 `global`。完整服务账号的项目 ID 从酒馆已保存的服务账号读取；Express 的可选项目 ID 会保留。凭据仍保存在酒馆，插件不创建第二份凭据文件，也不把凭据返回浏览器。

### “继续”适配（0.3.1）

在酒馆点击“继续”时，插件根据请求中的 `type: "continue"` 自动启用续写适配，无需额外开关。它保留原消息、酒馆的续写提示和提示词后处理，在最终传输指令中要求模型只生成需要追加的文本，从原文结尾衔接，保留语言、视角、格式及未完成的句子／标签，避免重述原文或添加“以下是续写”等前言。Continue prefill 开启和关闭两种方式都适用；普通发送、重新生成、滑动候选及预设自带的 assistant 预填充不会因此被当作“继续”。

- 适用于本插件的非流式／流式抗截断，以及开启图片输入的请求。Unicode 转码保持原有范围，续写指令在转码和图片渲染之后加入。图片请求仍以缓冲方式交付。
- 前端先确认服务端插件版本一致。服务端确认已添加续写指令后，连接面板显示“本次‘继续’已请求仅生成新增续文，由酒馆追加到原消息”。
- 回复沿用酒馆原有的追加方式。插件不改写聊天记录、不自动裁剪相似或重复段落，也不添加拼接分隔符；每次点击仍只有一次模型请求。
- 抗截断和图片输入都关闭时，以及工具／Schema 等旁路请求，继续走酒馆原流程。本适配不改变独立网关的请求行为。
- 这是续写指令适配，不是 Gemini 的原生 assistant 预填充。模型仍可能重复或衔接不自然；模拟测试不能证明真实续写质量。

## 范围与边界

- 不修改酒馆核心文件。前端仅重定向同源 `/api/backends/chat-completions/generate` 中符合条件的 Vertex POST 请求；其他来源和关闭状态保持原路由。
- 客户端工具（酒馆开启函数调用后由扩展注册的工具，如 WebSearch 扩展的搜索工具）与工具调用历史也经抗截断传输（0.5.0 起）：这些工具排在抗截断的合成工具之前一起声明，模型可在同一回复里写正文并调用工具。工具调用以 Gemini 原生格式（带思考签名，Gemini 4 另带调用 ID）交回酒馆，由酒馆照常执行，下一轮请求带上工具结果；工具历史仍由酒馆自己的提示词转换处理。流式模式下带客户端工具时不逐段读取工具参数，正文在模型写完后一次到达，思考过程仍逐步显示。
- 旧版 functions、要求必须调用某个工具的请求、无法转为 Vertex 原生声明的工具（如参数 Schema 含 `default`、`pattern`），以及 JSON/Schema、多个候选、联网搜索、图片生成、非 Gemini 模型、反向代理请求和超过 8 MiB 的抗截断请求走酒馆原流程；服务端插件未报告 `client-tools` 能力时，带工具的请求也走原流程。酒馆开启函数调用后每次请求都会带上已注册的工具，所以只要有一个工具无法转换，本次请求就整体走原流程。抗截断开启时，面板会显示本次跳过原因。
- 抗截断会在提示词末尾追加一条传输格式的 user 指令。“继续”使用上面的新增续文指令；其他以 assistant 结尾的预设仍按普通完整回答处理，不能视为原生预填充续写。
- 保留酒馆的提示词后处理、角色名称、系统提示词、媒体转换、停止串、采样与思考设置；使用本项目已有的模型参数兼容规则。
- 使用本项目的工具正文还原和回复完整性检查。不会把缺少结束标记、空回复或损坏的工具参数当成成功；保留长度限制及过滤结果。
- 默认不自动续写、不自动重试，不增加第二轮模型请求；开启“超长回复自动续写”后，只有 Gemini 4 Argon 的回复写满单次上限时才追加续写请求。抗截断传输增加少量提示词和工具格式开销，不能保证模型永不中断，也不能绕过 Google 的总输出上限或模型限制。
- 所有生成请求沿用酒馆登录和 CSRF 防护。服务端只向固定 Google 官方域名发送请求；不会回显上游错误正文、密钥或提示词。
- 前端依赖当前版本酒馆的全局 `fetch` 调用点；如果其他扩展在之后替换 `fetch` 且不向前传递，可能影响集成。升级酒馆或相关扩展后需复查。

## TauriTavern

本节说明为 [TauriTavern](https://github.com/Darkatse/TauriTavern)（TT 酒馆）做的适配版。TauriTavern 把酒馆的 Node.js 后台换成了 Rust，不能运行服务端插件。在 TauriTavern 中只安装 UI 扩展：扩展检测到 TauriTavern 后，自己完成抗截断的请求改写和回复还原；凭据、提示词转换、采样与思考参数仍由 TauriTavern 处理。随 SillyTavern 集成 0.4.0 发布（标签 `sillytavern-v0.4.0`）。

### 安装

在 TauriTavern 的 **扩展程序 → 安装扩展** 中填入本仓库的 Git URL，分支留空。不需要 Node.js、`plugins.js`、`npm ci` 和 `enableServerPlugins`；一键安装包只面向 SillyTavern，不用于 TauriTavern。

不经界面安装时，在 TauriTavern 关闭的状态下把完整仓库克隆到 `<数据目录>/default-user/extensions/vertex-streaming-anti-truncation`。便携版的数据目录是程序旁边的 `data`，安装版在系统应用数据目录下的 `com.tauritavern.client/data`；`data` 的上一级有 `tauritavern-runtime.json` 时以其中的 `data_root` 为准。这种装法已在 TauriTavern 2.3.0 中验证能加载，界面里的“安装扩展”尚未由本项目验证。安装包或 `dist/` 里的前端目录不含 TauriTavern 需要的模块，拷进去扩展会加载失败。

面板位置不变：**API 连接 → Google Vertex AI → 抗截断传输**。面板底部显示“TauriTavern：抗截断由本扩展直接完成，无需服务端插件；不支持图片输入和超长回复自动续写。”即已进入该模式，此时没有“检查插件连接”按钮。

### 与 SillyTavern 插件版的差别

- 请求仍发往酒馆自己的 `/api/backends/chat-completions/generate`。扩展在消息末尾追加传输指令，并通过 TauriTavern 的“附加参数”（`custom_include_body`）写入原生 `tools` 与 `toolConfig`。
- 两种模式都经 TauriTavern 的流式通道读取 Google 的原始事件，上游为 `streamGenerateContent`。原因是它的非流式返回只保留合并后的结束原因，无法据此识别被截断的回复。**非流式抗截断**不开启参数流，等回复完整并通过检查后一次交付；**流式抗截断**在酒馆开启流式传输时开启 `streamFunctionCallArguments` 并逐段显示。每次仍只有一个上游请求。
- 图片输入不可用（文字转图片依赖服务端渲染组件），“输入转码”下拉框不显示这两项。Unicode 转码和“继续”适配与插件版相同。
- Vertex 的“附加参数”为空或 JSON 对象时会与上述字段合并；写成 YAML 时无法合并，本次使用普通 Vertex，面板显示原因。改写为 JSON 对象即可。
- 还原失败时，流式回复以错误事件结束，非流式返回 HTTP 502，面板显示错误代码，不重试。TauriTavern 自己报告的请求错误（凭据、配额等）仍按它原有方式显示为回复文本。
- Gemini 4 Argon 的思考等级与采样参数由 TauriTavern 处理，需要所用版本已收录该模型（2026-10-14 核对：`dev` 分支已收录，稳定版 2.3.0 未收录）。输出额度超过流式上限 65,536 时按 65,536 发送，面板显示本次额度；不支持超长回复自动续写，因为请求由 TauriTavern 的后台发出，扩展无法跟随续写令牌。
- 带客户端工具或工具历史的请求在 TauriTavern 中走它的原流程（面板显示“TauriTavern 下工具调用暂不经过抗截断”），因为它的后台如何转换工具历史、如何转发真实工具调用尚未核对。
- 8 MiB 请求大小限制、旁路条件与“范围与边界”中的其余说明同样适用。

### 依据与验证状态

依据 TauriTavern v2.1.1、v2.3.0 与 `main`（2026-10-10）源码核对：附加参数作用于最终请求体，Vertex 流式事件原样转发给前端。`test/tauritavern.test.mjs` 用模拟的酒馆通道覆盖请求改写、逐段还原、完整交付、截断与损坏检测、取消、“继续”和酒馆错误文本。另用 SillyTavern 已保存的凭据向 Vertex 发送 6 次真实请求，流式、非流式、“继续”和输出上限截断均符合预期；这些请求体由脚本按 TauriTavern 源码规则拼出，不是它的后台发出的。范围与未覆盖项见[验收说明](VALIDATION.md)。

## 验证

`test/sillytavern.test.mjs` 使用模拟上游，检查原请求保留、CSRF/取消信号传递、按用户读取选定凭据、提示词参数保留、逐段首字交付、缓冲回复格式、截断/损坏检测以及一次请求原则。它不调用付费模型。

实际模型对函数参数流的支持、真实长回复抗截断收益和计费仍需要单独的有界实测。文件安装、酒馆加载、模拟协议测试和真实模型验收是不同的检查项。

## 卸载

先将抗截断设为“关闭”，再禁用 UI 扩展，将本插件服务端目录移到酒馆 `plugins` 目录之外并重启。服务端目录用安装包装的叫 `vertex-anti-truncation`，用 Git 装的叫 `vertex-streaming-anti-truncation`；扩展目录下的同名文件夹也可一并移走。TauriTavern 只需移走扩展目录下的文件夹。不要删除酒馆凭据或其他插件。

接口参考：[UI Extensions](https://docs.sillytavern.app/for-contributors/writing-extensions/)、[Server Plugins](https://docs.sillytavern.app/for-contributors/server-plugins/)。

## 输入转码

Vertex 面板的 **输入转码** 下拉框有四档：关闭、Unicode、图片·当前轮、图片·全部会话，每项附有转换范围，默认关闭。Unicode 与图片只能选一种，切换时自动保持互斥，沿用原有设置字段并保留已保存的选择。输入转码独立于“抗截断传输”，两者分别保存。更改选择立即影响之后的请求，已发出的请求不变；非 Vertex 请求不处理。

### Unicode

选择 Unicode 后，前端从当前聊天读取最新真实用户楼层，只转换请求消息中匹配的文本，不修改聊天、预设、工具定义、Schema 或图片地址。即使抗截断关闭，或因工具／Schema／搜索等原因走酒馆原路由，输入转码仍会执行。

单楼层游戏卡不发用户楼层，玩家输入存在聊天变量“我的行动”里（预设用 `{{getvar::我的行动}}` 读出）。聊天里没有真实用户楼层，或最新用户楼层为空时，改用这个变量的内容去匹配；有用户楼层时仍只用楼层原文。

楼层和变量都没有内容时停止发送并提示；原文未匹配时显示提示并按原文发送，不猜测拼装请求中最后一条 user。编码后请求超过 8 MiB 则停止发送。已有 Unicode 编码不会被再次编码；请关闭预设中的同类功能，避免原文匹配失效。不会追加解码指令，也不承诺模型理解质量或 token 用量下降。

Unicode 转码在浏览器中、抗截断分流之前执行；普通／旁路请求仍由酒馆原后端处理，服务端插件不参与 Unicode 转码。

### 图片

图片由服务端插件渲染为无损 WebP 页面。当前轮／全部会话规则与独立网关一致，系统指令保留文字。“图片·当前轮”只转换最后一条 AI 消息之后的文本；之后没有可转换文本时（例如开启 Continue prefill 后点击“继续”，或预设以 AI 消息结尾作预填充），本次按原文发送。图片输入请求一律按非流式交付，即使抗截断关闭、酒馆开启了流式也是如此；没有可转换文本时面板会说明本次按原文发送，若酒馆开启了流式且未选择非流式抗截断，还会提示仍按非流式交付。成功转换时面板显示页数。

发送图片请求前，前端会确认服务端插件版本一致；未就绪或版本不匹配时停止发送，不会改用明文。请求含图片输入不支持的内容时停止发送，面板会写明原因（如旧版 functions 工具、此模型不适用、反向代理）。转换前请求本身超过 8 MiB 返回 413 `request_too_large`；含 emoji、控制字符或字体缺字时返回 400 `image_input_unsupported_characters`（“全部会话”会检查整段历史）；渲染失败返回 503 `image_render_failed`。面板会用中文说明这些错误。零宽空格等不可见格式字符（ZWSP、ZWNJ、WJ、BOM、VS15）不影响发送。

图片经 base64 后连同请求中其余内容合计不得超过 8 MiB（仅有图片时约 6 MiB，中文约 2.4–4.5 万字、约 20–28 页，视内容和换行而定；保留为文字的系统指令和角色卡，以及当前轮模式下的此前历史，也占用这一额度），超出返回 413 `image_input_too_large`。每条含文字的消息（每个文本片段）至少单独占一页，每次请求最多 100 页，因此“全部会话”最多约 100 条这样的消息；长聊天请改用“图片·当前轮”。

服务端首次安装或更新后，在服务端插件目录运行 `npm ci --ignore-scripts` 安装图片渲染依赖，再重启酒馆。手动打包也需要这一步；字体及许可证随服务端包提供。前端扩展目录不需要 npm 安装。

### 版本与验收

0.6.2 将单楼层游戏卡的 Unicode 输入修复纳入安装包：没有真实用户楼层或最新用户楼层为空时，使用聊天变量“我的行动”；有用户楼层时继续使用楼层原文。独立网关同期发布 0.13.0，新增可选弱密钥与无密钥模式。

0.6.1 缩短 Vertex 面板中自动续写开关下方的说明，功能不变；独立网关仍为 0.11.0。

0.6.0 与独立网关 0.11.0 把抗截断的合成工具名固定为 `router_emit`，开启抗截断后也能命中 Vertex 隐式缓存；Gemini 4 Argon 的输出额度超过单次上限时改为按上限发送，不再报错，并新增可选的超长回复自动续写，见 [Gemini 4 输出上限与自动续写](GEMINI4.md#输出上限与自动续写)。准备过的 0.5.3 没有发布，其改动包含在 0.6.0 中。

0.5.2 与独立网关 0.10.1 共用 Express 项目地址构造。快速模式调用 Gemini 4 Argon 需填写 API Key 所属的项目 ID 或项目编号，明确请求 global；缺少项目时在本地提示补填，不发送上游请求。

0.5.1 修复工具执行后回传结果的请求被 Vertex 拒绝（HTTP 400）的问题，同时独立网关发布 0.9.1。客户端工具与抗截断共用随 0.5.0 发布。TauriTavern 适配和 Gemini 4 Argon 适配随 0.4.0 发布。

版本号只在发版时更新。发版之后 `main` 上的改动在下一次发版前不改版本号，面板的版本检查分不出新旧；要确认装到的代码是否含某项改动，看它来自哪个提交。

当前前端与服务端均为 0.6.2，对应标签／Release `sillytavern-v0.6.2`。0.5.0（标签 `sillytavern-v0.5.0`）首次让客户端工具经过抗截断，但回传工具结果会失败。0.4.0（标签 `sillytavern-v0.4.0`）包含 TauriTavern 与 Gemini 4 Argon 适配。0.3.1（标签 `sillytavern-v0.3.1`）包含“继续”适配、流式修复和一键安装包。建议前后端一起更新；版本检查的规则见“更新与已有手动安装”。0.3.0 对应标签 `sillytavern-v0.3.0`（与网关 `v0.7.0` 为同一提交）；0.2.0 未发布标签；上方 v0.1.0 标签／Release 不含 Unicode 与图片输入。Unicode 转码在 v0.2.0（当时为独立勾选框）时完成的短请求验收见[验收记录](UNICODE-INPUT-AUDIT.md)（英文）。0.4.0 与 0.3.1 的验证和剩余验收范围见[验收说明](VALIDATION.md)。
