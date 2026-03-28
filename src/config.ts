export interface Config {
  port: number;
  host: string;
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || 'localhost',
  };
}

export const config = loadConfig();
