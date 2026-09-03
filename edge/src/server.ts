/**
 * Tunnel edge server. Accepts WS agent connections on /agent, routes public
 * HTTP traffic by path-prefix tunnel id to the agent that owns it. Streams
 * request and response bodies in chunked frames so multi-GB transfers don't
 * have to be buffered end-to-end.
 */
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { Store, DEFAULT_MAX_TUNNELS } from './store';
import { mountSignup, signupConfigFromEnv, SIGNUP_ROUTES } from './signup';

const PORT = parseInt(process.env.PORT || '8443', 10);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.EDGE_TOKEN || '';
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'tunnel.example.com';
const PUBLIC_SCHEME = process.env.PUBLIC_SCHEME || 'https';
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '30000', 10);
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || String(2 * 1024 * 1024 * 1024), 10);
const CHUNK_SIZE = 64 * 1024;
const DB_PATH = process.env.EDGE_DB || '/opt/portscanner-edge/edge.db';

const store = new Store(DB_PATH);

/**
 * `EDGE_TOKEN` is now the single-operator bootstrap credential rather than the
 * whole auth model: it maps to one built-in account so an edge with no signups
 * yet still works exactly as before. Per-user tokens issued from the database
 * are checked first.
 */
const OWNER = TOKEN ? store.upsertUser('bootstrap', 'owner', 'owner') : null;
if (OWNER) store.setMaxTunnels(OWNER.id, Number(process.env.OWNER_MAX_TUNNELS || 32));

if (!TOKEN && process.env.ALLOW_NO_BOOTSTRAP !== '1') {
  console.error('Missing EDGE_TOKEN env var. Set ALLOW_NO_BOOTSTRAP=1 to run with issued tokens only.');
  process.exit(1);
}

interface Pending {
  res: http.ServerResponse;
  started: boolean;
  responseTimeout: NodeJS.Timeout;
}

interface Agent {
  ws: WebSocket;
  id: string;
  userId: string;
  pending: Map<string, Pending>;
  accessToken?: string; // when set, tunnel requests must present this token
}

const HOP_BY_HOP = new Set(['host', 'connection', 'transfer-encoding', 'keep-alive', 'upgrade']);
const agents = new Map<string, Agent>();

function randomId(): string {
  return crypto.randomBytes(4).toString('hex'); // 8 hex chars
}

function stripHopByHop(headers: Record<string, string | string[] | undefined>) {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function safeSend(ws: WebSocket, payload: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(payload);
  } catch {
    // agent socket is going away; cleanup happens in close handler
  }
}

function sendChunks(ws: WebSocket, id: string, data: Buffer): void {
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    const slice = data.subarray(offset, Math.min(offset + CHUNK_SIZE, data.length));
    safeSend(ws, JSON.stringify({ type: 'req-chunk', id, data: slice.toString('base64') }));
  }
}

const RESERVED_IDS = new Set([
  'agent', 'favicon.ico', 'robots.txt', '_health', '_ping',
  ...SIGNUP_ROUTES,
]);

const app = express();
const startedAt = Date.now();

// Caddy terminates TLS and forwards; without this every client looks like
// 127.0.0.1 and the signup rate limiter would be keyed on one bucket.
app.set('trust proxy', 1);

const PUBLIC_BASE = `${PUBLIC_SCHEME}://${BASE_DOMAIN}`;
const AGENT_WS_URL = `${PUBLIC_SCHEME === 'https' ? 'wss' : 'ws'}://${BASE_DOMAIN}/agent`;
const signupConfig = signupConfigFromEnv(PUBLIC_BASE);

// Mounted before the tunnel catch-all so /signup and /auth/* are not read as
// tunnel ids; RESERVED_IDS keeps anyone from claiming those ids either.
mountSignup(app, store, signupConfig, AGENT_WS_URL);

// Cheap liveness — used by Aeroplane/load-balancer healthchecks. No state.
app.get('/_ping', (_req, res) => {
  res.status(200).type('text/plain').send('ok\n');
});

// Richer JSON health for humans and dashboards.
app.get('/_health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    agents: agents.size,
    base: PUBLIC_BASE,
    signup: signupConfig ? 'github' : 'disabled',
  });
});

