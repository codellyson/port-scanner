import chalk from 'chalk';
import { PortInfo } from '../core/types';

export function formatTable(ports: PortInfo[]): string {
  if (ports.length === 0) {
    return chalk.yellow('No ports found matching the criteria.');
  }

  // Calculate column widths
  const headers = ['PORT', 'PROTO', 'STATE', 'PID', 'PROCESS', 'USER', 'LOCAL ADDR', 'REMOTE ADDR', 'SOURCE'];
  const widths = [
    Math.max(5, ...ports.map((p) => String(p.port).length)),
    5,
    Math.max(5, ...ports.map((p) => (p.state || '-').length)),
    Math.max(5, ...ports.map((p) => String(p.pid || '-').length)),
    Math.max(7, ...ports.map((p) => (p.process || '-').length)),
    Math.max(4, ...ports.map((p) => (p.user || '-').length)),
    Math.max(10, ...ports.map((p) => p.localAddress.length)),
    Math.max(11, ...ports.map((p) => (p.remoteAddress || '-').length)),
    Math.max(6, ...ports.map((p) => (p.source || '-').length)),
  ];

  // Build header row
  const headerRow = headers.map((h, i) => h.padEnd(widths[i])).join('  ');
  const separator = widths.map((w) => '-'.repeat(w)).join('  ');

  // Build data rows
  const rows = ports.map((port) => {
    const cols = [
      chalk.cyan(String(port.port).padEnd(widths[0])),
      (port.protocol === 'tcp' ? chalk.green('tcp') : chalk.blue('udp')).padEnd(widths[1] + 10), // +10 for chalk codes
      formatState(port.state).padEnd(widths[2] + 10),
      (port.pid ? chalk.white(String(port.pid)) : chalk.gray('-')).padEnd(widths[3] + 10),
      (port.process ? chalk.yellow(port.process) : chalk.gray('-')).padEnd(widths[4] + 10),
      (port.user || chalk.gray('-')).padEnd(widths[5]),
      port.localAddress.padEnd(widths[6]),
      (port.remoteAddress || chalk.gray('-')).padEnd(widths[7]),
      (port.source ? chalk.magenta(port.source) : chalk.gray('-')).padEnd(widths[8] + 10),
    ];
    return cols.join('  ');
  });

  return [chalk.bold(headerRow), separator, ...rows].join('\n');
}

function formatState(state: string): string {
  const upper = state.toUpperCase();
  switch (upper) {
    case 'LISTEN':
      return chalk.green(state);
    case 'ESTABLISHED':
      return chalk.blue(state);
    case 'TIME_WAIT':
    case 'CLOSE_WAIT':
      return chalk.yellow(state);
    case 'CLOSED':
      return chalk.red(state);
    default:
      return chalk.gray(state);
  }
}

export function formatJson(ports: PortInfo[]): string {
  return JSON.stringify(ports, null, 2);
}

export function formatSummary(ports: PortInfo[]): string {
  const tcpCount = ports.filter((p) => p.protocol === 'tcp').length;
  const udpCount = ports.filter((p) => p.protocol === 'udp').length;
  const listeningCount = ports.filter((p) => p.state.toUpperCase() === 'LISTEN').length;
  const establishedCount = ports.filter((p) => p.state.toUpperCase() === 'ESTABLISHED').length;

  return [
    '',
    chalk.bold('Summary:'),
    `  Total ports: ${chalk.cyan(ports.length)}`,
    `  TCP: ${chalk.green(tcpCount)} | UDP: ${chalk.blue(udpCount)}`,
    `  Listening: ${chalk.green(listeningCount)} | Established: ${chalk.blue(establishedCount)}`,
  ].join('\n');
}
