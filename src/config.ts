export interface Config {
  port: number;
  host: string;
  demoMode: boolean;
  enableKillEndpoint: boolean;
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
  cors: {
    origins: string[];
  };
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || 'localhost',
    demoMode: parseBoolean(process.env.DEMO_MODE, false),
    enableKillEndpoint: parseBoolean(process.env.ENABLE_KILL_ENDPOINT, true),
    rateLimit: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
      maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
    },
    cors: {
      origins: (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()),
    },
  };
}

export const config = loadConfig();
