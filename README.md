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

Tunnels need `EDGE_WS_URL` and `EDGE_TOKEN` in the server's environment. The
tray app keeps them in a config file; the quickest way to run the dashboard
from a terminal is to source that same file, so both paths share one copy of
the token:

```bash
set -a; . "$HOME/Library/Application Support/com.codellyson.portscanner/edge.env"; set +a
node dist/index.js web --token "$(openssl rand -hex 16)"
```

Or set them yourself, if you would rather not depend on the tray's file:

```bash
export EDGE_WS_URL="wss://portscanner.kreativekorna.com/agent"
export EDGE_TOKEN="<from /etc/portscanner-edge.env on the VPS>"
node dist/index.js web --token "$(openssl rand -hex 16)"
```

Either way, `GET /api/ports` should report `data.edge` as
`{"available": true, "missing": []}` — that is the same field the dashboard
reads to decide whether **Expose** is clickable. If it lists missing keys, the
server process did not inherit them, and no amount of clicking will help.

**Expose** then creates `https://portscanner.kreativekorna.com/<id>?t=<32hex>`
URLs that auto-reconnect and stream arbitrary-size bodies. The `t` parameter is
a per-tunnel access token — anyone with the full URL reaches your local port,
so treat it as a secret and close the tunnel when you are done.

## Tray app

```bash
npm run tauri:dev      # iterate
npm run tauri:build    # build the .app / .dmg / installer
```

Tagged builds are produced by [`.github/workflows/release.yml`](.github/workflows/release.yml):
push a `v*` tag and it bundles for Apple silicon, Intel macOS, Linux and
Windows on native runners, then publishes the release. Keep the tag
in step with the `version` in `src-tauri/tauri.conf.json` and
`src-tauri/Cargo.toml`.

The bundles are **unsigned**. macOS quarantines a downloaded app that no
Developer ID vouches for, so first launch needs one of:

```bash
xattr -dr com.apple.quarantine "/Applications/Port Scanner.app"
```

or right-click the app → Open → Open. To remove the step properly, add an
Apple Developer ID and notarisation credentials as repository secrets and
Tauri will sign during the release build.

### Updates

The tray menu has a **Check for Updates…** item. It asks
`https://github.com/codellyson/port-scanner/releases/latest/download/latest.json`
for the newest published release, and the label changes to say what it found —
`Up to Date · v1.0.7`, `Install v1.0.8 and Restart`, download progress, or
why it failed. Nothing installs without a click. A background check runs
30 seconds after launch and every six hours; it never shows errors, it just
quietly tries again later. Dev builds show the item disabled.

Updates are minisign-signed. The public key lives in
`src-tauri/tauri.conf.json`; the private key must never enter the repo. To
release signed bundles from CI, add one repository secret,
`TAURI_SIGNING_PRIVATE_KEY`, holding the contents of the private key file.
The key has no password, and the workflow sets
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to an empty string itself — the CLI
needs the variable present (unset, it tries to prompt) but empty (anything
else is "Wrong password for that key"). If you ever generate a key *with* a
password, switch that line back to a secret.

A local `cargo tauri build` needs the key too, since
`bundle.createUpdaterArtifacts` is on. The bundler reads the key *contents*
from `TAURI_SIGNING_PRIVATE_KEY`; the `_PATH` variant is only understood by
`cargo tauri signer sign`, and a build without either silently skips the
`.sig` files:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.tauri/portscanner.key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri:build
```

The release workflow creates a draft first, has the four platform builds
upload into it, and publishes it once all of them have finished. If any platform fails, it stays a draft —
installed apps never see a release missing their bundle — and you can
re-run the failed job or publish by hand after fixing it. If the very first
`draft` job fails with "Resource not accessible by integration", GitHub is
refusing to let the workflow token create releases; add a fine-grained
personal token with *Contents: read and write* on this repo as the
`RELEASE_TOKEN` secret and the workflow uses it instead. Lose the
private key and no existing install can ever update again — generate a new
pair with `cargo tauri signer generate -w ~/.tauri/portscanner.key`, swap
the pubkey in the config, and users reinstall once by hand.

### Icons

`src-tauri/icons/app-icon.svg` is the only hand-edited app icon; everything
else in that folder (`icon.icns` for macOS, `icon.ico` for Windows, the PNG
sizes for Linux and the Windows Store logos) is generated from it:

```bash
cargo tauri icon src-tauri/icons/app-icon.svg
```

The menu bar glyph is separate. `tray.svg` is a black template image that
macOS tints itself; `tray-color.svg` is the coloured version Windows and Linux
draw as-is. Regenerate their PNGs with:

```bash
cargo tauri icon -p 36 -o /tmp/tray src-tauri/icons/tray.svg && mv /tmp/tray/36x36.png src-tauri/icons/tray.png
cargo tauri icon -p 32 -o /tmp/tray src-tauri/icons/tray-color.svg && mv /tmp/tray/32x32.png src-tauri/icons/tray-color.png
```

The dashboard favicon (`src/web/public/favicon.svg`) is a copy of the app icon.

To build locally:

Both commands build `dist/` and package the server into `src-tauri/binaries/ports-server-<target-triple>` first — that binary is the sidecar the bundled app runs. A bare `cargo check` in `src-tauri/` needs it to exist too, since `externalBin` is verified at build time. During `cargo tauri dev` the app falls back to `node dist/index.js` if the sidecar is missing.

The menu is the whole interface, so it says what is actually happening:

| Item | What it does |
|---|---|
| *(first line)* | Server state — starting, `Running · localhost:53421`, or why it stopped and when it retries |
| *(second line)* | Whether tunnels can work, and which variable is missing if not |
| Open Dashboard | Opens the dashboard with the session token. Disabled until the server is up |
| Copy Dashboard URL | Same URL to the clipboard |
| Restart Server | Stops and restarts, re-reading `edge.env` |
| Edit Edge Config… | Creates and opens `edge.env` (see below) |
| Start at Login | Registers a login item. Release builds only |
| Quit | SIGTERM, up to 2s for the server to close its tunnels, then SIGKILL |

A server that exits on its own is restarted automatically with the same 1/2/4/8/16/30s backoff the tunnel client uses; the menu counts down. After six failures it stops and says so.

### Tunnels from the tray

The tray is launched by the OS, not by your shell, so it never sees `export EDGE_TOKEN=...` from your profile. **Edit Edge Config…** creates and opens:

```
~/Library/Application Support/com.codellyson.portscanner/edge.env    # macOS
```

with `EDGE_WS_URL=` and `EDGE_TOKEN=` to fill in. Pick **Restart Server** to apply. A real environment variable of the same name still wins, so launching from a terminal with those exported keeps working unchanged.

## Edge

See [`edge/`](./edge/). Containerized, deployed on the VPS via Aeroplane. Exposes `/_ping` (liveness) and `/_health` (JSON status). Protocol is documented inline in `edge/src/server.ts` and `src/web/tunnelManager.ts`.
