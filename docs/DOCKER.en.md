# Docker deployment

[中文](DOCKER.md) | English

The Docker image runs the standalone web console and OpenAI-compatible gateway. Connect Tavern through its custom API; this image does not install a Tavern plugin. The public image is `ghcr.io/ken050210/vertex-streaming-anti-truncation`, with `latest`, `0.13.0` and commit tags for `linux/amd64` and `linux/arm64`. Use Docker Engine / Docker Desktop (Linux containers) and Compose v2 or later.

## Start

```sh
mkdir vertex-gateway
cd vertex-gateway
curl -fL https://github.com/ken050210/vertex-streaming-anti-truncation/releases/download/gateway-v0.13.0/compose.yaml -o compose.yaml
docker compose pull
docker compose up -d
docker compose logs vertex-gateway
```

Open the first-time setup link in the logs, including `#setup=...`. The console defaults to `http://127.0.0.1:4780/`. Enter Google credentials (or a [custom upstream](../README.en.md#custom-upstream)'s URL and API key), models and a gateway key, then save. The API starts at `http://127.0.0.1:4781/v1`. Strict keys are the default; the access-mode selector also offers weak keys (e.g. `123456`) or keyless access to both API and console, with a risk-confirmation checkbox before saving. Keyless mode opens the console directly; the other modes require the saved key. Anyone who can reach a keyless service can call models, read logs and change settings, potentially incurring charges; port publishing determines who can reach it. Keep bootstrap links private.

No registry login, source checkout, host Node.js or `.env` is needed. You can also download the Compose file manually from the [release](https://github.com/ken050210/vertex-streaming-anti-truncation/releases/tag/gateway-v0.13.0). Compose does not automatically pass host Google credentials into the container. Startup, saving and health checks never invoke a model; the console's manual connection test uses your Google billing account, or a custom upstream's own billing.

The container listens on `0.0.0.0`; Compose publishes both ports only on the host's loopback address by default. Native `npm start` still defaults to `127.0.0.1`. See [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/).

## Ports and access addresses

Download `default.env.docker.example` from the release, copy it to `.env.docker`, edit it and use `docker compose --env-file .env.docker ...` for every Compose command. Set `IMAGE_TAG=0.13.0` to pin the version instead of using `latest`. For example:

```dotenv
DOCKER_BIND_IP=127.0.0.1
CONSOLE_PORT=5780
GATEWAY_PORT=5781
GUI_ORIGIN=http://127.0.0.1:5780
GATEWAY_PUBLIC_URL=http://127.0.0.1:5781/v1
```

`DOCKER_BIND_IP` controls the host interface; choose a host LAN IP for trusted LAN access. `CONSOLE_PORT` and `GATEWAY_PORT` change only host ports. **Keep the console's API port setting at 4781** unless you also change the target container port in Compose.

`GUI_ORIGIN` is the exact browser-facing scheme, hostname/IP and port, without a path. Update it and recreate the container when changing the console's mapped port, hostname or HTTPS setup. `GATEWAY_PUBLIC_URL` controls only the address displayed/copied for API clients; it does not change listening or routing. Deployment settings remain in the environment, outside the saved web configuration. Native installs can also explicitly set `LISTEN_HOST=0.0.0.0`; only this value and `127.0.0.1` are supported.

## Remote servers and HTTPS proxies

For private server access, keep the default loopback publication and tunnel both ports:

```sh
ssh -N -L 4780:127.0.0.1:4780 -L 4781:127.0.0.1:4781 user@server
```

Open the logged localhost link on your own computer.

For a reverse proxy, set `GUI_ORIGIN=https://console.example.com` and the correct `GATEWAY_PUBLIC_URL`. Forward the whole console site to port 4780, preserving the original **Host** and **Origin**. Console subpaths are unsupported. Forwarded headers never authorize a host; sessions for an explicit HTTPS origin receive Secure cookies. Do not expose the administrative console over public plain HTTP.

Forward API traffic to 4781, preserve `Authorization`, disable response buffering and set the read timeout to cover the upstream timeout (600 seconds by default). This preserves SSE delivery. Validate your particular TLS and proxy setup separately.

## Dockerized Tavern

On the same Compose network, Tavern can use `http://vertex-gateway:4781/v1` and the gateway key; keyless mode accepts a blank key or any placeholder. For separate projects, create an external network with `docker network create tavern-gateway`, declare it in both projects, and attach both services using `networks: [shared]`:

```yaml
networks:
  shared:
    external: true
    name: tavern-gateway
```

Recreate the affected containers. Service-name URLs work inside the shared network; host/browser clients use published addresses. See [Compose networking](https://docs.docker.com/compose/how-tos/networking/).

Container localhost refers to that container. So a custom upstream running on the host cannot be reached at `127.0.0.1` or `localhost`; use `host.docker.internal` (mapping below), or the service name of a relay container on a shared network. When a proxy is also in use, add `host.docker.internal` to `NO_PROXY`. To send upstream traffic through an outgoing host proxy, explicitly pass `NODE_USE_ENV_PROXY=1`, a reachable `HTTPS_PROXY`, and `NO_PROXY=127.0.0.1,localhost` in Compose's environment. Docker Desktop provides `host.docker.internal`; Linux Engine can add it with `extra_hosts: ["host.docker.internal:host-gateway"]`. The host proxy must also listen on a reachable interface. Verify this outgoing proxy path separately in your environment.

## Updating to 0.13.0

Keep the existing data volume, run `docker compose pull`, then `docker compose up -d`. If you use `.env.docker`, keep adding `--env-file .env.docker` to both commands and change a pinned `IMAGE_TAG` to `0.13.0`. Do not run `down -v`, which deletes saved configuration.

Existing keys keep strict mode after upgrading. To allow a simple key or keyless access, select the mode in Connection settings → 本地网关, confirm the risk and save. Keyless mode opens both API and console access and clears the previous gateway key.

The existing connection remains the primary account and rotation stays off. In Connection settings → 多账号轮询, add accounts, enable rotation and save. The per-account timeout, failure threshold and cooldown are configurable without rebuilding the container. All accounts are stored in the same volume's `settings.json`; protect it like the original credentials. See [rotation rules and limitations](../README.en.md#account-rotation-standalone-gateway).

## Data and credentials

The named `gateway-data` volume stores `/data/settings.json`. It survives restarts, container replacement and ordinary `docker compose down`. **`down -v` deletes the configuration and credentials.** Back up the volume, keep a stable Compose project name, and run only one console per volume.

The container runs as UID 1000 with a read-only root filesystem and writable `/data` and `/tmp`. For a bind-mounted state directory, create it first and allow UID 1000 to write. Settings contain plaintext credentials with POSIX mode 0600; anyone able to read the volume can read them.

To seed a service account from an external file before the first save, add `compose.override.yaml`:

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

Keep the file outside the repository and readable by UID 1000. On Windows the source can be `C:/private/service-account.json`. Saving in the console copies the selected credential into the volume. Saved settings take precedence afterward; replacing the mounted file does not rotate that saved copy. Alternatively, import JSON directly in the console. The build context allows only runtime source, fonts and licenses, excluding `.env`, runtime data and host `node_modules`.

## Update and validate

```sh
docker compose pull
docker compose up -d
docker compose ps
```

Include `--env-file .env.docker` when using that file. Container `healthy` means the console responds, including before initial setup; it does not validate upstream credentials or inference. After saving, `/healthz` checks the gateway and authenticated `/v1/models` lists its configured models.

To build from source:

```sh
git clone https://github.com/ken050210/vertex-streaming-anti-truncation.git
cd vertex-streaming-anti-truncation
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

Repeat the build command after updating source. After building, developers can run `npm run test:docker`, or set `DOCKER_TEST_IMAGE` to test a pulled release image. It uses a unique Compose project, random local ports, synthetic credentials and a separate network. It checks authentication, persistence across container replacement, service-name networking, CJK WebP rendering, health and graceful shutdown, then removes only test resources. Run `npm run verify` for the existing offline protocol suite. The Docker test calls only local endpoints, with no Google model discovery or real inference.
