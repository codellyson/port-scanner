import http from 'http';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { TunnelInfo, RequestLog } from '../core/types';

/** Fires `log` ({ port, log }) and `tunnel` ({ type, port, url? }) events. */
export const tunnelEvents = new EventEmitter();

const MAX_LOGS = 200;
const MAX_BODY_SIZE = 32 * 1024; // 32KB — log capture cap; does not limit forwarded bodies
const CHUNK_SIZE = 64 * 1024; // max bytes per res-chunk frame; larger chunks get split

const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const MAX_RECONNECT_ATTEMPTS = 50;
const WELCOME_TIMEOUT_MS = 10_000;

interface TunnelEntry {
  ws?: WebSocket;
  id?: string;
  url: string;
  baseUrl?: string;
  accessToken?: string;
  port: number;
  createdAt: Date;
  logs: RequestLog[];
  closed?: boolean;
  reconnecting?: boolean;
  inFlight: Map<string, InFlightRequest>;
}

const activeTunnels = new Map<number, TunnelEntry>();
let logCounter = 0;

interface AgentReqStartFrame {
  type: 'req-start';
  id: string;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

interface AgentChunkFrame {
  type: 'req-chunk' | 'res-chunk';
  id: string;
  data: string; // base64
}

interface AgentEndFrame {
  type: 'req-end' | 'res-end';
  id: string;
}

interface AgentErrorFrame {
  type: 'error';
  id: string;
  message: string;
}

interface AgentWelcomeFrame {
  type: 'welcome';
  id?: string;
  subdomain: string;
  publicUrl: string;
}

interface InFlightRequest {
  proxyReq: http.ClientRequest;
  startTime: number;
  logId: string;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  reqLogChunks: Buffer[];
  reqLogSize: number;
  resLogChunks: Buffer[];
  resLogSize: number;
  statusCode: number;
  finalized: boolean;
}

function safeSend(ws: WebSocket, payload: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(payload);
  } catch {
    // ws is going away; the close handler will clean up in-flight state
  }
}

function sendChunks(ws: WebSocket, type: 'res-chunk', id: string, data: Buffer): void {
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    const slice = data.subarray(offset, Math.min(offset + CHUNK_SIZE, data.length));
    safeSend(ws, JSON.stringify({ type, id, data: slice.toString('base64') }));
  }
}

function finalizeLog(handle: InFlightRequest, entry: TunnelEntry): void {
  if (handle.finalized) return;
  handle.finalized = true;
  const log: RequestLog = {
    id: handle.logId,
    timestamp: new Date(handle.startTime).toISOString(),
    method: handle.method,
    path: handle.path,
    statusCode: handle.statusCode,
    duration: Date.now() - handle.startTime,
    requestHeaders: handle.headers,
    requestBody: handle.reqLogChunks.length ? Buffer.concat(handle.reqLogChunks).toString('utf-8') : null,
    responseBody: handle.resLogChunks.length ? Buffer.concat(handle.resLogChunks).toString('utf-8') : null,
  };
  entry.logs.push(log);
  if (entry.logs.length > MAX_LOGS) {
    entry.logs.splice(0, entry.logs.length - MAX_LOGS);
  }
  tunnelEvents.emit('log', { port: entry.port, log });
}

function handleReqStart(frame: AgentReqStartFrame, entry: TunnelEntry, ws: WebSocket, inFlight: Map<string, InFlightRequest>): void {
  const proxyReq = http.request(
    {
      hostname: 'localhost',
      port: entry.port,
      path: frame.path,
      method: frame.method,
      headers: frame.headers as http.OutgoingHttpHeaders,
    },
    (proxyRes) => {
      const handle = inFlight.get(frame.id);
      if (handle) handle.statusCode = proxyRes.statusCode || 0;

      safeSend(ws, JSON.stringify({
        type: 'res-start',
        id: frame.id,
        status: proxyRes.statusCode || 502,
        headers: proxyRes.headers,
      }));

      proxyRes.on('data', (chunk: Buffer) => {
        const h = inFlight.get(frame.id);
        if (h && h.resLogSize < MAX_BODY_SIZE) {
          const take = Math.min(chunk.length, MAX_BODY_SIZE - h.resLogSize);
          h.resLogChunks.push(chunk.subarray(0, take));
          h.resLogSize += take;
        }
        sendChunks(ws, 'res-chunk', frame.id, chunk);
      });

      proxyRes.on('end', () => {
        safeSend(ws, JSON.stringify({ type: 'res-end', id: frame.id }));
        const h = inFlight.get(frame.id);
        if (h) {
          finalizeLog(h, entry);
          inFlight.delete(frame.id);
        }
      });
    },
  );

  proxyReq.on('error', (err) => {
    safeSend(ws, JSON.stringify({ type: 'error', id: frame.id, message: `Local target unreachable: ${err.message}` }));
    const h = inFlight.get(frame.id);
    if (h) {
      h.statusCode = 502;
      finalizeLog(h, entry);
      inFlight.delete(frame.id);
    }
  });

  inFlight.set(frame.id, {
    proxyReq,
    startTime: Date.now(),
    logId: `req_${++logCounter}`,
    method: frame.method,
    path: frame.path,
    headers: frame.headers,
    reqLogChunks: [],
    reqLogSize: 0,
    resLogChunks: [],
    resLogSize: 0,
    statusCode: 0,
    finalized: false,
  });
}

