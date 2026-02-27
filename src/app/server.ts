import 'dotenv/config';
import app from './app';
import { startSchedulers } from './scheduler';
import { startReelsWorker } from '../workers/reelsWorker';

const PORT = process.env.PORT || 3000;
const parseBool = (value?: string) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
};

const logFatal = (label: string) => (error: any) => {
  console.error(`[${label}]`, error);
};

process.on('unhandledRejection', logFatal('unhandledRejection'));
process.on('uncaughtException', logFatal('uncaughtException'));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (parseBool(process.env.RUN_SCHEDULERS_IN_API)) {
    startSchedulers();
  }
  const runReelsWorkerInApi = parseBool(process.env.RUN_REELS_WORKER_IN_API || 'true');
  if (runReelsWorkerInApi) {
    void startReelsWorker().catch((error) => {
      console.error('[reels-worker] Error fatal al iniciar desde API:', error);
    });
  } else {
    console.log('[reels-worker] deshabilitado en API por RUN_REELS_WORKER_IN_API=false');
  }
});
