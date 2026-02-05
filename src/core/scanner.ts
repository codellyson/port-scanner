import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import { parseLinuxSS, parseNetstat, parseLsof } from './parser';
import { PortInfo, FilterOptions, ScanResult } from './types';

function getProcessPath(pid: number | null, platform: string): string | null {
  if (!pid) return null;

  try {
    if (platform === 'linux') {
      return fs.readlinkSync(`/proc/${pid}/exe`);
    } else if (platform === 'darwin') {
      const output = execSync(`ps -p ${pid} -o comm= 2>/dev/null`, { encoding: 'utf-8' });
      return output.trim() || null;
    } else if (platform === 'win32') {
      const output = execSync(`wmic process where ProcessId=${pid} get ExecutablePath /format:list 2>nul`, { encoding: 'utf-8' });
      const match = output.match(/ExecutablePath=(.+)/);
      return match ? match[1].trim() : null;
    }
  } catch {
    return null;
  }
  return null;
}

function enrichPortsWithSource(ports: PortInfo[], platform: string): PortInfo[] {
  return ports.map((port) => ({
    ...port,
    source: getProcessPath(port.pid, platform),
  }));
}

export function getPlatform(): string {
  return os.platform();
}

export function scanPorts(): ScanResult {
  const platform = getPlatform();
  let ports: PortInfo[] = [];

  try {
    switch (platform) {
      case 'linux':
        ports = scanLinux();
        break;
      case 'darwin':
        ports = scanMacOS();
        break;
      case 'win32':
        ports = scanWindows();
        break;
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to scan ports: ${error.message}`);
    }
    throw error;
  }

  return {
    ports,
    timestamp: new Date(),
    platform,
  };
}

function scanLinux(): PortInfo[] {
  let ports: PortInfo[];
  try {
    // Try ss first (modern Linux)
    const output = execSync('ss -tulnp 2>/dev/null', { encoding: 'utf-8' });
    ports = parseLinuxSS(output);
  } catch {
    // Fall back to netstat
    try {
      const output = execSync('netstat -tulnp 2>/dev/null', { encoding: 'utf-8' });
      ports = parseNetstat(output, 'linux');
    } catch {
      throw new Error('Neither ss nor netstat is available');
    }
  }
  return enrichPortsWithSource(ports, 'linux');
}

function scanMacOS(): PortInfo[] {
  let ports: PortInfo[];
  try {
    // Use lsof on macOS for better process info
    const output = execSync('lsof -iTCP -iUDP -n -P 2>/dev/null', { encoding: 'utf-8' });
    ports = parseLsof(output);
  } catch {
    // Fall back to netstat
    const output = execSync('netstat -an 2>/dev/null', { encoding: 'utf-8' });
    ports = parseNetstat(output, 'darwin');
  }
  return enrichPortsWithSource(ports, 'darwin');
}

function scanWindows(): PortInfo[] {
  const output = execSync('netstat -ano', { encoding: 'utf-8' });
  const ports = parseNetstat(output, 'win32');
  return enrichPortsWithSource(ports, 'win32');
}

export function filterPorts(ports: PortInfo[], filters: FilterOptions): PortInfo[] {
  return ports.filter((port) => {
    if (filters.port !== undefined && port.port !== filters.port) {
      return false;
    }
    if (filters.protocol && port.protocol !== filters.protocol) {
      return false;
    }
    if (filters.process && port.process) {
      if (!port.process.toLowerCase().includes(filters.process.toLowerCase())) {
        return false;
      }
    }
    if (filters.state && port.state) {
      if (!port.state.toLowerCase().includes(filters.state.toLowerCase())) {
        return false;
      }
    }
    if (filters.source && port.source) {
      if (!port.source.toLowerCase().includes(filters.source.toLowerCase())) {
        return false;
      }
    }
    return true;
  });
}
