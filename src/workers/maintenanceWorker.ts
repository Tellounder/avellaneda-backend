import 'dotenv/config';
import { startSchedulers } from '../app/scheduler';
import { backfillQuotaWallets } from '../services/quota.service';

const BATCH_SIZE = Math.max(1, Number(process.env.QUOTA_WALLET_FIX_BATCH || 25));
const INTERVAL_MS = Math.max(60_000, Number(process.env.QUOTA_WALLET_FIX_INTERVAL_MS || 10 * 60_000));

const logFatal = (label: string) => (error: any) => {
  console.error(`[${label}]`, error);
};

process.on('unhandledRejection', logFatal('unhandledRejection'));
process.on('uncaughtException', logFatal('uncaughtException'));

const runOnce = async () => {
  const result = await backfillQuotaWallets({ batchSize: BATCH_SIZE });
  if (result.scanned > 0) {
    console.log(`[maintenance-worker] backfill: scanned=${result.scanned} created=${result.created}`);
  }
};

const start = async () => {
  console.log(`[maintenance-worker] Iniciado. batch=${BATCH_SIZE} intervalo=${INTERVAL_MS}ms`);
  startSchedulers({ forceEnableStreams: true });
  await runOnce();
  setInterval(() => {
    runOnce().catch((error) => console.error('[maintenance-worker] Error en ciclo:', error));
  }, INTERVAL_MS);
};

start().catch((error) => {
  console.error('[maintenance-worker] Error fatal:', error);
  process.exit(1);
});
