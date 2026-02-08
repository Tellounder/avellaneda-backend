import crypto from 'crypto';
import fs from 'fs';
import fsPromises from 'fs/promises';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { ReelStatus, ReelType } from '@prisma/client';
import prisma from '../../prisma/client';
import { processVideoFromPath } from '../services/reelsMedia.service';

const BATCH_SIZE = Math.max(1, Number(process.env.REEL_WORKER_BATCH || 3));
const INTERVAL_MS = Math.max(15_000, Number(process.env.REEL_WORKER_INTERVAL_MS || 60_000));
const MAX_REDIRECTS = 3;

const createTempDir = async () => {
  const base = path.join(os.tmpdir(), 'avellaneda-reels-worker');
  await fsPromises.mkdir(base, { recursive: true });
  return fsPromises.mkdtemp(path.join(base, 'job-'));
};

const downloadToFile = async (url: string, destPath: string, redirects = 0): Promise<void> => {
  const client = url.startsWith('https') ? https : http;
  await new Promise<void>((resolve, reject) => {
    const req = client.get(url, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error('Demasiadas redirecciones al descargar video.'));
          return;
        }
        const nextUrl = new URL(res.headers.location, url).toString();
        downloadToFile(nextUrl, destPath, redirects + 1).then(resolve).catch(reject);
        return;
      }
      if (status >= 400) {
        res.resume();
        reject(new Error(`No se pudo descargar video (HTTP ${status}).`));
        return;
      }

      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => fileStream.close(() => resolve()));
      fileStream.on('error', (error) => reject(error));
    });
    req.on('error', reject);
  });
};

const cleanupDir = async (dir: string) => {
  await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
};

const claimReel = async (reelId: string, jobId: string) => {
  const updated = await prisma.reel.updateMany({
    where: { id: reelId, processingJobId: null },
    data: { processingJobId: jobId },
  });
  return updated.count === 1;
};

const processReel = async (reel: { id: string; shopId: string; videoUrl: string | null; editorState?: any }) => {
  if (!reel.videoUrl) return;
  const jobId = crypto.randomUUID();
  const claimed = await claimReel(reel.id, jobId);
  if (!claimed) return;

  const tempDir = await createTempDir();
  const sourcePath = path.join(tempDir, 'source-video');
  try {
    await downloadToFile(reel.videoUrl, sourcePath);
    const { videoUrl, thumbnailUrl } = await processVideoFromPath(
      reel.shopId,
      sourcePath,
      tempDir,
      reel.editorState
    );
    const nextEditorState =
      reel.editorState && typeof reel.editorState === 'object'
        ? { ...reel.editorState, rendered: true, renderedAt: new Date().toISOString() }
        : reel.editorState;
    await prisma.reel.update({
      where: { id: reel.id },
      data: {
        videoUrl,
        thumbnailUrl,
        status: ReelStatus.ACTIVE,
        hidden: false,
        processingJobId: null,
        editorState: nextEditorState,
      },
    });
    console.log(`[reels-worker] Procesado OK: ${reel.id}`);
  } catch (error) {
    console.error(`[reels-worker] Error procesando reel ${reel.id}:`, error);
    await prisma.reel.update({
      where: { id: reel.id },
      data: { processingJobId: null },
    });
  } finally {
    await cleanupDir(tempDir);
  }
};

const runOnce = async () => {
  const now = new Date();
    const reels = await prisma.reel.findMany({
      where: {
        type: ReelType.VIDEO,
        status: ReelStatus.PROCESSING,
        expiresAt: { gte: now },
        videoUrl: { not: null },
        processingJobId: null,
      },
    orderBy: { createdAt: 'desc' },
    take: BATCH_SIZE,
    select: {
      id: true,
      shopId: true,
      videoUrl: true,
      editorState: true,
    },
  });

  for (const reel of reels) {
    await processReel(reel);
  }
};

const start = async () => {
  console.log(`[reels-worker] Iniciado. batch=${BATCH_SIZE} intervalo=${INTERVAL_MS}ms`);
  await runOnce();
  setInterval(() => {
    runOnce().catch((error) => console.error('[reels-worker] Error en ciclo:', error));
  }, INTERVAL_MS);
};

start().catch((error) => {
  console.error('[reels-worker] Error fatal:', error);
  process.exit(1);
});
