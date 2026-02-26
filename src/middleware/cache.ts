import { Request, Response, NextFunction } from 'express';
import { buildRedisKey, getRedisCommandClient } from '../lib/redis';

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
  async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET') return next();
    if (publicOnly && req.auth) return next();
    if (shouldCache && !shouldCache(req)) return next();

    const cacheKey = buildCacheKey(req, keyPrefix);
    const redisKey = buildRedisKey('http-cache', cacheKey);
    const redisCached = await readRedisCache(redisKey);
    if (redisCached) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Cache-Store', 'redis');
      if (redisCached.contentType) {
        res.setHeader('Content-Type', redisCached.contentType);
      }
      if (redisCached.isJson) {
        return res.status(redisCached.status).json(redisCached.body);
      }
      return res.status(redisCached.status).send(redisCached.body);
    }

    const cached = cacheStore.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Cache-Store', 'memory');
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
      const nextEntry = {
        expiresAt: now + ttlMs,
        status: res.statusCode,
        body: responseBody,
        isJson,
        contentType: res.getHeader('Content-Type')?.toString(),
      } satisfies CacheEntry;
      cacheStore.set(cacheKey, nextEntry);
      void writeRedisCache(redisKey, nextEntry, ttlMs);
    });

    res.setHeader('X-Cache', 'MISS');
    res.setHeader('X-Cache-Store', 'none');
    return next();
  };

type RedisCachePayload = Pick<CacheEntry, 'status' | 'body' | 'isJson' | 'contentType'>;

const readRedisCache = async (key: string): Promise<RedisCachePayload | null> => {
  const redis = getRedisCommandClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RedisCachePayload;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[cache] Redis read fallback a memoria: ${message}`);
    return null;
  }
};

const writeRedisCache = async (key: string, entry: CacheEntry, ttlMs: number) => {
  const redis = getRedisCommandClient();
  if (!redis) return;
  const payload: RedisCachePayload = {
    status: entry.status,
    body: entry.body,
    isJson: entry.isJson,
    contentType: entry.contentType,
  };
  try {
    await redis.set(key, JSON.stringify(payload), 'PX', ttlMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[cache] Redis write omitido: ${message}`);
  }
};
