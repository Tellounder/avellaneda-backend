import { Request, Response, NextFunction } from 'express';
import { buildRedisKey, getRedisCommandClient } from '../lib/redis';

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

  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET') return next();
    const key = getClientKey(req);
    const result = await consumeBucket({
      key: buildRedisKey('rate-limit', key),
      memoryStore: buckets,
      windowMs,
      maxRequests,
    });

    res.setHeader('X-RateLimit-Store', result.store);
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    if (!result.allowed) {
      if (result.retryAfterSeconds > 0) {
        res.setHeader('Retry-After', String(result.retryAfterSeconds));
      }
      return res.status(429).json({ message: 'Demasiadas solicitudes. Intenta de nuevo en unos segundos.' });
    }

    return next();
  };
};

const selfRegisterBuckets = new Map<string, Bucket>();

export const selfRegisterRateLimit = () => {
  const windowMs = Number(process.env.SELF_REGISTER_RATE_LIMIT_WINDOW_MS || 3_600_000);
  const maxRequests = Number(process.env.SELF_REGISTER_RATE_LIMIT_MAX || 10);

  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST') return next();
    const key = `self-register:${getClientKey(req)}`;
    const result = await consumeBucket({
      key: buildRedisKey(key),
      memoryStore: selfRegisterBuckets,
      windowMs,
      maxRequests,
    });

    res.setHeader('X-RateLimit-Store', result.store);
    if (!result.allowed) {
      if (result.retryAfterSeconds > 0) {
        res.setHeader('Retry-After', String(result.retryAfterSeconds));
      }
      return res.status(429).json({
        message: 'Demasiados registros desde esta red. Intenta nuevamente mas tarde.',
      });
    }

    return next();
  };
};

type ConsumeBucketParams = {
  key: string;
  memoryStore: Map<string, Bucket>;
  windowMs: number;
  maxRequests: number;
};

type ConsumeBucketResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  store: 'redis' | 'memory';
};

const toRetrySeconds = (ttlMs: number, fallbackMs: number) =>
  Math.max(1, Math.ceil((ttlMs > 0 ? ttlMs : fallbackMs) / 1000));

const consumeMemoryBucket = ({
  key,
  memoryStore,
  windowMs,
  maxRequests,
}: ConsumeBucketParams): ConsumeBucketResult => {
  const now = Date.now();
  const bucket = memoryStore.get(key);

  if (!bucket || bucket.resetAt <= now) {
    memoryStore.set(key, { count: 1, resetAt: now + windowMs });
    return {
      allowed: true,
      remaining: Math.max(maxRequests - 1, 0),
      retryAfterSeconds: 0,
      store: 'memory',
    };
  }

  bucket.count += 1;
  if (bucket.count > maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: toRetrySeconds(bucket.resetAt - now, windowMs),
      store: 'memory',
    };
  }

  return {
    allowed: true,
    remaining: Math.max(maxRequests - bucket.count, 0),
    retryAfterSeconds: 0,
    store: 'memory',
  };
};

const consumeRedisBucket = async ({
  key,
  windowMs,
  maxRequests,
}: ConsumeBucketParams): Promise<ConsumeBucketResult | null> => {
  const redis = getRedisCommandClient();
  if (!redis) return null;

  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.pexpire(key, windowMs);
    }
    let ttlMs = await redis.pttl(key);
    if (ttlMs < 0) {
      await redis.pexpire(key, windowMs);
      ttlMs = windowMs;
    }

    if (count > maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: toRetrySeconds(ttlMs, windowMs),
        store: 'redis',
      };
    }

    return {
      allowed: true,
      remaining: Math.max(maxRequests - count, 0),
      retryAfterSeconds: 0,
      store: 'redis',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[rate-limit] Redis no disponible, fallback a memoria: ${message}`);
    return null;
  }
};

const consumeBucket = async (params: ConsumeBucketParams): Promise<ConsumeBucketResult> => {
  const redisResult = await consumeRedisBucket(params);
  if (redisResult) return redisResult;
  return consumeMemoryBucket(params);
};
