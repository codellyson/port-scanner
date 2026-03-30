import express from 'express';
import path from 'path';
import { Server } from 'http';
import routes from './routes';
import { config } from '../config';
import { closeAllTunnels } from './tunnelManager';
import chalk from 'chalk';

let serverInstance: Server | null = null;

export function startServer(port?: number, host?: string): void {
  const serverPort = port ?? config.port;
  const serverHost = host ?? config.host;

  const app = express();

  // Body parser
  app.use(express.json());

  const publicDir = path.join(__dirname, 'public');

  // Serve dashboard at both root and /dashboard
  app.get('/', (_req, res) => {
    res.sendFile(path.join(publicDir, 'dashboard.html'));
  });

  app.get('/dashboard', (_req, res) => {
    res.sendFile(path.join(publicDir, 'dashboard.html'));
  });

  // Serve static files
  app.use(express.static(publicDir));

  // API routes
  app.use(routes);

  serverInstance = app.listen(serverPort, serverHost, () => {
    const baseUrl = serverHost === '0.0.0.0' ? 'localhost' : serverHost;
    console.log('');
    console.log(chalk.green('  Port Scanner Web Dashboard'));
    console.log(chalk.gray('  ─────────────────────────────'));
    console.log(`  ${chalk.bold('Dashboard:')} ${chalk.cyan(`http://${baseUrl}:${serverPort}`)}`);

    if (serverHost === '0.0.0.0') {
      console.log(`  ${chalk.bold('Network:')}   http://<your-ip>:${serverPort}`);
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
