# Edge deployment runbook

Phase 1 setup: one VPS, one hostname, single shared `EDGE_TOKEN`. The host is
`portscanner.kreativekorna.com` throughout; if you change it, change it in
`Caddyfile` and in `BASE_DOMAIN` together.

## 1. DNS

One record, pointed at the VPS public IP:

```
A   portscanner.kreativekorna.com   →  <vps-ip>
```

(Or AAAA for IPv6.) It must resolve to the VPS itself — if the record is
proxied by a CDN, Caddy cannot complete an ACME challenge. In Cloudflare terms
that is DNS-only / grey cloud.

Routing is by path, not subdomain: the edge hands out `https://<host>/<id>`
URLs, so no wildcard record and no wildcard certificate are involved.

A `*.portscanner.kreativekorna.com` record also exists and is currently unused.
Leave it out of the Caddy site address — naming it would make Caddy attempt a
wildcard certificate, which only a DNS-01 challenge can satisfy. It only starts
mattering under "per-tunnel subdomains" in Phase 2 below.

## 2. Install runtime + Caddy on the VPS

Stock Caddy is enough — a single-host certificate needs no DNS-provider
plugin, so there is nothing to build with `xcaddy`.

```bash
# Node 20+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Caddy from the official apt repo
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

## 3. Deploy the edge

From your dev machine:

```bash
cd edge
npm install
npm run build

ssh <vps> 'mkdir -p /opt/portscanner-edge'
rsync -az --delete dist/ <vps>:/opt/portscanner-edge/dist/
rsync -az package.json package-lock.json <vps>:/opt/portscanner-edge/
```

Then on the VPS — install dependencies there rather than shipping
`node_modules/`, so they are built for the server's platform:

```bash
sudo useradd --system --home /opt/portscanner-edge --shell /usr/sbin/nologin portscanner
cd /opt/portscanner-edge && sudo npm ci --omit=dev
sudo chown -R portscanner:portscanner /opt/portscanner-edge
```

## 4. Configure secrets

Create `/etc/portscanner-edge.env`:

```bash
sudo tee /etc/portscanner-edge.env > /dev/null <<EOF
EDGE_TOKEN=$(openssl rand -hex 32)
BASE_DOMAIN=portscanner.kreativekorna.com
PUBLIC_SCHEME=https
HOST=127.0.0.1
PORT=8443
EOF
sudo chmod 600 /etc/portscanner-edge.env
sudo cat /etc/portscanner-edge.env  # save EDGE_TOKEN somewhere safe
```

### Open signup (optional)

Without these the edge still runs; `/signup` just returns 503 and you issue
tokens by hand. With them, anyone with a GitHub account can mint their own.

```
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
ABUSE_CONTACT=you@example.com     # shown on /signup
```

Register the OAuth app at <https://github.com/settings/developers> with the
callback URL `https://<BASE_DOMAIN>/auth/github/callback`. No scopes are
requested — the default grant already exposes the public profile, which is all
the store keys on.

### Turnstile bot check (optional, recommended for open signup)

```
TURNSTILE_SITEKEY=0x...                          # public, appears in the HTML
TURNSTILE_SECRET=0x...                           # never leaves this file
TURNSTILE_HOSTNAMES=portscanner.kreativekorna.com
```

These three are **all-or-nothing**. Set none and signup works unverified, as it
did before Turnstile existed. Set all three and `POST /auth/github` verifies the
token server-side against Cloudflare, failing closed on any error — including
Cloudflare being unreachable. Set only some and signup returns 503 rather than
serve a page that looks challenged but verifies nothing; the log line says which
are missing, and tunnels keep running either way.

`TURNSTILE_HOSTNAMES` is the frontend hostname allowlist checked against the
`hostname` siteverify reports. One widget can cover localhost and production, so
this — not the widget's domain list — is what stops a token minted on a laptop
from being replayed here. **Never put `localhost` or `127.0.0.1` in a production
value.**

Create the widget at <https://dash.cloudflare.com> → Turnstile, with domains
`<BASE_DOMAIN>`, and `localhost`/`127.0.0.1` only if you want to exercise it
locally. Restart the service after editing this file — systemd reads
`EnvironmentFile` at start, so an edit alone changes nothing.

## 5. Install the systemd unit

