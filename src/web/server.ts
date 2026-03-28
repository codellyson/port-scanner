import express from 'express';
import path from 'path';
import { Server } from 'http';
import routes from './routes';
import { config } from '../config';
import chalk from 'chalk';

let serverInstance: Server | null = null;

export function startServer(port?: number, host?: string): void {
  const serverPort = port ?? config.port;
  const serverHost = host ?? config.host;

  const app = express();

  // Body parser
  app.use(express.json());

  // Serve static files
  app.use(express.static(path.join(__dirname, 'public')));

  // API routes
  app.use(routes);

  // Serve home page at root
  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Serve dashboard
  app.get('/dashboard', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  });

  serverInstance = app.listen(serverPort, serverHost, () => {
    console.log('');
    console.log(chalk.green('  Port Scanner Web Dashboard'));
    console.log(chalk.gray('  ─────────────────────────────'));
    console.log(`  ${chalk.bold('Local:')}   http://${serverHost}:${serverPort}`);
    if (serverHost === '0.0.0.0') {
      console.log(`  ${chalk.bold('Network:')} http://<your-ip>:${serverPort}`);
    }
    console.log('');
    console.log(chalk.gray('  Press Ctrl+C to stop the server'));
    console.log('');
  });
}

export function stopServer(): Promise<void> {
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
