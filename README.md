# Port Scanner

A powerful CLI and web dashboard to list, monitor, and manage running ports on your system.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)

## Features

- **CLI Interface** - Quick terminal access to port information
- **Web Dashboard** - Beautiful, real-time web UI with filtering and sorting
- **Cross-Platform** - Works on Linux, macOS, and Windows
- **Process Information** - See which process is using each port
- **Filtering** - Filter by port, protocol, state, or process name
- **Kill Processes** - Terminate processes directly from the dashboard
- **Demo Mode** - Safe mode for public deployments with sample data

## Installation

### Global Installation (Recommended)

```bash
pnpm add -g port-scanner-cli
```

### Local Installation

```bash
pnpm add port-scanner-cli
```

### From Source

```bash
git clone https://github.com/codellyson/port-scanner.git
cd port-scanner
pnpm install
pnpm run build
pnpm link --global
```

## Usage

### CLI Commands

#### List all ports

```bash
ports list
```

#### Filter by protocol

```bash
ports list --protocol tcp
ports list -P udp
```

#### Filter by port number

```bash
ports list --port 3000
ports list -p 80
```

#### Filter by state

```bash
ports list --state LISTEN
ports list -s ESTABLISHED
```

#### Filter by process name

```bash
ports list --process node
ports list -n nginx
```

#### Output as JSON

```bash
ports list --json
```

#### Combine filters

```bash
ports list --protocol tcp --state LISTEN --json
```

### Web Dashboard

Start the web dashboard:

```bash
ports web
```

With custom port and host:

```bash
ports web --port 8080 --host 0.0.0.0
```

### Dashboard Features

- Real-time port listing
- Auto-refresh (every 5 seconds, toggleable)
- Sortable columns (click headers)
- Search across all fields
- Filter by protocol and state
- Copy port to clipboard
- Kill processes directly
- Statistics overview

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Web server port |
| `HOST` | `localhost` | Web server host |
| `DEMO_MODE` | `false` | Enable demo mode with sample data |
| `ENABLE_KILL_ENDPOINT` | `true` | Enable/disable process kill endpoint |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in milliseconds |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Max requests per window |
| `CORS_ORIGINS` | `*` | Allowed CORS origins (comma-separated) |

### Demo Mode

For public deployments, enable demo mode to show sample data instead of real system information:

```bash
DEMO_MODE=true ports web
```

Or use the pnpm script:

```bash
pnpm run web:demo
```

## Docker

### Build the image

```bash
docker build -t port-scanner .
```

### Run the container

```bash
# Normal mode (scans container's ports)
docker run -p 3000:3000 port-scanner

# Demo mode (recommended for public deployments)
docker run -p 3000:3000 -e DEMO_MODE=true port-scanner

# With host network (scans host's ports - Linux only)
docker run --net=host -e PORT=3000 port-scanner
```

## Security Considerations

When deploying publicly:

1. **Always enable demo mode** (`DEMO_MODE=true`) to prevent exposing real system information
2. **Disable the kill endpoint** (`ENABLE_KILL_ENDPOINT=false`) in production
3. **Use rate limiting** - enabled by default
4. **Configure CORS** appropriately for your use case
5. **Run behind a reverse proxy** (nginx, Caddy) with HTTPS

## Development

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm run dev

# Build for production
pnpm run build

# Start production server
pnpm start

# Start web dashboard
pnpm run web

# Start in demo mode
pnpm run web:demo
```

## Requirements

- Node.js 18+
- Linux: `ss` or `netstat` command
- macOS: `lsof` or `netstat` command
- Windows: `netstat` command

## License

MIT License

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request
