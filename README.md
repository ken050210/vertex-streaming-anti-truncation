# Vertex Streaming Anti-Truncation

中文 | [English](README.en.md)

这是一个用于 Vertex AI / Gemini 的实验项目。开启抗截断后，模型把正文写进工具参数，酒馆扩展或独立网关再把它还原成文字。上游支持流式函数参数时，读者可以在回复写完前看到第一段。

## 安装哪一种

| 你在哪里选模型 | 需要安装 | 安装说明 |
| --- | --- | --- |
| SillyTavern 1.19.x 的 Google Vertex AI 面板 | UI 扩展和服务端插件，复用酒馆里的凭据 | [SillyTavern 安装](docs/SILLYTAVERN.md#选哪种装法) |
| TauriTavern（TT 酒馆）桌面端或手机 App | 完整仓库里的 UI 扩展，凭据和请求由 TT 后台处理 | [TauriTavern 安装](docs/SILLYTAVERN.md#tauritavern) |
| 酒馆的自定义 OpenAI 连接、其他兼容客户端，或提供 Gemini 模型的中转 | 独立网关，可用 Node.js 或 Docker 运行 | [启动网关](#启动) |

SillyTavern 用户可以用 0.12.1 安装包同时更新前后端，服务端需要 Node.js 22.9 或更高版本。用 Git 安装的用户分别更新两端，重启酒馆后刷新页面。[下载安装包](https://github.com/ken050210/vertex-streaming-anti-truncation/releases) · [Git 安装与更新](docs/SILLYTAVERN.md#更新与已有手动安装)

在 Vertex 面板的「输入转码」里，Unicode 可选当前输入或全部上下文，文字转图支持 ❤️、肤色、旗帜和常见组合 emoji。遇到 Google 拦截输入，酒馆会显示 Google 提供的原因。与 Vertex PayGo 同用时，仍在 PayGo 里选择档位。[输入转码](docs/SILLYTAVERN.md#输入转码) · [PayGo 设置](docs/SILLYTAVERN.md#与-vertex-paygo-同用)

**TT 酒馆** 在「扩展程序 → 安装扩展」填入 `https://github.com/ken050210/vertex-streaming-anti-truncation`，分支留空。扩展在 WebView 里还原正文。装好后到「API 连接 → Google Vertex AI」选择非流式或流式抗截断，抗截断传输默认关闭。想让文字逐段出现，还要打开酒馆自己的流式开关。手机上用 Termux 跑 SillyTavern 的用户，在 Termux 里安装前后端。[手机安装步骤](docs/SILLYTAVERN.md#手机上怎么装)

<details>
<summary>交给 AI 助手安装</summary>

[给 AI 助手的安装指引](docs/AGENT-INSTALL.md) 包含两种酒馆各自的安装命令，以及已有安装的检查方法。

```text
帮我安装 https://github.com/ken050210/vertex-streaming-anti-truncation 里的抗截断插件。
动手前先完整阅读仓库的 docs/AGENT-INSTALL.md 并严格照做：
https://raw.githubusercontent.com/ken050210/vertex-streaming-anti-truncation/main/docs/AGENT-INSTALL.md
先判断我用的是 SillyTavern 还是 TauriTavern，找不到或拿不准就问我，不要猜，也不要装成独立网关。
需要我关闭或重启酒馆时先告诉我；不要碰我的密钥、聊天和已有的插件文件。
装完告诉我：你改了哪些文件、备份在哪里、怎么确认装好了、在哪里打开开关。
```

</details>

## 自定义标签截停

默认在本次抗截断回复的第二对完整 `<tucao>…</tucao>` 处停止。两种酒馆都在 Vertex 面板的「自定义标签截停」里改标签名和次数。例如填 `A`、`1`，模型写出 `开头<A>保留</A>尾巴`，酒馆会收到 `开头<A>保留</A>`。独立网关在控制台的「连接配置」里设置。

结束标签后面的内容会被丢弃，**包括后面的 MVU 更新块**。预设需要在文末写入变量时，可以选最后一个必须保留的块作为截停标签，或关闭截停。每次请求单独计数，点“继续”也会重新开始。TT 用户需将扩展更新到 0.11.0 或更高版本。[酒馆匹配规则](docs/SILLYTAVERN.md#自定义标签截停) · [网关与 CLI 设置](docs/GATEWAY.md#自定义标签截停)

## 启动

独立网关需要 Node.js 22.9 或更高版本。在终端运行以下命令。

```sh
git clone https://github.com/ken050210/vertex-streaming-anti-truncation.git
cd vertex-streaming-anti-truncation
npm ci --ignore-scripts
npm start
```

打开终端打印的首次设置链接，控制台默认在 `http://127.0.0.1:4780/`。选择服务账号、Express API Key 或短期 OAuth 令牌，添加模型版本并保存。客户端的 OpenAI 兼容地址填 `http://127.0.0.1:4781/v1`，密钥填刚保存的网关密钥。Windows 也可以双击 `Start-GUI.cmd` 启动控制台。[Docker 部署](docs/DOCKER.md) · [仅命令行模式](docs/GATEWAY.md#仅命令行模式)

### 自定义上游

使用提供 Gemini 模型的 OpenAI 兼容中转时，在「连接配置」里选择「自定义上游」，填中转地址和 API Key。抗截断需要中转支持工具调用，逐段显示正文还需要它分段转发工具参数。[中转配置](docs/GATEWAY.md#自定义上游)

## 文档

| 想做的事 | 去哪里看 |
| --- | --- |
| 配置模型、多账号轮询、Unicode 或图片输入 | [独立网关使用手册](docs/GATEWAY.md) · [控制台截图](docs/GATEWAY.md#控制台预览) |
| 核对 Gemini 4 Argon 的鉴权、思考等级或输出上限 | [Gemini 4 Argon 说明](docs/GEMINI4.md) |
| 排查回复结束原因、查看 token 用量和费用估算 | [请求日志与诊断](docs/GATEWAY.md#查看验收结果) |
| 区分哪些功能做过模拟测试、哪些经过真实模型验证 | [验收记录](docs/VALIDATION.md) |
| 查某个版本的改动 | [更新记录](CHANGELOG.zh-CN.md) |

## 来源

用工具调用传输正文的方案参考了 [Xeltra233](https://github.com/Xeltra233) 的 [Antigravity-gateway](https://github.com/Xeltra233/Antigravity-gateway)。
