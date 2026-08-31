import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { AddressInfo, Server } from 'net';
import routes from './routes';
import { config } from '../config';
import { closeAllTunnels } from './tunnelManager';
import chalk from 'chalk';

let serverInstance: Server | null = null;

export interface StartServerOptions {
  port?: number;
  host?: string;
  token?: string | null;
  /** When true, emit machine-readable READY line on stdout and suppress the banner. */
  emitReadyLine?: boolean;
}

function makeAuthMiddleware(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('authorization') || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
    const provided = bearer || queryToken;

    if (provided === token) {
      next();
      return;
    }

    res.status(401).json({ success: false, error: 'Unauthorized' });
  };
}

export function startServer(
  portArg?: number,
  hostArg?: string,
  options: Omit<StartServerOptions, 'port' | 'host'> = {}
): void {
  const serverPort = portArg ?? config.port;
  const serverHost = hostArg ?? config.host;
  const token = options.token ?? config.token;
  const emitReadyLine = options.emitReadyLine ?? false;

  const app = express();
  app.use(express.json());

  const publicDir = path.join(__dirname, 'public');
  const dashboardHtml = fs.readFileSync(path.join(publicDir, 'dashboard.html'), 'utf-8');

  // Dashboard pages — public (need to load so JS can capture the token from the URL).
  app.get(['/', '/dashboard'], (_req, res) => {
    res.type('html').send(dashboardHtml);
  });

  // Static assets — public so the dashboard can load before auth kicks in.
  app.use(express.static(publicDir));

  // Token gate for everything under /api when a token is set.
  if (token) {
    app.use('/api', makeAuthMiddleware(token));
  }

  app.use(routes);

  serverInstance = app.listen(serverPort, serverHost, () => {
    const addr = serverInstance!.address() as AddressInfo;
    const actualPort = addr.port;
    const displayHost = serverHost === '0.0.0.0' ? 'localhost' : serverHost;
    const url = `http://${displayHost}:${actualPort}`;
    const urlWithToken = token ? `${url}/?token=${encodeURIComponent(token)}` : url;

    if (emitReadyLine) {
      // Single line, no chalk, parseable by the desktop wrapper.
      process.stdout.write(`READY ${url} token=${token ?? ''}\n`);
      return;
    }

    console.log('');
    console.log(chalk.green('  Port Scanner Web Dashboard'));
    console.log(chalk.gray('  ─────────────────────────────'));
    console.log(`  ${chalk.bold('Dashboard:')} ${chalk.cyan(urlWithToken)}`);

    if (serverHost === '0.0.0.0') {
      console.log(`  ${chalk.bold('Network:')}   http://<your-ip>:${actualPort}`);
      if (!token) {
        console.log('');
        console.log(chalk.yellow('  ⚠  Bound to 0.0.0.0 without a token. Anyone on the network can kill processes.'));
        console.log(chalk.yellow('     Pass --token <secret> to require authentication.'));
      }
    }
    console.log('');
    console.log(chalk.gray('  Press Ctrl+C to stop the server'));
    console.log('');
  });

  const cleanup = async () => {
    await closeAllTunnels();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

export async function stopServer(): Promise<void> {
  await closeAllTunnels();
  return new Promise((resolve, reject) => {
    if (serverInstance) {
      serverInstance.close((err) => {
        if (err) reject(err);
        else resolve();
      });
      serverInstance = null;
    } else {
      resolve();
    }
  });
}
