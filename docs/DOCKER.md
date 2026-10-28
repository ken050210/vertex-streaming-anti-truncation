# Docker 部署

中文 | [English](DOCKER.en.md)

这是独立网关的 Docker 版，包含网页控制台与 OpenAI 兼容 API。酒馆通过自定义 API 连接它；它不会给酒馆容器安装插件。公开镜像为 `ghcr.io/ken050210/vertex-streaming-anti-truncation`，提供 `latest`、`0.12.0` 和提交标签，支持 `linux/amd64` 与 `linux/arm64`。需要 Docker Engine / Docker Desktop（Linux containers）和 Docker Compose v2 或更新版本。

## 启动

```sh
mkdir vertex-gateway
cd vertex-gateway
curl -fL https://github.com/ken050210/vertex-streaming-anti-truncation/releases/download/gateway-v0.12.0/compose.yaml -o compose.yaml
docker compose pull
docker compose up -d
docker compose logs vertex-gateway
```

打开日志中的首次设置链接（含 `#setup=...`），默认控制台为 `http://127.0.0.1:4780/`。按网页提示填写 Google 凭据（或[自定义上游](../README.md#自定义上游)的地址和 API Key）、模型和随机网关密钥，保存后 API 在 `http://127.0.0.1:4781/v1` 启动。以后使用保存的网关密钥登录。首次设置链接属于管理凭据，不要分享日志。

默认无需登录镜像仓库、克隆源码、安装宿主机 Node.js 或准备 `.env`。也可从 [Release](https://github.com/ken050210/vertex-streaming-anti-truncation/releases/tag/gateway-v0.12.0) 手动下载 Compose 文件。Compose 不会把宿主机的 Google 环境变量自动传入容器。启动、保存、健康检查均不会发送推理；网页中的连接测试需要手动触发，按 Google 账户计费；接自定义上游时按该服务的规则计费。

容器内监听 `0.0.0.0`，Compose 默认只把两个端口发布到宿主机 `127.0.0.1`。[Docker 的端口发布说明](https://docs.docker.com/engine/network/port-publishing/)解释了两者的区别。原有 `npm start` 仍默认只监听本机。

## 修改端口或访问地址

从 Release 下载 `default.env.docker.example`，复制为 `.env.docker`，编辑后每次使用：

```sh
docker compose --env-file .env.docker pull
docker compose --env-file .env.docker up -d
docker compose --env-file .env.docker logs vertex-gateway
```

| 设置 | 用途 |
| --- | --- |
| `IMAGE_TAG` | 默认 `latest`；填写 `0.12.0` 可固定版本 |
| `DOCKER_BIND_IP` | 宿主机发布地址，默认 `127.0.0.1`；可信局域网可指定宿主机网卡 IP |
| `CONSOLE_PORT` | 宿主机控制台端口，默认 `4780` |
| `GATEWAY_PORT` | 宿主机 API 端口，默认 `4781` |
| `GUI_ORIGIN` | 浏览器访问控制台的完整来源，例如 `http://192.168.1.10:4780` 或 `https://console.example.com`；不含路径 |
| `GATEWAY_PUBLIC_URL` | 控制台显示、复制的客户端 API URL，例如 `http://192.168.1.10:4781/v1`；不会更改监听或请求路由 |

例如，将本机端口改为 5780 / 5781：

```dotenv
DOCKER_BIND_IP=127.0.0.1
CONSOLE_PORT=5780
GATEWAY_PORT=5781
GUI_ORIGIN=http://127.0.0.1:5780
GATEWAY_PUBLIC_URL=http://127.0.0.1:5781/v1
```

网页内的 **API 端口保留 4781**；上述两个端口设置只改变宿主机映射。若修改网页内的 API 端口，也必须修改 Compose 对应的容器目标端口。更换主机名、协议或控制台映射端口后，要同步修改 `GUI_ORIGIN` 并重建容器，否则请求会被 Host/Origin 校验拒绝。

容器部署的网络设置由环境变量控制，不写入网页设置文件。非 Docker 运行也可显式使用 `LISTEN_HOST=0.0.0.0`；只接受 `127.0.0.1` 或 `0.0.0.0`。

## 服务器与 HTTPS 反向代理

只需自己管理远程服务器时，可保持默认发布地址，使用 SSH 隧道：

```sh
ssh -N -L 4780:127.0.0.1:4780 -L 4781:127.0.0.1:4781 user@server
```

随后在本机访问日志里的 `127.0.0.1` 链接。

使用 HTTPS 反代时，设置 `GUI_ORIGIN=https://console.example.com`，以及实际客户端使用的 `GATEWAY_PUBLIC_URL`。反代必须保留浏览器的 **Host** 和 **Origin**，并把整个控制台站点转发到 4780；不支持把控制台挂在子路径下。程序只信任明确配置的来源，不根据 `X-Forwarded-Host` 自动放行。HTTPS 来源的会话 Cookie 带 `Secure`。

API 反代转发到 4781，保留 `Authorization`，关闭响应缓冲，并让读取超时覆盖配置的上游超时（默认 600 秒），以保留 SSE 增量输出。配置文件支持反代访问；具体代理软件和公网 TLS 需按你的部署验证。不要将带管理凭据的控制台直接暴露在公网 HTTP 上。

## 更新到 0.12.0 与多账号轮询

保留现有数据卷，运行 `docker compose pull` 和 `docker compose up -d`；使用 `.env.docker` 的部署继续为这两条命令加上 `--env-file .env.docker`，并将固定的 `IMAGE_TAG` 改为 `0.12.0`。不要运行 `down -v`，它会删除保存的配置。

原有连接会继续作为主账号，轮询默认关闭。打开「连接配置 → 多账号轮询」，添加附加账号后启用并保存；可设置单账号超时、失败阈值及恢复等待时间，无需重建容器。所有账号保存在同一数据卷的 `settings.json`，须像原有凭据一样保护。详见[轮询规则与限制](../README.md#多账号轮询独立网关)。

## 酒馆也在 Docker 中

若酒馆与本服务在同一 Compose 网络，酒馆自定义 API 地址为 `http://vertex-gateway:4781/v1`，API Key 填网关密钥。不同 Compose 项目需显式连接到同一个外部网络，例如两边都添加：

```yaml
networks:
  shared:
    external: true
    name: tavern-gateway
```

先执行 `docker network create tavern-gateway`，然后分别给酒馆服务和 `vertex-gateway` 服务添加 `networks: [shared]`，再重建对应容器。服务名解析仅在共享网络内有效；浏览器或宿主机客户端使用发布地址。详见 [Compose 网络说明](https://docs.docker.com/compose/how-tos/networking/)。

容器内的 `127.0.0.1` 指向容器自身。所以自定义上游如果跑在宿主机上，上游地址不能写 `127.0.0.1` 或 `localhost`，要写 `host.docker.internal`（映射方法见下文）；和网关在同一个共享网络里的中转容器，可以直接写它的服务名。同时使用代理时，把 `host.docker.internal` 也加进 `NO_PROXY`。若要让访问上游的流量走宿主机代理，需在 Compose 的 `environment` 显式传入 `NODE_USE_ENV_PROXY=1`、可达的 `HTTPS_PROXY` 和 `NO_PROXY=127.0.0.1,localhost`。Docker Desktop 可使用 `host.docker.internal`；Linux Engine 可通过 `extra_hosts: ["host.docker.internal:host-gateway"]` 添加映射。宿主机代理也须监听容器可达的地址；这种代理路径需在你的环境单独验证。

## 持久化与凭据

命名卷 `gateway-data` 挂载到 `/data`，配置存于 `/data/settings.json`。重启、重建和普通 `docker compose down` 保留该卷；**`down -v` 会删除配置与凭据**。备份卷并保持同一 Compose 项目名，避免误以为配置丢失。每个卷只运行一个控制台实例。

容器使用非 root 用户（UID 1000）、只读根文件系统；`/data` 和 `/tmp` 可写。若改用宿主机目录挂载，提前创建目录并使 UID 1000 可写。配置包含明文凭据，POSIX 文件权限为 0600；能读取数据卷的人员仍能读取凭据。

如需从文件初始化服务账号，可在首次保存前添加 `compose.override.yaml`，文件保存在仓库外：

```yaml
services:
  vertex-gateway:
    environment:
      GOOGLE_APPLICATION_CREDENTIALS: /run/secrets/google-service-account.json
      VERTEX_PROJECT_ID: your-project-id
    volumes:
      - type: bind
        source: /absolute/private/service-account.json
        target: /run/secrets/google-service-account.json
        read_only: true
        bind:
          create_host_path: false
```

确保 UID 1000 可读取该文件。Windows source 可用 `C:/private/service-account.json`。网页首次保存会将选中鉴权方式的凭据复制进数据卷；后续以已保存配置为准，更换外部文件不会自动更新卷内副本。也可以直接在网页导入 JSON，无需挂载。镜像构建仅允许程序源码、字体与许可证进入构建上下文，不包含 `.env`、运行数据或宿主机 `node_modules`。

## 更新与验证

```sh
docker compose pull
docker compose up -d
docker compose ps
```

如使用 `.env.docker`，为所有 Compose 命令补上 `--env-file .env.docker`。`healthy` 表示控制台进程可响应，首次未设置凭据时也可以健康；它不代表上游凭据或模型调用已经验证。网关启动后可检查 `/healthz`，并带网关密钥请求 `/v1/models`。

如需从源码构建：

```sh
git clone https://github.com/ken050210/vertex-streaming-anti-truncation.git
cd vertex-streaming-anti-truncation
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

源码更新后重新运行同一条构建命令。开发者可在构建后运行 `npm run test:docker`；设置 `DOCKER_TEST_IMAGE` 可改为验收已拉取的发布镜像。该测试使用独立 Compose 项目、随机本机端口、假凭据和独立网络，覆盖登录、鉴权、保存、容器间服务名访问、中文 WebP 渲染、容器重建后的配置恢复、健康检查和正常退出；结束后只删除测试资源。现有协议测试通过 `npm run verify` 运行。Docker 测试只调用本地接口，不拉取 Google 模型目录或执行真实推理。
