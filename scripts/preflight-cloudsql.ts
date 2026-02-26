import 'dotenv/config';
import prisma from '../prisma/client';
import { getRedisCommandClient, isRedisConfigured } from '../src/lib/redis';

const REQUIRED_ENV = ['DATABASE_URL'];
const RECOMMENDED_ENV = [
  'DIRECT_URL',
  'APP_URL',
  'PUBLIC_SHARE_URL',
  'RESEND_API_KEY',
  'RESEND_FROM',
  'MP_ACCESS_TOKEN',
];

const maskValue = (value: string) => {
  if (!value) return '<empty>';
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
};

const main = async () => {
  console.log('== Preflight Cloud SQL / Runtime ==');

  const missingRequired = REQUIRED_ENV.filter((key) => !String(process.env[key] || '').trim());
  const missingRecommended = RECOMMENDED_ENV.filter((key) => !String(process.env[key] || '').trim());

  if (missingRequired.length > 0) {
    console.error(`Faltan variables obligatorias: ${missingRequired.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('Variables obligatorias: OK');
  }

  if (missingRecommended.length > 0) {
    console.warn(`Variables recomendadas faltantes: ${missingRecommended.join(', ')}`);
  } else {
    console.log('Variables recomendadas: OK');
  }

  const dbUrl = String(process.env.DATABASE_URL || '');
  const directUrl = String(process.env.DIRECT_URL || '');
  console.log(`DATABASE_URL=${maskValue(dbUrl)}`);
  console.log(`DIRECT_URL=${maskValue(directUrl)}`);

  let dbOk = false;
  const startedAt = Date.now();
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    dbOk = true;
    console.log(`DB connectivity: OK (${Date.now() - startedAt}ms)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`DB connectivity: ERROR (${message})`);
    process.exitCode = 1;
  }

  if (isRedisConfigured()) {
    const redis = getRedisCommandClient();
    if (redis) {
      try {
        const pong = await redis.ping();
        console.log(`Redis connectivity: OK (${pong})`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Redis connectivity: ERROR (${message})`);
        process.exitCode = 1;
      } finally {
        await redis.quit().catch(() => undefined);
      }
    }
  } else {
    console.log('Redis connectivity: SKIP (REDIS_URL no configurado)');
  }

  if (dbOk && process.exitCode !== 1) {
    console.log('Preflight final: OK');
  } else {
    console.log('Preflight final: ERROR');
  }
};

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Preflight fallo: ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