function handleReqChunk(frame: AgentChunkFrame, inFlight: Map<string, InFlightRequest>): void {
  const handle = inFlight.get(frame.id);
  if (!handle) return;
  const chunk = Buffer.from(frame.data, 'base64');
  if (handle.reqLogSize < MAX_BODY_SIZE) {
    const take = Math.min(chunk.length, MAX_BODY_SIZE - handle.reqLogSize);
    handle.reqLogChunks.push(chunk.subarray(0, take));
    handle.reqLogSize += take;
  }
  handle.proxyReq.write(chunk);
}

function handleReqEnd(frame: AgentEndFrame, inFlight: Map<string, InFlightRequest>): void {
  const handle = inFlight.get(frame.id);
  if (!handle) return;
  handle.proxyReq.end();
}

function handleEdgeError(frame: AgentErrorFrame, entry: TunnelEntry, inFlight: Map<string, InFlightRequest>): void {
  const handle = inFlight.get(frame.id);
  if (!handle) return;
  handle.proxyReq.destroy(new Error(frame.message || 'edge aborted'));
  handle.statusCode = handle.statusCode || 0;
  finalizeLog(handle, entry);
  inFlight.delete(frame.id);
}

function connectAgent(
  entry: TunnelEntry,
  edgeUrl: string,
  edgeToken: string,
  attempt: number,
  onWelcome?: (err: Error | null) => void,
): void {
  if (entry.closed) {
    if (onWelcome) onWelcome(new Error('tunnel closed'));
    return;
  }

  const isReconnect = !!entry.id;
  const idParam = entry.id ? `&id=${encodeURIComponent(entry.id)}` : '';
  const accessParam = entry.accessToken ? `&access=${encodeURIComponent(entry.accessToken)}` : '';
  const dialUrl = `${edgeUrl}?token=${encodeURIComponent(edgeToken)}${idParam}${accessParam}`;
  const ws = new WebSocket(dialUrl);
  entry.ws = ws;
  let welcomed = false;

  const welcomeTimeout = setTimeout(() => {
    if (!welcomed) ws.close();
  }, WELCOME_TIMEOUT_MS);

  ws.on('message', (raw) => {
    let frame: unknown;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    const f = frame as { type?: string };

    if (f.type === 'welcome' && !welcomed) {
      const w = frame as AgentWelcomeFrame;
      welcomed = true;
      clearTimeout(welcomeTimeout);

      const newId = w.id || w.subdomain;
      const previousUrl = entry.url;

      entry.id = newId;
      entry.baseUrl = w.publicUrl;
      entry.url = entry.accessToken ? `${w.publicUrl}?t=${entry.accessToken}` : w.publicUrl;
      entry.reconnecting = false;

      if (isReconnect) {
        if (previousUrl && previousUrl !== w.publicUrl) {
          tunnelEvents.emit('tunnel', {
            type: 'url-changed',
            port: entry.port,
            url: w.publicUrl,
            previousUrl,
          });
        }
        tunnelEvents.emit('tunnel', { type: 'reconnected', port: entry.port, url: w.publicUrl });
      }

      if (onWelcome) onWelcome(null);
    } else if (f.type === 'req-start') {
      handleReqStart(frame as AgentReqStartFrame, entry, ws, entry.inFlight);
    } else if (f.type === 'req-chunk') {
      handleReqChunk(frame as AgentChunkFrame, entry.inFlight);
    } else if (f.type === 'req-end') {
      handleReqEnd(frame as AgentEndFrame, entry.inFlight);
    } else if (f.type === 'error') {
      handleEdgeError(frame as AgentErrorFrame, entry, entry.inFlight);
    }
  });

  // 'error' fires before 'close'; let close handle the reconnect decision.
  ws.on('error', () => {});

  ws.on('close', () => {
    clearTimeout(welcomeTimeout);
    if (entry.ws !== ws) return; // superseded by a newer connection
    // Abort in-flight requests — their edge-side pending handlers are gone.
    for (const handle of entry.inFlight.values()) {
      handle.proxyReq.destroy();
    }
    entry.inFlight.clear();
    if (entry.closed) {
      if (!welcomed && onWelcome) onWelcome(new Error('Edge connection closed before welcome'));
      return;
    }
    if (!welcomed && attempt === 1) {
      // Initial connect failed — fail fast, don't loop forever on a misconfigured edge.
      if (onWelcome) onWelcome(new Error('Edge connection closed before welcome'));
      return;
    }
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      entry.closed = true;
      entry.reconnecting = false;
      activeTunnels.delete(entry.port);
      tunnelEvents.emit('tunnel', {
        type: 'closed',
        port: entry.port,
        reason: 'reconnect attempts exhausted',
      });
      return;
    }

    // After a successful welcome, the next disconnect restarts the backoff from 1.
    // A failed reconnect attempt continues climbing the backoff ladder.
    const nextAttempt = welcomed ? 1 : attempt + 1;
    const delay = RECONNECT_DELAYS_MS[Math.min(nextAttempt - 1, RECONNECT_DELAYS_MS.length - 1)];
    entry.reconnecting = true;
    tunnelEvents.emit('tunnel', {
      type: 'reconnecting',
      port: entry.port,
      attempt: nextAttempt,
      delay,
    });
    setTimeout(() => {
      if (entry.closed) return;
      connectAgent(entry, edgeUrl, edgeToken, nextAttempt);
    }, delay);
  });
}

