import { Router, Request, Response } from 'express';
import { execSync } from 'child_process';
import { scanPorts, filterPorts } from '../core/scanner';
import { FilterOptions } from '../core/types';
import { openTunnel, closeTunnel, listTunnels, getTunnelLogs, clearTunnelLogs } from './tunnelManager';

const router = Router();

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
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.post('/api/kill/:pid', (req: Request, res: Response) => {
  const pid = parseInt(String(req.params.pid), 10);

  if (!pid || isNaN(pid)) {
    res.status(400).json({
      success: false,
      error: 'Invalid PID',
    });
    return;
  }

  try {
    const platform = process.platform;
    if (platform === 'win32') {
      execSync(`taskkill /PID ${pid} /F`, { encoding: 'utf-8' });
    } else {
      execSync(`kill -9 ${pid}`, { encoding: 'utf-8' });
    }

    res.json({
      success: true,
      message: `Process ${pid} killed successfully`,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to kill process',
    });
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
