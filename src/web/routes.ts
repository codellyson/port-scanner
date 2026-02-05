import { Router, Request, Response } from 'express';
import { execSync } from 'child_process';
import { scanPorts, filterPorts } from '../core/scanner';
import { FilterOptions } from '../core/types';
import { config } from '../config';
import { getDemoData } from './demo-data';

const router = Router();

router.get('/api/ports', (req: Request, res: Response) => {
  try {
    const result = config.demoMode ? getDemoData() : scanPorts();
    let ports = result.ports;

    // Apply filters from query params
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
        demoMode: config.demoMode,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.get('/api/stats', (req: Request, res: Response) => {
  try {
    const result = config.demoMode ? getDemoData() : scanPorts();
    const ports = result.ports;

    const stats = {
      total: ports.length,
      tcp: ports.filter((p) => p.protocol === 'tcp').length,
      udp: ports.filter((p) => p.protocol === 'udp').length,
      listening: ports.filter((p) => p.state.toUpperCase() === 'LISTEN').length,
      established: ports.filter((p) => p.state.toUpperCase() === 'ESTABLISHED').length,
      processes: [...new Set(ports.filter((p) => p.process).map((p) => p.process))].length,
      demoMode: config.demoMode,
    };

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    success: true,
    status: 'healthy',
    version: process.env.npm_package_version || '1.0.0',
    demoMode: config.demoMode,
    timestamp: new Date().toISOString(),
  });
});

router.post('/api/kill/:pid', (req: Request, res: Response) => {
  // Check if kill endpoint is enabled
  if (!config.enableKillEndpoint) {
    res.status(403).json({
      success: false,
      error: 'Kill endpoint is disabled in this environment',
    });
    return;
  }

  // Deny in demo mode
  if (config.demoMode) {
    res.status(403).json({
      success: false,
      error: 'Cannot kill processes in demo mode',
    });
    return;
  }

  const pid = parseInt(String(req.params.pid), 10);

  if (!pid || isNaN(pid)) {
    res.status(400).json({
      success: false,
      error: 'Invalid PID',
    });
    return;
  }

  try {
    // Kill the process
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

export default router;
