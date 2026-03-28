import { Router, Request, Response } from 'express';
import { execSync } from 'child_process';
import { scanPorts, filterPorts } from '../core/scanner';
import { FilterOptions } from '../core/types';

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

export default router;
