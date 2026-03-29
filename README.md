# Port Scanner

A lean CLI and web dashboard to list ports, kill processes, expose tunnels, and inspect webhook requests — all from your browser.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)

## Features

- **List Ports** — See every open port with process name and PID
- **Kill Processes** — One click to terminate any process
- **Expose Tunnels** — Turn any local port into a public URL via Cloudflare Tunnels
- **Request Logs** — Inspect every incoming request with method, path, status, headers, and body

## Installation

### Global (Recommended)

```bash
# npm
npm install -g port-scanner-cli

# pnpm
pnpm add -g port-scanner-cli

# yarn
yarn global add port-scanner-cli
```

### Local

```bash
# npm
npm install port-scanner-cli

# pnpm
pnpm add port-scanner-cli

# yarn
yarn add port-scanner-cli
```

### Install Cloudflared (for tunnels)

Required only if you want to expose local ports as public URLs.

```bash
# Linux / WSL
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb && sudo dpkg -i /tmp/cloudflared.deb

# macOS
brew install cloudflared

# Windows (PowerShell)
winget install Cloudflare.cloudflared
```

## Usage

### CLI

```bash
# List all ports
ports list

# Filter by protocol, state, or process
ports list --protocol tcp --state LISTEN
ports list --process node --json

# Launch the web dashboard
ports web
ports web --port 8080
```

### Web Dashboard

Start the dashboard and open it in your browser:

```bash
ports web
```

From the dashboard you can:

- **Filter and sort** ports by protocol, state, or search
- **Kill** any process with one click
- **Expose** a listening port as a public URL (via Cloudflare Tunnels)
- **Copy** the tunnel URL to your clipboard
- **View request logs** — see every request hitting your tunnel with method, path, status, headers, and body

## Requirements

- Node.js 18+
- Linux: `ss` or `netstat`
- macOS: `lsof` or `netstat`
- Windows: `netstat`
- `cloudflared` (optional, for tunnel feature)

## License

MIT License

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
