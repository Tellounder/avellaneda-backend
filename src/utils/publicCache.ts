import { buildRedisKey, getRedisCommandClient } from '../lib/redis';

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

const now = () => Date.now();

export const getCachedValue = <T>(key: string): T | null => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now()) {
    cache.delete(key);
    return null;
  }
  return entry.value as T;
};

export const setCachedValue = <T>(key: string, value: T, ttlMs: number) => {
  cache.set(key, { value, expiresAt: now() + ttlMs });
};

export const getOrSetCache = async <T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>
): Promise<T> => {
  const cached = getCachedValue<T>(key);
  if (cached !== null) return cached;

  const redisCached = await getRedisCachedValue<T>(key);
  if (redisCached !== null) {
    setCachedValue(key, redisCached, ttlMs);
    return redisCached;
  }

  const existing = inflight.get(key);
  if (existing) return (await existing) as T;
  const promise = loader()
    .then((value) => {
      setCachedValue(key, value, ttlMs);
      void setRedisCachedValue(key, value, ttlMs);
      inflight.delete(key);
      return value;
    })
    .catch((error) => {
      inflight.delete(key);
      throw error;
    });
  inflight.set(key, promise);
  return (await promise) as T;
};

export const invalidateCachePrefix = (prefix: string) => {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
};

const getRedisCachedValue = async <T>(key: string): Promise<T | null> => {
  const redis = getRedisCommandClient();
  if (!redis) return null;
  const redisKey = buildRedisKey('public-cache', key);
  try {
    const raw = await redis.get(redisKey);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[public-cache] Redis read fallback a memoria: ${message}`);
    return null;
  }
};

const setRedisCachedValue = async <T>(key: string, value: T, ttlMs: number) => {
  const redis = getRedisCommandClient();
  if (!redis) return;
  const redisKey = buildRedisKey('public-cache', key);
  try {
    await redis.set(redisKey, JSON.stringify(value), 'PX', ttlMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[public-cache] Redis write omitido: ${message}`);
  }
};
