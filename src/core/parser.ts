import { PortInfo } from './types';

export function parseLinuxSS(output: string): PortInfo[] {
  const ports: PortInfo[] = [];
  const lines = output.trim().split('\n');

  // Skip header line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // ss output format: Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port Process
    const parts = line.split(/\s+/);
    if (parts.length < 5) continue;

    const protocol = parts[0].toLowerCase() as 'tcp' | 'udp';
    const state = parts[1];
    const localAddr = parts[4];

    // Parse local address and port
    const localMatch = localAddr.match(/(.+):(\d+)$/);
    if (!localMatch) continue;

    const localAddress = localMatch[1];
    const port = parseInt(localMatch[2], 10);

    // Parse remote address
    let remoteAddress: string | null = null;
    if (parts[5] && parts[5] !== '*:*') {
      remoteAddress = parts[5];
    }

    // Parse process info (format: users:(("process",pid=123,fd=4)))
    let pid: number | null = null;
    let process: string | null = null;
    let user: string | null = null;

    const processInfo = parts.slice(6).join(' ');
    const pidMatch = processInfo.match(/pid=(\d+)/);
    const processMatch = processInfo.match(/\(\("([^"]+)"/);
    const userMatch = processInfo.match(/users:\(\(([^)]+)\)/);

    if (pidMatch) pid = parseInt(pidMatch[1], 10);
    if (processMatch) process = processMatch[1];
    if (userMatch) user = userMatch[1].split(',')[0].replace(/"/g, '');

    ports.push({
      port,
      protocol: protocol === 'tcp' || protocol === 'udp' ? protocol : 'tcp',
      state,
      pid,
      process,
      user,
      localAddress,
      remoteAddress,
      source: null,
    });
  }

  return ports;
}

export function parseNetstat(output: string, platform: string): PortInfo[] {
  const ports: PortInfo[] = [];
  const lines = output.trim().split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip header lines
    if (trimmed.startsWith('Proto') || trimmed.startsWith('Active') || trimmed.startsWith('Internet')) {
      continue;
    }

    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;

    let protocol: 'tcp' | 'udp';
    let localAddr: string;
    let remoteAddr: string;
    let state: string;
    let pid: number | null = null;

    if (platform === 'win32') {
      // Windows: Proto Local Address Foreign Address State PID
      protocol = parts[0].toLowerCase().startsWith('tcp') ? 'tcp' : 'udp';
      localAddr = parts[1];
      remoteAddr = parts[2];
      state = parts[3] || 'UNKNOWN';
      if (parts[4]) pid = parseInt(parts[4], 10);
    } else if (platform === 'linux') {
      // Linux netstat: Proto Recv-Q Send-Q Local Address Foreign Address State PID/Program
      protocol = parts[0].toLowerCase().startsWith('tcp') ? 'tcp' : 'udp';
      localAddr = parts[3];
      remoteAddr = parts[4];
      state = parts[5] || 'UNKNOWN';
      if (parts[6]) {
        const pidMatch = parts[6].match(/^(\d+)/);
        if (pidMatch) pid = parseInt(pidMatch[1], 10);
      }
    } else {
      // macOS/BSD: Proto Recv-Q Send-Q Local Address Foreign Address (state)
      protocol = parts[0].toLowerCase().startsWith('tcp') ? 'tcp' : 'udp';
      localAddr = parts[3];
      remoteAddr = parts[4];
      state = parts[5] || 'UNKNOWN';
    }

    // Parse port from local address
    const portMatch = localAddr.match(/:(\d+)$|\.(\d+)$/);
    if (!portMatch) continue;

    const port = parseInt(portMatch[1] || portMatch[2], 10);
    const localAddress = localAddr.replace(/[:.]\d+$/, '');

    ports.push({
      port,
      protocol,
      state,
      pid,
      process: null,
      user: null,
      localAddress,
      remoteAddress: remoteAddr === '*:*' || remoteAddr === '0.0.0.0:*' ? null : remoteAddr,
      source: null,
    });
  }

  return ports;
}

export function parseLsof(output: string): PortInfo[] {
  const ports: PortInfo[] = [];
  const lines = output.trim().split('\n');

  // Skip header
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // lsof output: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
    const parts = line.split(/\s+/);
    if (parts.length < 9) continue;

    const process = parts[0];
    const pid = parseInt(parts[1], 10);
    const user = parts[2];
    const type = parts[4];
    const name = parts.slice(8).join(' ');

    // Determine protocol from type
    let protocol: 'tcp' | 'udp';
    if (type.includes('TCP') || name.includes('TCP')) {
      protocol = 'tcp';
    } else if (type.includes('UDP') || name.includes('UDP')) {
      protocol = 'udp';
    } else {
      continue;
    }

    // Parse address and port from NAME (format: host:port or host:port->remote:port)
    const addrMatch = name.match(/([^:]+):(\d+)/);
    if (!addrMatch) continue;

    const localAddress = addrMatch[1];
    const port = parseInt(addrMatch[2], 10);

    // Parse state and remote address
    let state = 'UNKNOWN';
    let remoteAddress: string | null = null;

    if (name.includes('(LISTEN)')) {
      state = 'LISTEN';
    } else if (name.includes('(ESTABLISHED)')) {
      state = 'ESTABLISHED';
    } else if (name.includes('(CLOSE_WAIT)')) {
      state = 'CLOSE_WAIT';
    } else if (name.includes('(TIME_WAIT)')) {
      state = 'TIME_WAIT';
    }

    const remoteMatch = name.match(/->([^:]+:\d+)/);
    if (remoteMatch) {
      remoteAddress = remoteMatch[1];
    }

    ports.push({
      port,
      protocol,
      state,
      pid,
      process,
      user,
      localAddress,
      remoteAddress,
      source: null,
    });
  }

  return ports;
}