// Public HTTP traffic — first path segment is the tunnel id. `/abc123/api/x?q=1`
// reaches agent abc123 as `/api/x?q=1`.
app.use((req, res) => {
  const fullUrl = req.url || '/';
  const m = fullUrl.match(/^\/([^\/?#]+)/);
  if (!m) {
    res.status(200).type('text/plain').send('port-scanner edge online.\n');
    return;
  }
  const id = m[1];
  if (RESERVED_IDS.has(id)) {
    res.status(404).type('text/plain').send('Not a tunnel route.\n');
    return;
  }
  const agent = agents.get(id);
  if (!agent) {
    res.status(404).type('text/plain').send(`No active tunnel "${id}".\n`);
    return;
  }
  const rest = fullUrl.slice(m[0].length);
  let remainder = rest.length === 0 ? '/' : (rest.startsWith('/') || rest.startsWith('?') ? (rest.startsWith('?') ? '/' + rest : rest) : '/' + rest);

  if (agent.accessToken) {
    let supplied: string | undefined;
    let suppliedViaAuthHeader = false;
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
      supplied = authHeader.slice(7).trim();
      suppliedViaAuthHeader = true;
    }
    // Parse and strip ?t= from the forwarded path so the local target doesn't see it.
    const qIdx = remainder.indexOf('?');
    if (qIdx !== -1) {
      const search = new URLSearchParams(remainder.slice(qIdx + 1));
      const t = search.get('t');
      if (t && !supplied) supplied = t;
      if (search.has('t')) {
        search.delete('t');
        const newQs = search.toString();
        remainder = newQs ? `${remainder.slice(0, qIdx)}?${newQs}` : remainder.slice(0, qIdx);
      }
    }
    if (supplied !== agent.accessToken) {
      res.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Bearer' });
      res.end('Unauthorized. Append ?t=<token> or send Authorization: Bearer <token>.\n');
      return;
    }
    // If the matching token came in via Authorization, hide it from the target app.
    if (suppliedViaAuthHeader) delete req.headers.authorization;
  }

  const reqId = crypto.randomUUID();
  let uploaded = 0;
  let aborted = false;

  // Timeout for the agent's res-start. After res-start, the response can take
  // as long as it needs — chunks reset progress implicitly.
  const responseTimeout = setTimeout(() => {
    if (!agent.pending.has(reqId)) return;
    const p = agent.pending.get(reqId)!;
    if (p.started) return;
    agent.pending.delete(reqId);
    safeSend(agent.ws, JSON.stringify({ type: 'error', id: reqId, message: 'agent timeout' }));
    if (!res.headersSent) res.status(504).type('text/plain').send('Agent did not respond in time.\n');
  }, REQUEST_TIMEOUT_MS);

  agent.pending.set(reqId, { res, started: false, responseTimeout });

  safeSend(agent.ws, JSON.stringify({
    type: 'req-start',
    id: reqId,
    method: req.method || 'GET',
    path: remainder,
    headers: stripHopByHop(req.headers as Record<string, string | string[] | undefined>),
  }));

  req.on('data', (chunk: Buffer) => {
    if (aborted) return;
    uploaded += chunk.length;
    if (uploaded > MAX_BODY_BYTES) {
      aborted = true;
      safeSend(agent.ws, JSON.stringify({ type: 'error', id: reqId, message: 'request body too large' }));
      agent.pending.delete(reqId);
      clearTimeout(responseTimeout);
      if (!res.headersSent) res.status(413).type('text/plain').send('Request body too large.\n');
      req.destroy();
      return;
    }
    sendChunks(agent.ws, reqId, chunk);
  });

  req.on('end', () => {
    if (aborted) return;
    safeSend(agent.ws, JSON.stringify({ type: 'req-end', id: reqId }));
  });

  // Public client disconnects mid-request — let the agent stop work.
  res.on('close', () => {
    if (!agent.pending.has(reqId)) return;
    agent.pending.delete(reqId);
    clearTimeout(responseTimeout);
    safeSend(agent.ws, JSON.stringify({ type: 'error', id: reqId, message: 'client disconnect' }));
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  if (url.pathname !== '/agent') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const presented = url.searchParams.get('token') || '';
  const user =
    (OWNER && presented && presented === TOKEN ? OWNER : null) ??
    store.authenticate(presented);

  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  if (user.status === 'blocked') {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  // Per-account concurrency cap. Without it one signup can pin the whole box.
  let held = 0;
  for (const a of agents.values()) if (a.userId === user.id) held++;
  if (held >= user.maxTunnels) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => handleAgent(ws, url, user.id));
});

function handleAgent(ws: WebSocket, url: URL, userId: string) {
  const requested = url.searchParams.get('id') || url.searchParams.get('subdomain') || '';
  const wellFormed = requested && /^[a-z0-9-]{3,40}$/i.test(requested) && !RESERVED_IDS.has(requested);
  // A requested id is only granted if this account already holds it or nobody
  // does — otherwise reconnecting agents could steal each other's URLs.
  const mayUse = wellFormed && !agents.has(requested) && store.claimId(requested, userId);
  let id = mayUse ? requested : randomId();
  while (agents.has(id) || (store.idOwner(id) && store.idOwner(id) !== userId)) id = randomId();

  const accessToken = url.searchParams.get('access') || undefined;
  const agent: Agent = { ws, id, userId, pending: new Map(), accessToken };
  agents.set(id, agent);
  console.log(`agent connected → ${id} (user ${userId})${accessToken ? ' [auth required]' : ''}`);

  ws.send(JSON.stringify({
    type: 'welcome',
    id,
    subdomain: id, // backward-compat alias
    publicUrl: `${PUBLIC_SCHEME}://${BASE_DOMAIN}/${id}`,
  }));

  const keepalive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 25_000);

  ws.on('message', (raw) => {
    let frame: unknown;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    const f = frame as { type?: string; id?: string; status?: number; headers?: Record<string, string | string[] | undefined>; data?: string; message?: string };
    if (typeof f.id !== 'string') return;
    const pending = agent.pending.get(f.id);
    if (!pending) return;

    if (f.type === 'res-start') {
      pending.started = true;
      clearTimeout(pending.responseTimeout);
      if (!pending.res.headersSent) {
        pending.res.writeHead(f.status || 502, stripHopByHop(f.headers || {}));
      }
    } else if (f.type === 'res-chunk' && typeof f.data === 'string') {
      pending.res.write(Buffer.from(f.data, 'base64'));
    } else if (f.type === 'res-end') {
      pending.res.end();
      agent.pending.delete(f.id);
    } else if (f.type === 'error') {
      clearTimeout(pending.responseTimeout);
      if (!pending.started && !pending.res.headersSent) {
        pending.res.writeHead(502, { 'content-type': 'text/plain' });
        pending.res.end(`Tunnel error: ${f.message || 'unknown'}\n`);
      } else {
        pending.res.end();
      }
      agent.pending.delete(f.id);
    }
  });

  ws.on('close', () => {
    clearInterval(keepalive);
    agents.delete(id);
    for (const pending of agent.pending.values()) {
      clearTimeout(pending.responseTimeout);
      if (!pending.started && !pending.res.headersSent) {
        pending.res.writeHead(502, { 'content-type': 'text/plain' });
        pending.res.end('Agent disconnected.\n');
      } else {
        pending.res.end();
      }
    }
    agent.pending.clear();
    console.log(`agent disconnected → ${id}`);
  });

  ws.on('error', (err) => {
    console.error(`agent ${id} error:`, err.message);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Edge listening on ${HOST}:${PORT}`);
  console.log(`Public base: ${PUBLIC_SCHEME}://${BASE_DOMAIN}/<id>/...`);
  console.log(`Agent WS:    ${AGENT_WS_URL}?token=...`);
  console.log(`Signup:      ${signupConfig ? `${PUBLIC_BASE}/signup (github)` : 'disabled — set GITHUB_CLIENT_ID/SECRET'}`);
});

const shutdown = () => {
  console.log('Shutting down…');
  for (const agent of agents.values()) {
    agent.ws.close(1001, 'edge shutting down');
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