```bash
sudo cp portscanner-edge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now portscanner-edge
systemctl is-active portscanner-edge
curl -s http://127.0.0.1:8443/_health     # {"status":"ok", ...} — before any proxy
```

## 6. Publish it through Caddy

How this step goes depends on where Caddy gets its config, so check before
copying anything:

```bash
systemctl cat caddy | grep ExecStart
```

### If it ends in `--config /etc/caddy/Caddyfile`

Caddy is file-driven. Use this repo's `Caddyfile`:

```bash
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

### If it ends in `--resume` (this is the case on the current VPS)

Caddy is API-driven: it loads the last config pushed to its admin API from
`/var/lib/caddy/.config/caddy/autosave.json` and **never reads
`/etc/caddy/Caddyfile`**. Copying a Caddyfile there does nothing. The repo's
`Caddyfile` still describes what this service needs — treat it as the spec, and
express it as a route instead.

This also means Caddy here is shared with other sites. Look before you push:

```bash
curl -s localhost:2019/config/apps/http/servers/srv0/routes \
  | python3 -c 'import sys,json; r=json.load(sys.stdin); print(len(r),"routes"); [print(" ",i,(x.get("match") or [{}])[0].get("host")) for i,x in enumerate(r)]'
```

Append one route — POST to an array appends, and Caddy rolls back the old
config on error rather than going down:

```bash
cat > /tmp/edge-route.json <<'JSON'
{
  "handle": [{"handler": "subroute", "routes": [{"handle": [
    {"handler": "reverse_proxy", "upstreams": [{"dial": "127.0.0.1:8443"}]}
  ]}]}],
  "match": [{"host": ["portscanner.kreativekorna.com"]}],
  "terminal": true
}
JSON

curl -sS -X POST localhost:2019/config/apps/http/servers/srv0/routes \
  -H 'Content-Type: application/json' -d @/tmp/edge-route.json -w 'HTTP %{http_code}\n'
```

Automatic HTTPS starts as soon as the route lands; the certificate usually
arrives within seconds.

**Verify the array afterwards.** A POST here has been observed appending a
stray `null` alongside the intended route:

```bash
curl -s localhost:2019/config/apps/http/servers/srv0/routes \
  | python3 -c 'import sys,json; r=json.load(sys.stdin); print(len(r),"routes; nulls:",[i for i,x in enumerate(r) if x is None])'
```

Delete any null by index (`DELETE .../routes/<i>`); the same call removes the
route itself if you need to roll back.

Never `rm -rf /var/lib/caddy/.local/share/caddy/certificates` on a shared
Caddy — that storage backs every site on the box, not just this one.

## 7. Wire your client

On your laptop, set the env vars so `ports web` uses the self-hosted backend:

```bash
export EDGE_WS_URL="wss://portscanner.kreativekorna.com/agent"
export EDGE_TOKEN="<the token from step 4>"

ports web        # then click Expose in the dashboard
```

## Sanity checks

```bash
H=portscanner.kreativekorna.com

# Liveness through Caddy
curl -i "https://$H/_ping"      # expect 200 "ok"
curl -s "https://$H/_health"    # expect JSON, incl. the connected agent count

# Agent endpoint rejects an unauthenticated upgrade
curl -i "https://$H/agent"      # expect 401

# Unused tunnel id
curl -i "https://$H/nothing"    # expect 404 "No active tunnel"

# Once an agent connects, the welcome frame's publicUrl works
```

If `https://` fails while `http://` redirects, the certificate is the problem,
not the edge — Caddy serves the port-80 redirect without one. Check issuance:

```bash
sudo journalctl -u caddy -n 80 --no-pager | grep -iE "error|acme|certificate|tls"
```

## Phase 2 hooks

When you outgrow the single-token model, the swap-in points are:
- `EDGE_TOKEN` check in `server.ts` → look up the token in a DB, attach a user id to the agent.
- `randomId()` → check the user's allowed ids; reject collisions belonging to other users.
- Per-agent quota counters in the `Agent` interface.
- TLS termination directly in the edge (drop Caddy) once you want HTTP/3.
- Per-tunnel subdomains instead of path prefixes — that is the point where a
  wildcard record and a DNS-01 challenge (and so a DNS-provider plugin) start
  being necessary.
