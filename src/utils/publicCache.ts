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
  const existing = inflight.get(key);
  if (existing) return (await existing) as T;
  const promise = loader()
    .then((value) => {
      setCachedValue(key, value, ttlMs);
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
