export interface Config {
  port: number;
  host: string;
  token: string | null;
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || 'localhost',
    token: process.env.PORTS_TOKEN || null,
  };
}

export const config = loadConfig();
