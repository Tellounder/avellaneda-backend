import crypto from 'crypto';
import fs from 'fs';
import fsPromises from 'fs/promises';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { ReelStatus, ReelType } from '@prisma/client';
import prisma from '../../prisma/client';
import { processPhotoFromPath, processVideoFromPath } from '../services/reelsMedia.service';

const BATCH_SIZE = Math.max(1, Number(process.env.REEL_WORKER_BATCH || 3));
const INTERVAL_MS = Math.max(15_000, Number(process.env.REEL_WORKER_INTERVAL_MS || 60_000));
const MAX_REDIRECTS = 3;

const normalizeEditorState = (value: any) => {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
};

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

const buildEditorStateWithProgress = (base: any, progress: number) => {
  const normalized =
    base && typeof base === 'object'
      ? { ...base }
      : { version: 1, mediaTransforms: [], stickers: [] };
  normalized.progress = progress;
  return normalized;
};

const getExtensionFromUrl = (url: string) => {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname);
    if (ext && ext.length <= 6) return ext;
  } catch {
    // ignore parsing errors
  }
  return '';
};

const processReel = async (reel: {
  id: string;
  shopId: string;
  type: ReelType;
  videoUrl: string | null;
  photoUrls: string[];
  editorState?: any;
}) => {
  if (reel.type === ReelType.VIDEO && !reel.videoUrl) return;
  if (reel.type === ReelType.PHOTO_SET && (!reel.photoUrls || reel.photoUrls.length === 0)) return;
  const jobId = crypto.randomUUID();
  const claimed = await claimReel(reel.id, jobId);
  if (!claimed) return;

  const tempDir = await createTempDir();
  const progressState = { last: -1, lastAt: 0 };
  const baseEditorState = reel.editorState && typeof reel.editorState === 'object' ? reel.editorState : null;

  const reportProgress = async (value: number) => {
    const next = Math.max(0, Math.min(100, Math.round(value)));
    const now = Date.now();
    if (next === progressState.last) return;
    if (next < 100 && next - progressState.last < 4 && now - progressState.lastAt < 1500) {
      return;
    }
    progressState.last = next;
    progressState.lastAt = now;
    const editorState = buildEditorStateWithProgress(baseEditorState, next);
    await prisma.reel.updateMany({
      where: { id: reel.id, processingJobId: jobId },
      data: { editorState },
    });
  };
  try {
    let nextVideoUrl: string | null = null;
    let nextThumbUrl: string | null = null;
    let nextPhotoUrls: string[] = [];

    await reportProgress(0);

    if (reel.type === ReelType.VIDEO && reel.videoUrl) {
      const sourcePath = path.join(tempDir, 'source-video');
      await downloadToFile(reel.videoUrl, sourcePath);
      const stat = await fsPromises.stat(sourcePath);
      if (!stat.size) {
        throw new Error(`Archivo descargado vacio (video): ${sourcePath}`);
      }
      const { videoUrl, thumbnailUrl } = await processVideoFromPath(
        reel.shopId,
        sourcePath,
        tempDir,
        reel.editorState,
        (percent) => {
          void reportProgress(percent);
        }
      );
      nextVideoUrl = videoUrl;
      nextThumbUrl = thumbnailUrl;
    }

    if (reel.type === ReelType.PHOTO_SET) {
      const totalPhotos = Math.max(1, reel.photoUrls.length);
      for (let index = 0; index < reel.photoUrls.length; index += 1) {
        const url = reel.photoUrls[index];
        if (!url) continue;
        const ext = getExtensionFromUrl(url) || '.jpg';
        const sourcePath = path.join(tempDir, `source-photo-${index}${ext}`);
        await downloadToFile(url, sourcePath);
        const stat = await fsPromises.stat(sourcePath);
        if (!stat.size) {
          throw new Error(`Archivo descargado vacio (foto ${index}): ${sourcePath}`);
        }
        const processedUrl = await processPhotoFromPath(
          reel.shopId,
          sourcePath,
          tempDir,
          reel.editorState,
          index
        );
        nextPhotoUrls.push(processedUrl);
        await reportProgress(((index + 1) / totalPhotos) * 100);
      }
      nextThumbUrl = nextPhotoUrls[0] || null;
    }

    const nextEditorState =
      reel.editorState && typeof reel.editorState === 'object'
        ? { ...reel.editorState, rendered: true, renderedAt: new Date().toISOString(), progress: 100 }
        : buildEditorStateWithProgress(null, 100);
    await prisma.reel.update({
      where: { id: reel.id },
      data: {
        videoUrl: nextVideoUrl,
        photoUrls: nextPhotoUrls,
        thumbnailUrl: nextThumbUrl,
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
      status: { in: [ReelStatus.PROCESSING, ReelStatus.ACTIVE] },
      expiresAt: { gte: now },
      processingJobId: null,
    },
    orderBy: { createdAt: 'desc' },
    take: BATCH_SIZE,
    select: {
      id: true,
      shopId: true,
      type: true,
      videoUrl: true,
      photoUrls: true,
      editorState: true,
      status: true,
    },
  });

  const candidates = reels
    .map((reel) => ({ ...reel, editorState: normalizeEditorState(reel.editorState) }))
    .filter((reel) => reel.status === ReelStatus.PROCESSING || (reel.editorState && reel.editorState.rendered !== true));

  for (const reel of candidates) {
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



