# Edge deployment runbook

Phase 1 setup: one VPS, wildcard DNS, single shared `EDGE_TOKEN`. Replace `tunnel.example.com` with your real apex everywhere.

## 1. DNS

Point two records at the VPS public IP:

```
A   tunnel.example.com        →  <vps-ip>
A   *.tunnel.example.com      →  <vps-ip>
```

(Or AAAA for IPv6.)

## 2. Install runtime + Caddy on the VPS

```bash
# Node 20+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Caddy with a DNS plugin for your registrar.
# Cloudflare example — swap the plugin path if your DNS is elsewhere.
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy xcaddy
sudo xcaddy build --with github.com/caddy-dns/cloudflare --output /usr/bin/caddy
```

## 3. Deploy the edge

From your dev machine:

```bash
cd edge
npm install
npm run build
rsync -av --delete dist/ package.json package-lock.json node_modules/ \
  root@<vps-ip>:/opt/portscanner-edge/
```

Then on the VPS:

```bash
sudo useradd --system --home /opt/portscanner-edge --shell /usr/sbin/nologin portscanner
sudo chown -R portscanner:portscanner /opt/portscanner-edge
```

## 4. Configure secrets

Create `/etc/portscanner-edge.env`:

```bash
sudo tee /etc/portscanner-edge.env > /dev/null <<EOF
EDGE_TOKEN=$(openssl rand -hex 32)
BASE_DOMAIN=tunnel.example.com
PUBLIC_SCHEME=https
HOST=127.0.0.1
PORT=8443
EOF
sudo chmod 600 /etc/portscanner-edge.env
sudo cat /etc/portscanner-edge.env  # save EDGE_TOKEN somewhere safe
```

Caddy needs the DNS API token for ACME:

```bash
sudo systemctl edit caddy
# add:
#   [Service]
#   Environment=CLOUDFLARE_API_TOKEN=...
```

## 5. Install systemd + Caddy units

```bash
sudo cp portscanner-edge.service /etc/systemd/system/
sudo cp Caddyfile /etc/caddy/Caddyfile
# Edit /etc/caddy/Caddyfile — replace `tunnel.example.com` with your apex
sudo systemctl daemon-reload
sudo systemctl enable --now portscanner-edge caddy
sudo systemctl status portscanner-edge caddy
```

## 6. Wire your client

On your laptop, set the env vars so `ports web` uses the self-hosted backend:

```bash
export EDGE_WS_URL="wss://tunnel.example.com/agent"
export EDGE_TOKEN="<the token from step 4>"

ports web        # then click Expose in the dashboard
```

## Sanity checks

```bash
# Health: agent endpoint should 401 without a token
curl -i "https://tunnel.example.com/agent"   # expect 401

# Wildcard cert + 404 for unused subdomain
curl -i "https://nothing.tunnel.example.com"  # expect 404 "No active tunnel"

# Once an agent connects, the welcome frame's publicUrl works
```

## Phase 2 hooks

When you outgrow the single-token model, the swap-in points are:
- `EDGE_TOKEN` check in `server.ts` → look up the token in a DB, attach a user id to the agent.
- `randomSubdomain()` → check user's allowed subdomains; reject collisions belonging to other users.
- Per-agent quota counters in the `Agent` interface.
- TLS termination directly in the edge (drop Caddy) once you want HTTP/3.
