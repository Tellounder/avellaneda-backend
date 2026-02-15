import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import fsPromises from 'fs/promises';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { ReelStatus, ReelType } from '@prisma/client';
import prisma from '../../prisma/client';
import { processPhotoFromPath, processVideoFromPath } from '../services/reelsMedia.service';

const BATCH_SIZE = Math.max(1, Number(process.env.REEL_WORKER_BATCH || 3));
const INTERVAL_MS = Math.max(15_000, Number(process.env.REEL_WORKER_INTERVAL_MS || 60_000));
const DOWNLOAD_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.REEL_WORKER_DOWNLOAD_TIMEOUT_MS || 180_000)
);
const PROCESS_TIMEOUT_MS = Math.max(
  120_000,
  Number(process.env.REEL_WORKER_PROCESS_TIMEOUT_MS || 900_000)
);
const LOCK_TTL_ENV_MS = Math.max(
  120_000,
  Number(process.env.REEL_WORKER_LOCK_TTL_MS || 10 * 60_000)
);
const LOCK_TTL_MS = Math.max(LOCK_TTL_ENV_MS, PROCESS_TIMEOUT_MS + 60_000);
const MAX_RETRIES = Math.max(1, Number(process.env.REEL_WORKER_MAX_RETRIES || 5));
const MAX_REDIRECTS = 3;
let cycleInProgress = false;

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

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timeoutHandle: NodeJS.Timeout | null = null;
  return new Promise<T>((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} excedio el timeout (${timeoutMs}ms).`));
    }, timeoutMs);
    promise
      .then((result) => resolve(result))
      .catch((error) => reject(error))
      .finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      });
  });
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
      pipeline(res, fileStream).then(resolve).catch(reject);
    });
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error(`Descarga timeout (${DOWNLOAD_TIMEOUT_MS}ms)`));
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

const buildEditorStateWithMeta = (base: any, patch: Record<string, any>) => {
  const normalized =
    base && typeof base === 'object'
      ? { ...base }
      : { version: 1, mediaTransforms: [], stickers: [] };
  return { ...normalized, ...patch };
};

const readLockTimestamp = (editorState: any, createdAt: Date) => {
  const fromState = editorState?.workerLockedAt || editorState?.workerHeartbeatAt || null;
  if (typeof fromState === 'string') {
    const parsed = Date.parse(fromState);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return createdAt.getTime();
};

const releaseStaleLocks = async () => {
  const now = Date.now();
  const locked = await prisma.reel.findMany({
    where: {
      status: ReelStatus.PROCESSING,
      processingJobId: { not: null },
    },
    take: Math.max(20, BATCH_SIZE * 10),
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      processingJobId: true,
      editorState: true,
      createdAt: true,
    },
  });

  for (const reel of locked) {
    if (!reel.processingJobId) continue;
    const editorState = normalizeEditorState(reel.editorState);
    const lockTs = readLockTimestamp(editorState, reel.createdAt);
    const ageMs = now - lockTs;
    if (ageMs <= LOCK_TTL_MS) continue;
    const currentRetries = Number(editorState?.processingRetries || 0);
    const retries = currentRetries + 1;

    if (retries >= MAX_RETRIES) {
      const failedEditorState = buildEditorStateWithMeta(editorState, {
        workerStage: 'FAILED_PERMANENT',
        workerFailedAt: new Date().toISOString(),
        workerLastJobId: reel.processingJobId,
        processingRetries: retries,
        workerError: `Lock vencido (${ageMs}ms). Maximo de reintentos alcanzado (${retries}/${MAX_RETRIES}).`,
      });
      const finalized = await prisma.reel.updateMany({
        where: { id: reel.id, processingJobId: reel.processingJobId },
        data: {
          status: ReelStatus.HIDDEN,
          hidden: true,
          processingJobId: null,
          editorState: failedEditorState,
        },
      });
      if (finalized.count > 0) {
        console.error(
          `[reels-worker] Reel ${reel.id} marcado como FAILED_PERMANENT por lock vencido. job=${reel.processingJobId} retries=${retries}/${MAX_RETRIES}`
        );
      }
      continue;
    }

    const nextEditorState = buildEditorStateWithMeta(editorState, {
      workerStage: 'REQUEUED',
      workerRequeuedAt: new Date().toISOString(),
      workerLastJobId: reel.processingJobId,
      processingRetries: retries,
      workerError: `Lock vencido (${ageMs}ms). Se reencola intento ${retries}/${MAX_RETRIES}.`,
    });

    const released = await prisma.reel.updateMany({
      where: { id: reel.id, processingJobId: reel.processingJobId },
      data: {
        processingJobId: null,
        editorState: nextEditorState,
      },
    });

    if (released.count > 0) {
      console.warn(
        `[reels-worker] Lock vencido liberado: ${reel.id} job=${reel.processingJobId} ageMs=${ageMs}`
      );
    }
  }
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
  const normalizedInputState = normalizeEditorState(reel.editorState);
  const existingRetries = Number(normalizedInputState?.processingRetries || 0);
  if (existingRetries >= MAX_RETRIES) {
    const failedState = buildEditorStateWithMeta(normalizedInputState, {
      workerStage: 'FAILED_PERMANENT',
      workerFailedAt: new Date().toISOString(),
      workerError: `Maximo de reintentos alcanzado (${existingRetries}/${MAX_RETRIES}).`,
    });
    await prisma.reel.update({
      where: { id: reel.id },
      data: {
        status: ReelStatus.HIDDEN,
        hidden: true,
        processingJobId: null,
        editorState: failedState,
      },
    });
    console.error(
      `[reels-worker] Reel ${reel.id} ocultado por max retries (${existingRetries}/${MAX_RETRIES}).`
    );
    return;
  }

  const jobId = crypto.randomUUID();
  const claimed = await claimReel(reel.id, jobId);
  if (!claimed) return;
  const baseEditorState =
    normalizedInputState && typeof normalizedInputState === 'object' ? normalizedInputState : null;
  const claimedAtIso = new Date().toISOString();
  await prisma.reel.updateMany({
    where: { id: reel.id, processingJobId: jobId },
    data: {
      editorState: buildEditorStateWithMeta(baseEditorState, {
        workerStage: 'CLAIMED',
        workerJobId: jobId,
        workerLockedAt: claimedAtIso,
        processingRetries: existingRetries,
      }),
    },
  });
  console.log(`[reels-worker] Claim OK reel=${reel.id} job=${jobId} retries=${existingRetries}`);

  let tempDir = '';
  const progressState = { last: -1, lastAt: 0 };

  const reportProgress = async (value: number, stage = 'PROCESSING') => {
    const next = Math.max(0, Math.min(100, Math.round(value)));
    const now = Date.now();
    if (next === progressState.last) return;
    if (next < 100 && next - progressState.last < 4 && now - progressState.lastAt < 1500) {
      return;
    }
    progressState.last = next;
    progressState.lastAt = now;
    const editorState = buildEditorStateWithMeta(buildEditorStateWithProgress(baseEditorState, next), {
      workerStage: stage,
      workerJobId: jobId,
      workerLockedAt: new Date().toISOString(),
    });
    await prisma.reel.updateMany({
      where: { id: reel.id, processingJobId: jobId },
      data: { editorState },
    });
  };
  try {
    tempDir = await createTempDir();
    let nextVideoUrl: string | null = null;
    let nextThumbUrl: string | null = null;
    let nextPhotoUrls: string[] = [];

    await reportProgress(0, 'START');

    if (reel.type === ReelType.VIDEO && reel.videoUrl) {
      const sourcePath = path.join(tempDir, 'source.mp4');
      await withTimeout(
        downloadToFile(reel.videoUrl, sourcePath),
        DOWNLOAD_TIMEOUT_MS,
        'Descarga de video'
      );
      const stat = await fsPromises.stat(sourcePath);
      if (!stat.size) {
        throw new Error(`Archivo descargado vacio (video): ${sourcePath}`);
      }
      const { videoUrl, thumbnailUrl } = await withTimeout(
        processVideoFromPath(
          reel.shopId,
          sourcePath,
          tempDir,
          reel.editorState,
          (percent) => {
            void reportProgress(percent, 'RENDER_VIDEO');
          }
        ),
        PROCESS_TIMEOUT_MS,
        'Render de video'
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
        await withTimeout(
          downloadToFile(url, sourcePath),
          DOWNLOAD_TIMEOUT_MS,
          `Descarga de foto ${index + 1}`
        );
        const stat = await fsPromises.stat(sourcePath);
        if (!stat.size) {
          throw new Error(`Archivo descargado vacio (foto ${index}): ${sourcePath}`);
        }
        const processedUrl = await withTimeout(
          processPhotoFromPath(reel.shopId, sourcePath, tempDir, reel.editorState, index),
          PROCESS_TIMEOUT_MS,
          `Render de foto ${index + 1}`
        );
        nextPhotoUrls.push(processedUrl);
        await reportProgress(((index + 1) / totalPhotos) * 100, 'RENDER_PHOTO_SET');
      }
      nextThumbUrl = nextPhotoUrls[0] || null;
    }

    const nextEditorState = buildEditorStateWithMeta(buildEditorStateWithProgress(baseEditorState, 100), {
      rendered: true,
      renderedAt: new Date().toISOString(),
      workerStage: 'DONE',
      workerJobId: jobId,
      workerLockedAt: new Date().toISOString(),
      workerError: null,
    });
    const activated = await prisma.reel.updateMany({
      where: { id: reel.id, processingJobId: jobId },
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
    if (activated.count > 0) {
      console.log(`[reels-worker] Procesado OK: ${reel.id}`);
    } else {
      console.warn(
        `[reels-worker] Reel ${reel.id} no pudo activarse porque perdio lock antes de confirmar (job=${jobId}).`
      );
    }
  } catch (error) {
    console.error(`[reels-worker] Error procesando reel ${reel.id}:`, error);
    const retries = Number(baseEditorState?.processingRetries || 0) + 1;
    const reachedMaxRetries = retries >= MAX_RETRIES;
    const message =
      error instanceof Error ? error.message.slice(0, 500) : 'Error no identificado en el worker.';
    const errorEditorState = buildEditorStateWithMeta(baseEditorState, {
      workerStage: reachedMaxRetries ? 'FAILED_PERMANENT' : 'ERROR',
      workerJobId: jobId,
      workerLockedAt: new Date().toISOString(),
      workerFailedAt: new Date().toISOString(),
      workerError: message,
      processingRetries: retries,
    });
    const released = await prisma.reel.updateMany({
      where: { id: reel.id, processingJobId: jobId },
      data: {
        ...(reachedMaxRetries ? { status: ReelStatus.HIDDEN, hidden: true } : {}),
        processingJobId: null,
        editorState: errorEditorState,
      },
    });
    if (released.count === 0) {
      await prisma.reel
        .update({
          where: { id: reel.id },
          data: {
            ...(reachedMaxRetries ? { status: ReelStatus.HIDDEN, hidden: true } : {}),
            processingJobId: null,
            editorState: errorEditorState,
          },
        })
        .catch(() => undefined);
    }
    if (reachedMaxRetries) {
      console.error(
        `[reels-worker] Reel ${reel.id} marcado como FAILED_PERMANENT tras error. retries=${retries}/${MAX_RETRIES}`
      );
    }
  } finally {
    if (tempDir) {
      await cleanupDir(tempDir);
    }
  }
};

const runOnce = async () => {
  await releaseStaleLocks();
  const now = new Date();
  const reels = await prisma.reel.findMany({
    where: {
      status: ReelStatus.PROCESSING,
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
    .filter((reel) => reel.status === ReelStatus.PROCESSING);

  for (const reel of candidates) {
    await processReel(reel);
  }
};

const runCycle = async () => {
  if (cycleInProgress) {
    return;
  }
  cycleInProgress = true;
  try {
    await runOnce();
  } finally {
    cycleInProgress = false;
  }
};

const start = async () => {
  if (!(process.env.NODE_OPTIONS || '').includes('max-old-space-size')) {
    console.warn(
      '[reels-worker] NODE_OPTIONS no define max-old-space-size. Recomendado: --max-old-space-size=512'
    );
  }
  console.log(
    `[reels-worker] Iniciado. batch=${BATCH_SIZE} intervalo=${INTERVAL_MS}ms downloadTimeout=${DOWNLOAD_TIMEOUT_MS}ms processTimeout=${PROCESS_TIMEOUT_MS}ms lockTtl=${LOCK_TTL_MS}ms(lockTtlEnv=${LOCK_TTL_ENV_MS}ms) maxRetries=${MAX_RETRIES}`
  );
  await runCycle();
  setInterval(() => {
    runCycle().catch((error) => console.error('[reels-worker] Error en ciclo:', error));
  }, INTERVAL_MS);
};

start().catch((error) => {
  console.error('[reels-worker] Error fatal:', error);
  process.exit(1);
});



