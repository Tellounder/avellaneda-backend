import 'dotenv/config';
import http from 'http';
import { getReelsWorkerRuntime, startReelsWorker } from './reelsWorker';

const PORT = Number(process.env.PORT || 8080);

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400);
    res.end('bad request');
    return;
  }

  if (req.url === '/' || req.url === '/healthz' || req.url === '/readyz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'reels-worker' }));
    return;
  }

  if (req.url === '/worker/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...getReelsWorkerRuntime() }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ message: 'not_found' }));
});

const shutdown = (signal: string) => {
  console.log(`[reels-worker-service] ${signal} recibido. Cerrando servidor HTTP...`);
  server.close(() => process.exit(0));
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (error) => {
  console.error('[reels-worker-service] unhandledRejection', error);
});
process.on('uncaughtException', (error) => {
  console.error('[reels-worker-service] uncaughtException', error);
});

server.listen(PORT, async () => {
  console.log(`[reels-worker-service] HTTP escuchando en :${PORT}`);
  try {
    await startReelsWorker();
  } catch (error) {
    console.error('[reels-worker-service] Error fatal iniciando reels worker:', error);
    process.exit(1);
  }
});

