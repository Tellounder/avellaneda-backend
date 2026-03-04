import { Request, Response, NextFunction } from 'express';
import { buildRedisKey, getRedisCommandClient } from '../lib/redis';

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

const getClientKey = (req: Request) => {
  // Express ya resuelve la IP real con trust proxy.
  const ip = typeof req.ip === 'string' ? req.ip.trim() : '';
  if (ip) return ip;
  return req.socket.remoteAddress || 'unknown';
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
const selfRegisterIpBuckets = new Map<string, Bucket>();

const ARGENTINA_COUNTRY_CODE = '54';
const ARGENTINA_TRUNK_PREFIX = '0';
const ARGENTINA_MOBILE_PREFIX = '9';
const ARGENTINA_LOCAL_MOBILE_TOKEN = '15';

const normalizeEmailKey = (value: unknown) => String(value || '').trim().toLowerCase();

const removeLocalMobileToken = (nationalNumber: string) => {
  for (let areaLength = 2; areaLength <= 4; areaLength += 1) {
    if (nationalNumber.length <= areaLength + 2) continue;
    if (nationalNumber.slice(areaLength, areaLength + 2) !== ARGENTINA_LOCAL_MOBILE_TOKEN) continue;
    const candidate = `${nationalNumber.slice(0, areaLength)}${nationalNumber.slice(areaLength + 2)}`;
    if (/^\d{10,11}$/.test(candidate)) {
      return candidate;
    }
  }
  return nationalNumber;
};

const normalizeWhatsappKey = (value: unknown) => {
  let digits = String(value || '').trim().replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.startsWith(ARGENTINA_COUNTRY_CODE)) {
    digits = digits.slice(ARGENTINA_COUNTRY_CODE.length);
  }
  if (digits.startsWith(ARGENTINA_MOBILE_PREFIX) && digits.length >= 11) {
    digits = digits.slice(1);
  }
  if (digits.startsWith(ARGENTINA_TRUNK_PREFIX)) {
    digits = digits.slice(1);
  }
  digits = removeLocalMobileToken(digits);
  if (!/^\d{10,11}$/.test(digits)) return '';
  return `549${digits}`;
};

const resolveSelfRegisterIdentity = (req: Request) => {
  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
  const email = normalizeEmailKey(body.email);
  const whatsapp = normalizeWhatsappKey(body.whatsapp);
  if (email) return `email:${email}`;
  if (whatsapp) return `wa:${whatsapp}`;
  return 'anonymous';
};

export const selfRegisterRateLimit = () => {
  const windowMs = Number(process.env.SELF_REGISTER_RATE_LIMIT_WINDOW_MS || 3_600_000);
  const maxRequests = Number(process.env.SELF_REGISTER_RATE_LIMIT_MAX || 10);
  const maxRequestsByIp = Number(process.env.SELF_REGISTER_RATE_LIMIT_IP_MAX || 80);
  const enabledRaw = String(process.env.SELF_REGISTER_RATE_LIMIT_ENABLED ?? 'true')
    .trim()
    .toLowerCase();
  const isEnabled = !['0', 'false', 'off', 'no'].includes(enabledRaw);

  return async (req: Request, res: Response, next: NextFunction) => {
    if (!isEnabled) return next();
    if (req.method !== 'POST') return next();
    const clientKey = getClientKey(req);
    const identityKey = resolveSelfRegisterIdentity(req);

    // Guardrail amplio por red para evitar flood masivo.
    const ipResult = await consumeBucket({
      key: buildRedisKey('self-register-ip', clientKey),
      memoryStore: selfRegisterIpBuckets,
      windowMs,
      maxRequests: maxRequestsByIp,
    });

    res.setHeader('X-RateLimit-Store', ipResult.store);
    if (!ipResult.allowed) {
      if (ipResult.retryAfterSeconds > 0) {
        res.setHeader('Retry-After', String(ipResult.retryAfterSeconds));
      }
      return res.status(429).json({
        message: 'Demasiados registros desde esta red. Intenta nuevamente mas tarde.',
      });
    }

    // Límite fino por identidad (email/WhatsApp) dentro de la red.
    const result = await consumeBucket({
      key: buildRedisKey('self-register', clientKey, identityKey),
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
        message: 'Demasiados intentos para este email o WhatsApp. Intenta nuevamente mas tarde.',
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
