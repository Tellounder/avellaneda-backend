import Redis from 'ioredis';

const REDIS_URL = String(process.env.REDIS_URL || '').trim();
const REDIS_KEY_PREFIX = String(process.env.REDIS_KEY_PREFIX || 'avvivo')
  .trim()
  .replace(/:+$/g, '');
const REDIS_TLS = String(process.env.REDIS_TLS || '')
  .trim()
  .toLowerCase();

const parseBool = (value: string) =>
  value === 'true' || value === '1' || value === 'yes' || value === 'on';

const USE_TLS = parseBool(REDIS_TLS);

let commandClient: Redis | null = null;

const wireClientEvents = (client: Redis, label: string) => {
  client.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[redis:${label}] error: ${message}`);
  });
};

const buildClient = (label: string) => {
  if (!REDIS_URL) return null;
  const client = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    ...(USE_TLS ? { tls: {} } : {}),
  });
  wireClientEvents(client, label);
  return client;
};

export const isRedisConfigured = () => Boolean(REDIS_URL);

export const buildRedisKey = (...parts: Array<string | number>) => {
  const normalized = parts
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(':');
  return REDIS_KEY_PREFIX ? `${REDIS_KEY_PREFIX}:${normalized}` : normalized;
};

export const getRedisCommandClient = () => {
  if (!isRedisConfigured()) return null;
  if (!commandClient) {
    commandClient = buildClient('command');
  }
  return commandClient;
};

export const createRedisPubSubClient = (label: string) => buildClient(label);

export const getRedisRuntime = () => ({
  configured: isRedisConfigured(),
  keyPrefix: REDIS_KEY_PREFIX || null,
  tls: USE_TLS,
  commandStatus: commandClient?.status || 'idle',
});
