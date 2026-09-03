import express, { Request, Response } from 'express';
import { execSync } from 'child_process';
import { scanPorts, filterPorts } from '../core/scanner';
import { FilterOptions } from '../core/types';
import {
  openTunnel,
  closeTunnel,
  listTunnels,
  getTunnelLogs,
  clearTunnelLogs,
  replayLog,
  tunnelEvents,
  edgeStatus,
} from './tunnelManager';

const router: express.Router = express.Router();

/** How long a process gets to exit on SIGTERM before we escalate to SIGKILL. */
const KILL_ESCALATION_MS = 2000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH means it's gone; EPERM means it exists but isn't ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Ask the process to exit before forcing it. A dev server killed with SIGKILL
 * never releases its port cleanly or reaps its children, so try SIGTERM first
 * and only escalate if it's still around.
 */
async function terminate(pid: number): Promise<'SIGTERM' | 'SIGKILL'> {
  if (process.platform === 'win32') {
    execSync(`taskkill /PID ${pid} /T`, { encoding: 'utf-8', stdio: 'pipe' });
  } else {
    process.kill(pid, 'SIGTERM');
  }

  const deadline = Date.now() + KILL_ESCALATION_MS;
  while (Date.now() < deadline) {
    await sleep(100);
    if (!processAlive(pid)) return 'SIGTERM';
  }

  if (process.platform === 'win32') {
    execSync(`taskkill /PID ${pid} /T /F`, { encoding: 'utf-8', stdio: 'pipe' });
  } else {
    process.kill(pid, 'SIGKILL');
  }
  return 'SIGKILL';
}

router.get('/api/stream', (req: Request, res: Response) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const sendPorts = () => {
    try {
      const result = scanPorts();
      send('ports', {
        ports: result.ports,
        timestamp: result.timestamp,
        platform: result.platform,
        tunnels: listTunnels(),
        edge: edgeStatus(),
      });
    } catch (err) {
      send('error', { message: err instanceof Error ? err.message : 'scan failed' });
    }
  };

  sendPorts();
  const portsInterval = setInterval(sendPorts, 5000);

  const onLog = (payload: unknown) => send('log', payload);
  const onTunnel = (payload: unknown) => {
    send('tunnel', payload);
    sendPorts();
  };
  tunnelEvents.on('log', onLog);
  tunnelEvents.on('tunnel', onTunnel);

  // SSE-mandated comment keep-alive every 25s (defeats idle proxies).
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(portsInterval);
    clearInterval(keepAlive);
    tunnelEvents.off('log', onLog);
    tunnelEvents.off('tunnel', onTunnel);
  });
});

router.get('/api/ports', (req: Request, res: Response) => {
  try {
    const result = scanPorts();
    let ports = result.ports;

    const filters: FilterOptions = {};

    if (req.query.port) {
      filters.port = parseInt(req.query.port as string, 10);
    }
    if (req.query.protocol) {
      filters.protocol = (req.query.protocol as string).toLowerCase() as 'tcp' | 'udp';
    }
    if (req.query.state) {
      filters.state = req.query.state as string;
    }
    if (req.query.process) {
      filters.process = req.query.process as string;
    }
    if (req.query.source) {
      filters.source = req.query.source as string;
    }

    ports = filterPorts(ports, filters);

    res.json({
      success: true,
      data: {
        ports,
        timestamp: result.timestamp,
        platform: result.platform,
        total: ports.length,
        edge: edgeStatus(),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.post('/api/kill/:pid', async (req: Request, res: Response) => {
  const pid = parseInt(String(req.params.pid), 10);

  if (!pid || isNaN(pid)) {
    res.status(400).json({
      success: false,
      error: 'Invalid PID',
    });
    return;
  }

  try {
    const signal = await terminate(pid);

    res.json({
      success: true,
      message: signal === 'SIGKILL'
        ? `Process ${pid} did not exit within ${KILL_ESCALATION_MS}ms - force-killed`
        : `Process ${pid} stopped`,
      data: { signal },
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message =
      code === 'ESRCH' ? `No process with PID ${pid} - it may have already exited`
      : code === 'EPERM' ? `Not permitted to signal PID ${pid}`
      : error instanceof Error ? error.message
      : 'Failed to kill process';
    res.status(500).json({ success: false, error: message });
  }
});

router.post('/api/expose/:port', async (req: Request, res: Response) => {
  const port = parseInt(String(req.params.port), 10);

  if (!port || isNaN(port)) {
    res.status(400).json({
      success: false,
      error: 'Invalid port number',
    });
    return;
  }

  try {
    const result = scanPorts();
    const listening = result.ports.find(
      (p) => p.port === port && p.state.toUpperCase() === 'LISTEN'
    );

    if (!listening) {
      res.status(400).json({
        success: false,
        error: `Port ${port} is not actively listening`,
      });
      return;
    }

    const tunnel = await openTunnel(port);

    res.json({
      success: true,
      data: tunnel,
    });
  } catch (error) {
    res.status(502).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create tunnel',
    });
  }
});

router.delete('/api/expose/:port', async (req: Request, res: Response) => {
  const port = parseInt(String(req.params.port), 10);

  if (!port || isNaN(port)) {
    res.status(400).json({
      success: false,
      error: 'Invalid port number',
    });
    return;
  }

  try {
    await closeTunnel(port);
    res.json({
      success: true,
      message: `Tunnel for port ${port} closed`,
    });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to close tunnel',
    });
  }
});

router.get('/api/tunnels', (_req: Request, res: Response) => {
  const tunnels = listTunnels();
  res.json({
    success: true,
    data: { tunnels, total: tunnels.length },
  });
});

router.get('/api/tunnels/:port/logs', (req: Request, res: Response) => {
  const port = parseInt(String(req.params.port), 10);

  if (!port || isNaN(port)) {
    res.status(400).json({ success: false, error: 'Invalid port number' });
    return;
  }

  const logs = getTunnelLogs(port);
  res.json({
    success: true,
    data: { logs, total: logs.length },
  });
});

router.post('/api/tunnels/:port/replay/:logId', async (req: Request, res: Response) => {
  const port = parseInt(String(req.params.port), 10);
  const logId = String(req.params.logId);

  if (!port || isNaN(port)) {
    res.status(400).json({ success: false, error: 'Invalid port number' });
    return;
  }

  try {
    const replay = await replayLog(port, logId);
    res.json({ success: true, data: replay });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to replay request',
    });
  }
});

router.delete('/api/tunnels/:port/logs', (req: Request, res: Response) => {
  const port = parseInt(String(req.params.port), 10);

  if (!port || isNaN(port)) {
    res.status(400).json({ success: false, error: 'Invalid port number' });
    return;
  }

  clearTunnelLogs(port);
  res.json({ success: true, message: `Logs cleared for port ${port}` });
});

export default router;
