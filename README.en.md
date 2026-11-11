# Vertex Streaming Anti-Truncation

[中文](README.md) | English

This experimental transport works with Vertex AI and Gemini. In anti-truncation mode, the model writes its reply into a tool argument. The Tavern extension or standalone gateway converts it back to text. When the upstream streams arguments, you can read the first fragment while the model is still writing.

## Which one to install

| Where you connect | What to install | Instructions |
| --- | --- | --- |
| SillyTavern 1.19.x, Google Vertex AI panel | UI extension and server plugin. Both use Tavern's saved credentials. | [SillyTavern installation (Chinese)](docs/SILLYTAVERN.md#选哪种装法) |
| TauriTavern (TT), desktop or mobile app | UI extension from the full repository. TT's Rust backend handles credentials and sends the request. | [TauriTavern installation (Chinese)](docs/SILLYTAVERN.md#tauritavern) |
| SillyTavern's custom OpenAI connection, another compatible client, or a Gemini relay | Standalone gateway, using Node.js or Docker | [Start the gateway](#setup) |

If a Tavern preset declares its own text tool, enter its name (for example, `game_content`) under **传输与截停**. Leave the field empty to use the built-in tool. For a Git installation, update both the UI extension and the server plugin, restart SillyTavern and reload the page. The server requires Node.js 22.9 or later. One-click installers are published with versioned releases. [Download the installer](https://github.com/ken050210/vertex-streaming-anti-truncation/releases) · [Git installation and updates (Chinese)](docs/SILLYTAVERN.md#更新与已有手动安装)

The Vertex panel can encode the current input or the full text context as Unicode. Text-to-image input supports ❤️, skin tones, flags and common emoji sequences. If Google blocks a prompt, Tavern shows the reason Google supplied. When using Vertex PayGo, choose the service tier in PayGo. [Input settings (Chinese)](docs/SILLYTAVERN.md#输入转码) · [PayGo setup (Chinese)](docs/SILLYTAVERN.md#与-vertex-paygo-同用)

**TauriTavern.** In Extensions, open **Install extension**, enter `https://github.com/ken050210/vertex-streaming-anti-truncation` and leave the branch blank. The extension restores the reply in the WebView. Open **API Connections → Google Vertex AI** to choose buffered or streaming anti-truncation. The transport starts off. To see text arrive progressively, also enable Tavern's streaming switch. On a phone running SillyTavern in Termux, install the two SillyTavern components in Termux. [Mobile installation guide (Chinese)](docs/SILLYTAVERN.md#手机上怎么装)

<details>
<summary>Install with an AI assistant</summary>

The [agent installation guide (Chinese)](docs/AGENT-INSTALL.md) includes commands for both Taverns and checks for an existing installation.

```text
Install the anti-truncation plugin from https://github.com/ken050210/vertex-streaming-anti-truncation for me.
Before doing anything, read docs/AGENT-INSTALL.md in that repository in full and follow it exactly:
https://raw.githubusercontent.com/ken050210/vertex-streaming-anti-truncation/main/docs/AGENT-INSTALL.md
First work out whether I use SillyTavern or TauriTavern. If you cannot find it or are unsure, ask me; do not guess and do not install the standalone gateway.
Tell me before I need to close or restart Tavern. Do not touch my keys, chats or existing plugin files.
When you finish, tell me which files you changed, where the backups are, how to confirm it works and where to switch it on.
```

</details>

## Custom tag stop

Tag cutoff is off on a new Tavern installation. Upgrades keep the effective setting. After selecting a transport mode in either Tavern's Vertex panel, open **传输与截停** to set the tag and count. For example, with `A` and `1`, the reply `start<A>keep</A>tail` appears as `start<A>keep</A>`. The gateway configures its rule under Connection settings and defaults to the second complete `<tucao>…</tucao>` pair.

Anything after the closing tag is discarded, including later MVU updates. If a preset writes variables at the end, choose its last required block or turn the rule off. Each request starts its own count, including Continue. On TT, update the extension to 0.11.0 or later. [Tavern matching rules (Chinese)](docs/SILLYTAVERN.md#自定义标签截停) · [Gateway and CLI settings](docs/GATEWAY.en.md#custom-tag-stop)

## Setup

To run the standalone gateway with Node.js 22.9 or newer, use these commands.

```sh
git clone https://github.com/ken050210/vertex-streaming-anti-truncation.git
cd vertex-streaming-anti-truncation
npm ci --ignore-scripts
npm start
```

Open the setup link printed in the terminal. The console defaults to `http://127.0.0.1:4780/`. Choose a service account, an Express API key or a short-lived OAuth token, add a model profile and save. Point your client's OpenAI-compatible connection at `http://127.0.0.1:4781/v1` and use the gateway key you saved. Windows users can also launch the console with `Start-GUI.cmd`. [Docker deployment](docs/DOCKER.en.md) · [CLI-only setup](docs/GATEWAY.en.md#cli-only-setup)

### Custom upstream

Choose **自定义上游** in Connection settings to use an OpenAI-compatible service that serves Gemini models. Enter its base URL and API key. The relay must support tool calls for anti-truncation and forward partial arguments for progressive delivery. [Relay configuration](docs/GATEWAY.en.md#custom-upstream)

## Documentation

| Task | Guide |
| --- | --- |
| Configure models, account rotation, Unicode or text-to-image input | [Standalone gateway guide](docs/GATEWAY.en.md) · [Console screenshots](docs/GATEWAY.en.md#console-preview) |
| Check Gemini 4 Argon authentication, thinking settings or output limits | [Gemini 4 Argon](docs/GEMINI4.en.md) |
| Check a finish reason, token usage or estimated cost | [Request logs and diagnostics](docs/GATEWAY.en.md#checking-a-request) |
| See which paths have offline and live coverage | [Validation records](docs/VALIDATION.en.md) |
| Look up changes by version | [Changelog](CHANGELOG.md) |

## Credits

The text-tool transport design comes from Xeltra233's [Antigravity-gateway](https://github.com/Xeltra233/Antigravity-gateway). [Author](https://github.com/Xeltra233)
