Vertex AI 抗截断 · SillyTavern 一键安装包

自定义标签截停默认开启：tucao，完整出现 2 次。可在 Vertex 抗截断面板修改标签名和次数，例如 A + 1 次。
仅抗截断生效时应用，保留命中的结束标签，丢弃后续所有内容（包括其后的 MVU 更新块）。
流式取消上游读取，非流式收到完整回复后裁剪；旧配置明确关闭时保持关闭。

安装前先关闭酒馆。

Windows：双击 install-windows.cmd，按提示把酒馆文件夹拖进窗口，按回车。
         也可以直接把酒馆文件夹拖到 install-windows.cmd 上。
macOS / Linux / 安卓 Termux：在终端运行（路径换成你的酒馆文件夹）
         sh install.sh ~/SillyTavern
命令行或由 AI 助手代装（任何系统）：
         node install.mjs "酒馆文件夹路径"
         不要用 install-windows.cmd，它结尾会等待按键。没有终端输入时安装程序
         不再等待确认，运行前先确认酒馆已关闭。成功时退出码为 0。

安装程序会：
1. 把服务端插件放到 酒馆/plugins/vertex-anti-truncation
2. 把前端扩展放到 酒馆/public/scripts/extensions/third-party/vertex-anti-truncation
3. 联网安装图片输入需要的渲染组件（没装上也不影响抗截断和 Unicode 转码）
4. config.yaml 里没开 enableServerPlugins 时改成 true，改之前先备份原文件

装完启动酒馆、刷新网页，在 API 连接 → Google Vertex AI → 抗截断传输 里点“检查插件连接”。
更新：下载新版安装包，再运行一次。
已经用 Git 或手动复制装过的，安装程序会停下来说明原因，不会覆盖或删除。
离线安装可以加 --skip-deps 跳过渲染组件，之后联网再运行一次补上。
这个安装包只用于 SillyTavern。TauriTavern 请在应用里用仓库的 Git 地址安装扩展。
详细说明：server/vertex-anti-truncation/docs/SILLYTAVERN.md
