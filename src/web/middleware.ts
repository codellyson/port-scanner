import { Request, Response, NextFunction } from 'express';

// Simple in-memory rate limiter
const requestCounts = new Map<string, { count: number; resetTime: number }>();

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
}

export function rateLimit(options: RateLimitOptions = { windowMs: 60000, maxRequests: 100 }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();

    const record = requestCounts.get(ip);

    if (!record || now > record.resetTime) {
      requestCounts.set(ip, { count: 1, resetTime: now + options.windowMs });
      return next();
    }

    if (record.count >= options.maxRequests) {
      res.status(429).json({
        success: false,
        error: 'Too many requests. Please try again later.',
      });
      return;
    }

    record.count++;
    next();
  };
}

// CORS middleware
export interface CorsOptions {
  origins: string[];
  methods: string[];
}

export function cors(options: CorsOptions = { origins: ['*'], methods: ['GET', 'POST', 'OPTIONS'] }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin || '*';

    if (options.origins.includes('*') || options.origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }

    res.setHeader('Access-Control-Allow-Methods', options.methods.join(', '));
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}

// Security headers middleware
export function securityHeaders() {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  };
}
