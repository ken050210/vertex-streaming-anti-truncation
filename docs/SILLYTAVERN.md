# SillyTavern 原生 Vertex 面板插件

本集成由 UI 扩展和服务端插件组成。抗截断选项直接显示在 **API 连接 → Google Vertex AI** 面板下方，复用酒馆的模型、已保存凭据、地区和服务等级。服务端插件随酒馆启动，不另开端口，不需要运行独立网关。

适配依据：SillyTavern 1.19.0 的 `vertexai_form`、`SillyTavern.getContext()`、Google 提示词转换和原生响应读取逻辑。其他版本需要重新检查这些接口。

## 从 GitHub 安装（推荐）

需要 SillyTavern 1.19.0 和 Node.js 22.9+。同一个仓库同时提供前端扩展和服务端插件，但需要安装到两个不同的位置。

### 1. 安装前端扩展

打开酒馆 **扩展程序 → 安装扩展**，在 Git URL 输入框粘贴：

```text
https://github.com/ken050210/vertex-streaming-anti-truncation
```

分支或标签框**留空**即可跟随仓库默认分支更新；需要固定本次版本时，填写 `sillytavern-v0.1.0`。按需选择“只给我安装”或“给所有人安装”。

### 2. 安装服务端插件（首次必需）

在 **SillyTavern 根目录**打开终端，运行酒馆自带安装命令：

```sh
node plugins.js install https://github.com/ken050210/vertex-streaming-anti-truncation
```

该命令克隆仓库到 `plugins/vertex-streaming-anti-truncation`。确认酒馆 `config.yaml` 中 `enableServerPlugins: true`，然后重启酒馆并刷新网页。

截图中的“安装扩展”窗口只安装浏览器端文件，不能替代这一步。只安装前端时，面板会显示服务端插件未就绪；不要启用抗截断，先完成服务端安装。

### 3. 确认安装

进入 **API 连接 → Google Vertex AI → 抗截断传输**，点击“检查插件连接”，应显示“服务端插件已就绪”。此检查不访问 Google、不调用模型。

默认关闭。选择流式抗截断时，还需开启酒馆原有的流式传输选项。

### 更新与已有手动安装

- 前端使用酒馆扩展管理器更新；服务端可在其仓库目录运行 `git pull --ff-only`，然后重启酒馆。两端应使用同一版本。
- 不要把相同扩展重复安装到“当前用户”和“所有用户”。
- 如果已经使用 ZIP 手动安装到 `vertex-anti-truncation`，无需再装一份。需要迁移为 Git 管理时，先关闭抗截断、停用旧 UI 扩展，并把旧前后端目录备份移到各自加载目录之外，再按上述步骤安装。保留酒馆凭据和设置。

## 从本地源码打包

在本仓库运行：

```sh
npm run verify
npm run package:sillytavern
```

把生成的两个目录分别复制到酒馆：

| 安装包目录 | 酒馆内的目标目录 |
| --- | --- |
| `dist/sillytavern/server/vertex-anti-truncation` | `plugins/vertex-anti-truncation` |
| `dist/sillytavern/extension/vertex-anti-truncation` | `public/scripts/extensions/third-party/vertex-anti-truncation` |

也可以从 [GitHub Release](https://github.com/ken050210/vertex-streaming-anti-truncation/releases/tag/sillytavern-v0.1.0) 下载配套 ZIP，按上表安装。服务端需启用 `enableServerPlugins: true`，然后重启酒馆、刷新网页。

## 使用

默认是“关闭”，不会更改现有连接。选择：

- **关闭（普通 Vertex）**：使用酒馆原有请求。
- **非流式抗截断**：一个上游请求，等待完整正文再交付。酒馆开启流式时，也只在完成后一次交付。
- **流式抗截断**：酒馆同时开启流式传输时，使用 Vertex 原生函数参数流，逐段还原正文。酒馆关闭流式时返回完整普通响应。

Express、Flex、Priority 需要将地区设为 `global`。完整服务账号的项目 ID 从酒馆已保存的服务账号读取；Express 的可选项目 ID 会保留。凭据仍保存在酒馆，插件不创建第二份凭据文件，也不把凭据返回浏览器。

## 范围与边界

- 不修改酒馆核心文件。前端仅重定向同源 `/api/backends/chat-completions/generate` 中符合条件的 Vertex POST 请求；其他来源和关闭状态保持原路由。
- 现有工具、工具历史、JSON/Schema、多个候选、联网搜索、图片生成、非 Gemini 模型和反向代理请求走酒馆原流程。面板会显示本次跳过原因。
- 保留酒馆的提示词后处理、角色名称、系统提示词、媒体转换、停止串、采样与思考设置；使用本项目已有的模型参数兼容规则。
- 使用本项目的工具正文还原和回复完整性检查。不会把缺少结束标记、空回复或损坏的工具参数当成成功；保留长度限制及过滤结果。
- 不自动续写、不自动重试，不增加第二轮模型请求。抗截断传输增加少量提示词和工具格式开销，不能保证模型永不中断，也不能绕过输出上限或模型限制。
- 所有生成请求沿用酒馆登录和 CSRF 防护。服务端只向固定 Google 官方域名发送请求；不会回显上游错误正文、密钥或提示词。
- 前端依赖当前版本酒馆的全局 `fetch` 调用点；如果其他扩展在之后替换 `fetch` 且不向前传递，可能影响集成。升级酒馆或相关扩展后需复查。

## 验证

`test/sillytavern.test.mjs` 使用模拟上游，检查原请求保留、CSRF/取消信号传递、按用户读取选定凭据、提示词参数保留、逐段首字交付、缓冲回复格式、截断/损坏检测以及一次请求原则。它不调用付费模型。

实际模型对函数参数流的支持、真实长回复抗截断收益和计费仍需要单独的有界实测。文件安装、酒馆加载、模拟协议测试和真实模型验收是不同的检查项。

## 卸载

先将抗截断设为“关闭”，再禁用 UI 扩展，将本插件服务端目录移到酒馆 `plugins` 目录之外并重启。不要删除酒馆凭据或其他插件。

接口参考：[UI Extensions](https://docs.sillytavern.app/for-contributors/writing-extensions/)、[Server Plugins](https://docs.sillytavern.app/for-contributors/server-plugins/)。
