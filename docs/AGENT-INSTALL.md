# 给 AI 助手的安装指引

If you are an AI agent asked to install this plugin for a user, read this file first. It is written in Chinese; the commands are the same in any language.

用户说“帮我安装这个仓库里的抗截断插件”时，指的是酒馆里的 Vertex 面板集成，不是 README“启动”一节的独立网关。两种酒馆的装法不同，装错了不会生效，所以先判断用户用的是哪一种。

本页命令按 POSIX shell 书写，PowerShell 下换成等价命令。PowerShell 5.1 里 `curl` 是别名，要写 `curl.exe`；它也没有 `&&`，请在上一条命令成功后再执行下一条。

## 第一步：判断装什么

| 线索 | 类型 | 装什么 |
| --- | --- | --- |
| 文件夹里有 `server.js`、`plugins.js`、`config.yaml`，`package.json` 的 `name` 是 `sillytavern`；用浏览器打开 `http://127.0.0.1:8000` 使用 | SillyTavern | UI 扩展和服务端插件两半，见 [SillyTavern](#sillytavern) |
| 名叫 TauriTavern 的桌面或手机应用（程序名含 `TauriTavern`，应用标识 `com.tauritavern.client`）；数据目录里有 `default-user` 和 `_tauritavern`，没有 `server.js` | TauriTavern（TT 酒馆） | 只装 UI 扩展，见 [TauriTavern](#tauritavern) |
| 用户不用酒馆的 Vertex 连接，或想给其他 OpenAI 兼容客户端用 | 独立网关 | 不属于“插件”，见 [README 的“启动”](../README.md#启动) |

手机上：Termux 里运行的是 SillyTavern，按 SillyTavern 一节在 Termux 里操作，酒馆文件夹通常是 `~/SillyTavern`。TauriTavern 的手机 App 只能由用户在应用里“安装扩展”，你无法代装，把 Git URL 和步骤告诉用户即可。

最可靠的办法是直接问用户用的是哪一个、装在哪个文件夹。用户也不清楚时可以帮着找：正在运行的进程里有没有 `node server.js` 或名字含 `TauriTavern` 的程序，桌面快捷方式指向哪里。两种都找到、都没找到，或者位置拿不准时，停下来问。不要猜，也不要先装网关。

## 动手前向用户确认

- 酒馆文件夹的路径（TauriTavern 是它的数据目录）。
- 酒馆现在可以关闭。安装时酒馆必须是关闭状态，装完由用户重新启动。不要自行结束用户正在使用的酒馆进程。
- SillyTavern：安装会把 `config.yaml` 的 `enableServerPlugins` 改为 `true`（先备份原文件），并把扩展装给所有用户。开启后 `plugins` 文件夹里已有的其他服务端插件也会随酒馆加载。
- SillyTavern 版本不是 1.19.x 时是否继续。插件按 1.19.0 适配，其他版本可能加载不了；安装程序对此只给出警告，不会自己停下。

确认酒馆已关闭的办法：SillyTavern 的端口连不上（`curl http://127.0.0.1:8000/` 连接失败，端口以 `config.yaml` 的 `port` 为准）；TauriTavern 没有名字含 `TauriTavern` 的进程。安装程序不检查酒馆是否在运行。

## SillyTavern

需要 SillyTavern 1.19.x、Node.js 22.9 以上，并且酒馆至少启动过一次（根目录已有 `config.yaml`）。

先做只读检查，`<ST>` 是酒馆文件夹：

```sh
node -v
git --version
grep -E '"(name|version)"' "<ST>/package.json"
grep -E '^(enableServerPlugins|port|dataRoot):' "<ST>/config.yaml"
ls "<ST>/plugins" "<ST>/public/scripts/extensions/third-party" "<ST>"/data/*/extensions
```

最后一条用来找已有副本：名字是 `vertex-anti-truncation`（安装包放的）或 `vertex-streaming-anti-truncation`（Git 或扩展管理器装的）的文件夹。`config.yaml` 里设置了 `dataRoot` 时，用户扩展在那个目录下，而不是 `<ST>/data`。找到了就按[已经装过](#已经装过)处理。

没有旧副本时，从源码生成安装包，再运行其中的安装程序。四条命令，不需要交互，也不需要先 `npm ci`：

```sh
git clone --depth 1 https://github.com/ken050210/vertex-streaming-anti-truncation
cd vertex-streaming-anti-truncation
node scripts/package-sillytavern.mjs
node dist/sillytavern/install.mjs "<ST>"
```

- 克隆到酒馆目录以外的临时位置，装完可以删掉。
- 直接调用 `install.mjs`。不要运行 `install-windows.cmd`，它结尾会等待按键。
- 没有终端输入时安装程序不会停下来等确认，所以运行前先确认酒馆已关闭。
- 也可以用 Release 页面最新的一键安装包代替前三条命令（解压后同样运行 `node install.mjs "<ST>"`），但它只在发版时更新；四条命令装的是 `main` 的最新代码。不要用标签早于 `sillytavern-v0.4.0` 的压缩包，它们没有 Gemini 4 与 TauriTavern 适配。
- 离线或装不上依赖时加 `--skip-deps`。只影响图片输入，联网后重跑一次即可补上。克隆或下载失败时把原因告诉用户（通常需要代理），不要换来源。

安装程序做的事：服务端插件放到 `plugins/vertex-anti-truncation`，UI 扩展放到 `public/scripts/extensions/third-party/vertex-anti-truncation`，安装图片渲染依赖，`enableServerPlugins` 不是 `true` 时先把 `config.yaml` 备份为 `config.yaml.backup-时间` 再改。成功时退出码为 0 并打印“安装完成”；失败时退出码非 0 并打印“安装未完成：原因”，原有文件保持不变。它只接受 SillyTavern 文件夹，对其他目录会直接拒绝。

### 已经装过

安装程序会自己查找已有副本，按内容识别（包括改过名的文件夹和各用户的扩展目录），不必手工排查：

- **它自己以前放的副本**（文件夹里有 `.vertex-installer.json`）：再运行一次上面的四条命令就是更新。
- **其他副本**（Git 克隆、扩展管理器安装、手动复制）：它会列出路径并停止，不覆盖也不删除。这时不要动那些文件夹，按原来的方式更新。UI 扩展是 Git 仓库时在它的文件夹里 `git pull --ff-only`；服务端插件是 Git 仓库时在它的文件夹里 `git pull --ff-only`，再 `npm ci --ignore-scripts`。

两半要更新到同一个提交。每一半只能有一份，重复安装会让插件被加载两次。用户想把其他副本改由安装包管理时，要先把旧文件夹移到酒馆目录之外，这一步须经用户同意。

### 用户想用 Git 管理、在酒馆里自动更新

这是安装包之外的另一种装法，两种只选一种。逐条执行，上一条成功后再执行下一条：

```sh
git clone https://github.com/ken050210/vertex-streaming-anti-truncation "<ST>/public/scripts/extensions/third-party/vertex-streaming-anti-truncation"
cd "<ST>" && node plugins.js install https://github.com/ken050210/vertex-streaming-anti-truncation
cd "<ST>/plugins/vertex-streaming-anti-truncation" && npm ci --ignore-scripts
```

- 第一条等价于在酒馆“安装扩展”里填 Git URL 并选“给所有人安装”。只给某个用户装时，改为克隆到 `<ST>/data/<用户名>/extensions/` 下（默认用户名是 `default-user`）。两处只放一份。
- 运行 `npm ci` 前确认当前目录确实是插件文件夹。在酒馆根目录运行会重装酒馆自己的依赖。
- 再把 `config.yaml` 里的 `enableServerPlugins` 设为 `true`：先复制一份备份；已有这一行时原位修改，没有时才在末尾新增一行。不要让同名的键出现两次，也不要改动文件的编码和换行。
- 这种装法不会自己查重，装之前先按上面的只读检查确认两处扩展目录和 `plugins` 里都没有本插件。

### 核对

请用户启动酒馆并刷新网页，然后：

```sh
curl http://127.0.0.1:8000/api/plugins/vertex-anti-truncation/status
```

返回 `{"id":"vertex-anti-truncation","version":"<版本号>","ready":true}`，且版本号与仓库 `manifest.json` 里的 `version` 相同，即服务端插件已加载。端口以 `config.yaml` 的 `port` 为准；开启了账号或基础认证的酒馆不能这样检查。界面上的等价检查是 **API 连接 → Google Vertex AI → 抗截断传输 → 检查插件连接**。只装了一半时这里会失败，不要在此之前报告安装成功。版本号只在发版时更新，所以它分不出同一版本号下 `main` 上的后续改动。

## TauriTavern

只装 UI 扩展。不需要 Node.js，不要创建 `plugins` 文件夹，不要改任何配置文件，也不要对它运行上面的 SillyTavern 安装程序。

用户能自己操作界面时，可以让用户在 TauriTavern 的 **扩展程序 → 安装扩展** 里填入 `https://github.com/ken050210/vertex-streaming-anti-truncation`，分支留空。这是 TauriTavern 自带的装法，本项目尚未验证过它。

由你代装时，先做只读检查，`<数据目录>` 是 TauriTavern 的数据目录：

```sh
ls "<数据目录>"
ls "<数据目录>/default-user/extensions"
```

第一条应能看到 `default-user` 和 `_tauritavern`；第二条里已有 `vertex-streaming-anti-truncation` 或其他同一插件的文件夹时，停下来问用户。然后在 TauriTavern 关闭的状态下把仓库克隆进去：

```sh
git clone --depth 1 https://github.com/ken050210/vertex-streaming-anti-truncation "<数据目录>/default-user/extensions/vertex-streaming-anti-truncation"
```

- 数据目录的位置：便携版是程序所在文件夹里的 `data`；安装版是系统应用数据目录下的 `com.tauritavern.client/data`（Windows 为 `%APPDATA%\com.tauritavern.client\data`）。`data` 的上一级文件夹里有 `tauritavern-runtime.json` 时，以其中的 `data_root` 为准。不确定就问用户，应用内 **设置 → System → Data Directory** 会显示。装错目录不会有任何提示，只是扩展不出现。
- TauriTavern 的用户目录固定叫 `default-user`。
- 必须是完整仓库。不要把 `dist/sillytavern/extension/` 或 Release 压缩包里的前端文件夹拷进来，它们不含 TauriTavern 需要的模块，扩展会加载失败且没有界面提示。

启动 TT 后，在「API 连接 → Google Vertex AI」核对「抗截断传输」和面板底部的 TauriTavern 说明。含 TT 截停功能的源码还会显示「自定义标签截停」、标签名和次数。全新安装的默认值是 `tucao` 和 `2`。这些控件可在发送任何模型请求之前检查。

如果无法查看界面，可对照安装前后 `<数据目录>/default-user/settings.json` 里的 `extension_settings`。首次出现 `vertex-anti-truncation` 说明扩展已加载。已有这个键时，需要通过面板确认本次更新。

已验证的范围：按上面的命令克隆后，扩展在 TauriTavern 2.3.0（Windows 便携版）中加载。功能差别与限制见 [TauriTavern 说明](SILLYTAVERN.md#tauritavern)。

## 装完后告诉用户

- 插件默认关闭。到 **API 连接 → Google Vertex AI → 抗截断传输** 选择“非流式抗截断”或“流式抗截断”；选流式时还要打开酒馆自己的流式传输。
- 标签截停默认勾选，只对抗截断回复生效。结束标签后的内容会被丢弃，包括后续 MVU 更新块。[规则和示例](SILLYTAVERN.md#自定义标签截停)
- 它使用酒馆里已保存的 Vertex 凭据。安装过程不需要、也不应该读取或填写任何密钥。
- 开关由用户在界面里选择，不要替用户修改酒馆的设置文件来打开它。
- 你做了哪些改动、备份文件在哪里。

## 不要做的事

- 没确认酒馆类型就开始安装，或照 README 的“启动”一节装成网关。
- 删除、覆盖或移动用户已有的插件副本、`config.yaml`、聊天和凭据文件。
- 运行不带 `--ignore-scripts` 的 `npm install` 或 `npm ci`。
- 为了让安装通过而结束用户的酒馆进程，或在用户不知情时重启酒馆。
- 安装失败后换一种装法重试。把安装程序给出的原因告诉用户。

## 卸载

先请用户在面板里把抗截断设为“关闭”并关闭酒馆，再把本插件的文件夹移到酒馆目录之外：SillyTavern 是 `plugins` 下和扩展目录下各一个（名字见上文），TauriTavern 只有扩展目录下的一个。不要删除酒馆的凭据或其他插件。

更完整的说明：[SillyTavern 与 TauriTavern 集成说明](SILLYTAVERN.md)。
