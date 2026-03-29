export interface PortInfo {
  port: number;
  protocol: 'tcp' | 'udp';
  state: string;
  pid: number | null;
  process: string | null;
  user: string | null;
  localAddress: string;
  remoteAddress: string | null;
  source: string | null;
}

export interface FilterOptions {
  port?: number;
  protocol?: 'tcp' | 'udp';
  process?: string;
  state?: string;
  source?: string;
}

export interface ScanResult {
  ports: PortInfo[];
  timestamp: Date;
  platform: string;
}

export interface TunnelInfo {
  port: number;
  url: string;
  createdAt: string;
}

export interface RequestLog {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  statusCode: number;
  duration: number;
  requestHeaders: Record<string, string | string[] | undefined>;
  requestBody: string | null;
  responseBody: string | null;
}
