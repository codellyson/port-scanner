# port-scanner

Personal port utility. Lists local sockets, kills processes, and exposes any local port through a self-hosted WebSocket tunnel edge. Drives a macOS/Linux/Windows tray app.

Not published on npm. Cloned + built + run locally.

## Layout

| Path | What it is |
|---|---|
| `src/` | CLI (`ports list`, `ports kill`, `ports web`) and the Express dashboard |
| `src-tauri/` | Tray app that wraps the web server and starts it on login |
| `edge/` | Tiny Express + `ws` reverse-proxy tunnel edge that runs on the VPS |

## Run locally

```bash
npm install
npm run build
node dist/index.js web --token <random-string>      # dashboard at http://localhost:<port>?token=...
```

Tunnels need the edge:

```bash
export EDGE_WS_URL="wss://justportscanner.kreativekorna.com/agent"
export EDGE_TOKEN="<from /etc/portscanner-edge.env on the VPS>"
node dist/index.js web --token <random-string>
```

The dashboard's **Expose** button then creates `https://justportscanner.kreativekorna.com/<id>?t=<32hex>` URLs that auto-reconnect and stream arbitrary-size bodies.

## Tray app

```bash
npm run tauri:dev      # iterate
npm run tauri:build    # build the .app / .dmg / installer
```

The tray app spawns `node dist/index.js web` as a sidecar. To make tunnels work from the tray, export `EDGE_WS_URL` and `EDGE_TOKEN` in the shell that launches the app (or set them in the login env).

## Edge

See [`edge/`](./edge/). Containerized, deployed on the VPS via Aeroplane. Exposes `/_ping` (liveness) and `/_health` (JSON status). Protocol is documented inline in `edge/src/server.ts` and `src/web/tunnelManager.ts`.
