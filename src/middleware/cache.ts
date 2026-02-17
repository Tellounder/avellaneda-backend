import { Request, Response, NextFunction } from 'express';

type CacheEntry = {
  expiresAt: number;
  status: number;
  body: any;
  isJson: boolean;
  contentType?: string;
};

type CacheOptions = {
  ttlMs: number;
  keyPrefix?: string;
  publicOnly?: boolean;
  shouldCache?: (req: Request) => boolean;
};

const cacheStore = new Map<string, CacheEntry>();

const buildCacheKey = (req: Request, keyPrefix = '') => {
  const authKey = req.auth ? `:${req.auth.userType || 'auth'}:${req.auth.shopId || ''}` : ':public';
  return `${keyPrefix}${req.method}:${req.originalUrl}${authKey}`;
};

export const cacheMiddleware =
  ({ ttlMs, keyPrefix = '', publicOnly = true, shouldCache }: CacheOptions) =>
  (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET') return next();
    if (publicOnly && req.auth) return next();
    if (shouldCache && !shouldCache(req)) return next();

    const cacheKey = buildCacheKey(req, keyPrefix);
    const cached = cacheStore.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      res.setHeader('X-Cache', 'HIT');
      if (cached.contentType) {
        res.setHeader('Content-Type', cached.contentType);
      }
      if (cached.isJson) {
        return res.status(cached.status).json(cached.body);
      }
      return res.status(cached.status).send(cached.body);
    }

    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    let responseBody: any;
    let isJson = false;

    res.json = (body: any) => {
      responseBody = body;
      isJson = true;
      return originalJson(body);
    };

    res.send = (body: any) => {
      // When res.json() is used, Express internally calls res.send(stringifiedJson).
      // Keep the original JSON payload in cache, otherwise we may cache a string.
      if (!isJson) {
        responseBody = body;
      }
      return originalSend(body);
    };

    res.on('finish', () => {
      if (res.statusCode !== 200) return;
      if (responseBody === undefined) return;
      cacheStore.set(cacheKey, {
        expiresAt: now + ttlMs,
        status: res.statusCode,
        body: responseBody,
        isJson,
        contentType: res.getHeader('Content-Type')?.toString(),
      });
    });

    res.setHeader('X-Cache', 'MISS');
    return next();
  };