/**
 * Which edge env vars are configured. The dashboard reads this up front so the
 * Expose button can be disabled with a reason instead of failing on click.
 */
export function edgeStatus(): { available: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!process.env.EDGE_WS_URL) missing.push('EDGE_WS_URL');
  if (!process.env.EDGE_TOKEN) missing.push('EDGE_TOKEN');
  return { available: missing.length === 0, missing };
}

export async function openTunnel(port: number): Promise<TunnelInfo> {
  const existing = activeTunnels.get(port);
  if (existing) {
    return { port: existing.port, url: existing.url, createdAt: existing.createdAt.toISOString() };
  }

  const edgeUrl = process.env.EDGE_WS_URL;
  const edgeToken = process.env.EDGE_TOKEN;
  if (!edgeUrl || !edgeToken) {
    throw new Error('EDGE_WS_URL and EDGE_TOKEN must be set to expose a tunnel');
  }

  const accessToken = process.env.TUNNEL_NO_AUTH === '1' ? undefined : crypto.randomBytes(16).toString('hex');
  const entry: TunnelEntry = {
    url: '',
    accessToken,
    port,
    createdAt: new Date(),
    logs: [],
    inFlight: new Map(),
  };
  activeTunnels.set(port, entry);

  return new Promise<TunnelInfo>((resolve, reject) => {
    connectAgent(entry, edgeUrl, edgeToken, 1, (err) => {
      if (err) {
        entry.closed = true;
        activeTunnels.delete(port);
        reject(err);
        return;
      }
      tunnelEvents.emit('tunnel', { type: 'opened', port, url: entry.url });
      resolve({ port, url: entry.url, createdAt: entry.createdAt.toISOString() });
    });
  });
}

export async function closeTunnel(port: number): Promise<void> {
  const entry = activeTunnels.get(port);
  if (!entry) {
    throw new Error(`No active tunnel for port ${port}`);
  }
  entry.closed = true;
  if (entry.ws) entry.ws.close(1000, 'tunnel closed');
  activeTunnels.delete(port);
  tunnelEvents.emit('tunnel', { type: 'closed', port });
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

export async function replayLog(port: number, logId: string): Promise<RequestLog> {
  const entry = activeTunnels.get(port);
  if (!entry) {
    throw new Error(`No active tunnel for port ${port}`);
  }

  const original = entry.logs.find((l) => l.id === logId);
  if (!original) {
    throw new Error(`Log entry ${logId} not found`);
  }

  // Strip hop-by-hop and length-bound headers — http.request sets them
  // correctly based on the (possibly truncated) replay body.
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(original.requestHeaders)) {
    const key = k.toLowerCase();
    if (key === 'host' || key === 'content-length' || key === 'connection' || key === 'transfer-encoding') {
      continue;
    }
    headers[k] = v;
  }

  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path: original.path,
        method: original.method,
        headers: headers as http.OutgoingHttpHeaders,
      },
      (res) => {
        const logChunks: Buffer[] = [];
        let logSize = 0;

        res.on('data', (chunk: Buffer) => {
          if (logSize < MAX_BODY_SIZE) {
            const take = Math.min(chunk.length, MAX_BODY_SIZE - logSize);
            logChunks.push(chunk.subarray(0, take));
            logSize += take;
          }
        });

        res.on('end', () => {
          const responseBody = logChunks.length > 0 ? Buffer.concat(logChunks).toString('utf-8') : null;
          const replay: RequestLog = {
            id: `req_${++logCounter}`,
            timestamp: new Date().toISOString(),
            method: original.method,
            path: original.path,
            statusCode: res.statusCode || 0,
            duration: Date.now() - startTime,
            requestHeaders: original.requestHeaders,
            requestBody: original.requestBody,
            responseBody,
          };
          entry.logs.push(replay);
          if (entry.logs.length > MAX_LOGS) {
            entry.logs.splice(0, entry.logs.length - MAX_LOGS);
          }
          tunnelEvents.emit('log', { port, log: replay });
          resolve(replay);
        });
      }
    );

    req.on('error', reject);

    if (original.requestBody) {
      req.write(original.requestBody);
    }
    req.end();
  });
}

export function clearTunnelLogs(port: number): void {
  const entry = activeTunnels.get(port);
  if (entry) {
    entry.logs.length = 0;
  }
}

export async function closeAllTunnels(): Promise<void> {
  for (const entry of activeTunnels.values()) {
    entry.closed = true;
    if (entry.ws) entry.ws.close(1001, 'shutting down');
  }
  activeTunnels.clear();
}
