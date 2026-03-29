import http from 'http';
import { spawn, ChildProcess, execSync } from 'child_process';
import { TunnelInfo, RequestLog } from '../core/types';

const MAX_LOGS = 200;
const MAX_BODY_SIZE = 32 * 1024; // 32KB

interface TunnelEntry {
  cfProcess: ChildProcess;
  proxyServer: http.Server;
  proxyPort: number;
  url: string;
  port: number;
  createdAt: Date;
  logs: RequestLog[];
}

const activeTunnels = new Map<number, TunnelEntry>();
let logCounter = 0;

function isCloudflaredInstalled(): boolean {
  try {
    execSync('cloudflared --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function collectBody(stream: http.IncomingMessage | http.ServerResponse): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;

    stream.on('data', (chunk: Buffer) => {
      if (size < MAX_BODY_SIZE) {
        chunks.push(chunk);
        size += chunk.length;
      }
    });

    stream.on('end', () => {
      if (chunks.length === 0) {
        resolve(null);
      } else {
        const body = Buffer.concat(chunks).toString('utf-8').slice(0, MAX_BODY_SIZE);
        resolve(body);
      }
    });

    stream.on('error', () => resolve(null));
  });
}

function createProxy(targetPort: number, logs: RequestLog[]): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const startTime = Date.now();
      const logId = `req_${++logCounter}`;
      const requestChunks: Buffer[] = [];

      req.on('data', (chunk: Buffer) => requestChunks.push(chunk));
      req.on('end', () => {
        const requestBody = requestChunks.length > 0
          ? Buffer.concat(requestChunks).toString('utf-8').slice(0, MAX_BODY_SIZE)
          : null;

        const proxyReq = http.request(
          {
            hostname: 'localhost',
            port: targetPort,
            path: req.url,
            method: req.method,
            headers: req.headers,
          },
          (proxyRes) => {
            const responseChunks: Buffer[] = [];

            proxyRes.on('data', (chunk: Buffer) => {
              responseChunks.push(chunk);
              res.write(chunk);
            });

            proxyRes.on('end', () => {
              const responseBody = responseChunks.length > 0
                ? Buffer.concat(responseChunks).toString('utf-8').slice(0, MAX_BODY_SIZE)
                : null;

              const entry: RequestLog = {
                id: logId,
                timestamp: new Date().toISOString(),
                method: req.method || 'GET',
                path: req.url || '/',
                statusCode: proxyRes.statusCode || 0,
                duration: Date.now() - startTime,
                requestHeaders: req.headers as Record<string, string | string[] | undefined>,
                requestBody,
                responseBody,
              };

              logs.push(entry);
              if (logs.length > MAX_LOGS) {
                logs.splice(0, logs.length - MAX_LOGS);
              }

              res.end();
            });

            res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
          }
        );

        proxyReq.on('error', (err) => {
          const entry: RequestLog = {
            id: logId,
            timestamp: new Date().toISOString(),
            method: req.method || 'GET',
            path: req.url || '/',
            statusCode: 502,
            duration: Date.now() - startTime,
            requestHeaders: req.headers as Record<string, string | string[] | undefined>,
            requestBody,
            responseBody: `Proxy error: ${err.message}`,
          };

          logs.push(entry);
          if (logs.length > MAX_LOGS) {
            logs.splice(0, logs.length - MAX_LOGS);
          }

          res.writeHead(502);
          res.end(`Proxy error: ${err.message}`);
        });

        if (requestChunks.length > 0) {
          proxyReq.write(Buffer.concat(requestChunks));
        }
        proxyReq.end();
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve({ server, port: addr.port });
      } else {
        reject(new Error('Failed to get proxy server address'));
      }
    });

    server.on('error', reject);
  });
}

export async function openTunnel(port: number): Promise<TunnelInfo> {
  const existing = activeTunnels.get(port);
  if (existing) {
    return { port: existing.port, url: existing.url, createdAt: existing.createdAt.toISOString() };
  }

  if (!isCloudflaredInstalled()) {
    throw new Error(
      'cloudflared is not installed. Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
    );
  }

  const logs: RequestLog[] = [];
  const { server: proxyServer, port: proxyPort } = await createProxy(port, logs);

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      proxyServer.close();
      reject(new Error('Tunnel connection timed out after 15 seconds'));
    }, 15000);

    const child = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${proxyPort}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolved = false;

    const handleOutput = (data: Buffer) => {
      const output = data.toString();
      const match = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);

        const entry: TunnelEntry = {
          cfProcess: child,
          proxyServer,
          proxyPort,
          url: match[0],
          port,
          createdAt: new Date(),
          logs,
        };
        activeTunnels.set(port, entry);

        child.on('exit', () => {
          proxyServer.close();
          activeTunnels.delete(port);
        });

        resolve(match[0]);
      }
    };

    child.stdout.on('data', handleOutput);
    child.stderr.on('data', handleOutput);

    child.on('error', (err) => {
      clearTimeout(timeout);
      proxyServer.close();
      if (!resolved) {
        reject(new Error(`Failed to start cloudflared: ${err.message}`));
      }
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (!resolved) {
        proxyServer.close();
        reject(new Error(`cloudflared exited with code ${code}`));
      }
    });
  });

  const entry = activeTunnels.get(port);
  if (!entry) {
    throw new Error('Tunnel created but entry not found');
  }

  return { port: entry.port, url: entry.url, createdAt: entry.createdAt.toISOString() };
}

export async function closeTunnel(port: number): Promise<void> {
  const entry = activeTunnels.get(port);
  if (!entry) {
    throw new Error(`No active tunnel for port ${port}`);
  }
  entry.cfProcess.kill();
  entry.proxyServer.close();
  activeTunnels.delete(port);
}

export function listTunnels(): TunnelInfo[] {
  return Array.from(activeTunnels.values()).map((entry) => ({
    port: entry.port,
    url: entry.url,
    createdAt: entry.createdAt.toISOString(),
  }));
}

export function getTunnelLogs(port: number): RequestLog[] {
  const entry = activeTunnels.get(port);
  if (!entry) return [];
  return entry.logs;
}

export function clearTunnelLogs(port: number): void {
  const entry = activeTunnels.get(port);
  if (entry) {
    entry.logs.length = 0;
  }
}

export async function closeAllTunnels(): Promise<void> {
  for (const entry of activeTunnels.values()) {
    entry.cfProcess.kill();
    entry.proxyServer.close();
  }
  activeTunnels.clear();
}
