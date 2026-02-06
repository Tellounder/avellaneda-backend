import { Request, Response, NextFunction } from 'express';

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

const getClientKey = (req: Request) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
};

export const rateLimit = () => {
  const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 10_000);
  const maxRequests = Number(process.env.RATE_LIMIT_MAX || 80);

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET') return next();
    const key = getClientKey(req);
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      res.setHeader('X-RateLimit-Remaining', String(maxRequests - 1));
      return next();
    }

    bucket.count += 1;
    if (bucket.count > maxRequests) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ message: 'Demasiadas solicitudes. Intenta de nuevo en unos segundos.' });
    }

    res.setHeader('X-RateLimit-Remaining', String(Math.max(maxRequests - bucket.count, 0)));
    return next();
  };
};
