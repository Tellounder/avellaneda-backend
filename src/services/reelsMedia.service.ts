import { Storage } from '@google-cloud/storage';
import prisma from '../../prisma/client';
import { ReelStatus } from '@prisma/client';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import fsSync from 'fs';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
// `fluent-ffmpeg` does not ship typings in our runtime path.
const ffmpeg: any = require('fluent-ffmpeg');

const providerRaw = String(process.env.STORAGE_PROVIDER || '').trim().toLowerCase();
const gcsReelsBucket = String(process.env.GCS_BUCKET || '').trim();
const gcsPublicBaseUrl = String(process.env.GCS_PUBLIC_BASE_URL || '')
  .trim()
  .replace(/\/+$/g, '');
const reelsBucket = gcsReelsBucket;
const TARGET_WIDTH = 720;
const TARGET_HEIGHT = 1280;
const MANROPE_FONT_PATH = path.resolve(process.cwd(), 'assets', 'fonts', 'Manrope.ttf');
const FFMPEG_THREADS = Math.max(
  1,
  Math.min(2, Number(process.env.REEL_FFMPEG_THREADS || 1))
);
const FFMPEG_TIMEOUT_MS = Math.max(
  120_000,
  Number(process.env.REEL_FFMPEG_TIMEOUT_MS || 900_000)
);
const MAX_SOURCE_VIDEO_MB = Math.max(
  10,
  Number(process.env.REEL_MAX_SOURCE_VIDEO_MB || 120)
);
let manropeFontBase64: string | null = null;
let manropePathLogged = false;

const resolveEditorSpec = (editorState: any) => {
  const spec = editorState?.spec;
  const width = Number(spec?.width);
  const height = Number(spec?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
};

const normalizeFromSpec = (value: number, specValue: number | undefined) => {
  if (!Number.isFinite(value)) return 0;
  if (!specValue || !Number.isFinite(specValue) || specValue <= 0) return value;
  return value / specValue;
};

const scaleFromSpec = (value: number, spec: { width: number; height: number } | null) => {
  if (!Number.isFinite(value)) return 0;
  if (!spec) return value;
  const ratio = TARGET_WIDTH / spec.width;
  return value * ratio;
};

const resolveTextAnchor = (anchorX?: number) => {
  const value = clampNumber(Number(anchorX ?? 0), 0, 1, 0);
  if (value >= 0.66) return 'end';
  if (value >= 0.33) return 'middle';
  return 'start';
};

const resolveBaseline = (anchorY?: number) => {
  const value = clampNumber(Number(anchorY ?? 0), 0, 1, 0);
  if (value >= 0.66) return 'alphabetic';
  if (value >= 0.33) return 'middle';
  return 'hanging';
};

const resolveCropRect = (
  transform: any,
  spec: { width: number; height: number } | null
) => {
  const crop = transform?.crop;
  if (!crop) return null;
  const rawWidth = Number(crop.width);
  const rawHeight = Number(crop.height);
  if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth <= 0 || rawHeight <= 0) {
    return null;
  }
  const rawX = Number(crop.x ?? 0);
  const rawY = Number(crop.y ?? 0);
  const normalized =
    rawWidth <= 1 &&
    rawHeight <= 1 &&
    Math.abs(rawX) <= 1.5 &&
    Math.abs(rawY) <= 1.5;
  const widthNorm = normalized ? rawWidth : normalizeFromSpec(rawWidth, spec?.width);
  const heightNorm = normalized ? rawHeight : normalizeFromSpec(rawHeight, spec?.height);
  const xNorm = normalized ? rawX : normalizeFromSpec(rawX, spec?.width);
  const yNorm = normalized ? rawY : normalizeFromSpec(rawY, spec?.height);
  const clampedW = clampNumber(widthNorm, 0.05, 1, 1);
  const clampedH = clampNumber(heightNorm, 0.05, 1, 1);
  const clampedX = clampNumber(xNorm, 0, 1 - clampedW, 0);
  const clampedY = clampNumber(yNorm, 0, 1 - clampedH, 0);
  const width = Math.round(clampedW * TARGET_WIDTH);
  const height = Math.round(clampedH * TARGET_HEIGHT);
  const x = Math.round(clampedX * TARGET_WIDTH);
  const y = Math.round(clampedY * TARGET_HEIGHT);
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
};

const assertStorageConfigured = () => {
  if (providerRaw && providerRaw !== 'gcs') {
    throw new Error(
      'STORAGE_PROVIDER invalido. El runtime actual solo admite gcs para evitar regresion de stack.'
    );
  }
  if (!gcsReelsBucket) {
    throw new Error('GCS no configurado. Falta GCS_BUCKET.');
  }
};

let gcsClient: Storage | null = null;

const getGcsClient = () => {
  if (!gcsClient) {
    gcsClient = new Storage();
  }
  return gcsClient;
};

const encodeObjectPath = (path: string) =>
  path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

const buildPublicUrl = (storagePath: string) => {
  const encodedPath = encodeObjectPath(storagePath);
  if (gcsPublicBaseUrl) return `${gcsPublicBaseUrl}/${encodedPath}`;
  return `https://storage.googleapis.com/${reelsBucket}/${encodedPath}`;
};

type VideoJob = {
  jobId: string;
  shopId: string;
  file: Express.Multer.File;
  tempDir: string;
  createdAt: number;
};

const videoQueue: VideoJob[] = [];
const completedJobs = new Map<string, { videoUrl: string; thumbnailUrl: string }>();
let queueRunning = false;

const ensureFfmpeg = () => {
  if (!ffmpegPath) {
    throw new Error('ffmpeg no disponible en el servidor.');
  }
  ffmpeg.setFfmpegPath(ffmpegPath);
};

const runFfmpegCommand = async ({
  command,
  timeoutMs = FFMPEG_TIMEOUT_MS,
  timeoutLabel,
  onProgress,
  stderrCollector,
}: {
  command: any;
  timeoutMs?: number;
  timeoutLabel: string;
  onProgress?: (progress: { percent?: number }) => void;
  stderrCollector?: string[];
}) => {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    timeoutHandle = setTimeout(() => {
      try {
        command.kill('SIGKILL');
      } catch {
        // ignore kill errors
      }
      finish(new Error(`${timeoutLabel} excedio el timeout (${timeoutMs}ms).`));
    }, timeoutMs);

    if (onProgress) {
      command.on('progress', (progress: { percent?: number }) => {
        onProgress(progress);
      });
    }

    if (stderrCollector) {
      command.on('stderr', (line: string) => {
        if (stderrCollector.length < 40) stderrCollector.push(line);
      });
    }

    command
      .on('end', () => finish())
      .on('error', (error: unknown) => {
        if (error instanceof Error) {
          finish(error);
          return;
        }
        finish(new Error('Error ffmpeg no identificado.'));
      });

    command.run();
  });
};

const createTempDir = async () => {
  const base = path.join(os.tmpdir(), 'avellaneda-reels');
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, 'job-'));
};

const uploadBuffer = async (filePath: string, buffer: Buffer, contentType: string) => {
  assertStorageConfigured();
  const gcs = getGcsClient();
  await gcs.bucket(reelsBucket).file(filePath).save(buffer, {
    resumable: false,
    metadata: { contentType },
  });
  return buildPublicUrl(filePath);
};

const uploadFileFromPath = async (storagePath: string, sourcePath: string, contentType: string) => {
  assertStorageConfigured();
  const gcs = getGcsClient();
  await gcs.bucket(reelsBucket).upload(sourcePath, {
    destination: storagePath,
    resumable: false,
    metadata: { contentType },
  });
  return buildPublicUrl(storagePath);
};

const buildKey = (shopId: string, name: string) => {
  const safeName = name.replace(/[^\w.-]+/g, '-').slice(0, 120);
  return `processed/shops/${shopId}/${Date.now()}-${safeName}`;
};

const clampNumber = (value: number, min: number, max: number, fallback: number) => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
};

const loadManropeFont = async () => {
  if (manropeFontBase64) return manropeFontBase64;
  if (!manropePathLogged) {
    const exists = fsSync.existsSync(MANROPE_FONT_PATH);
    console.log(
      `[reels-worker] Manrope path: ${MANROPE_FONT_PATH} (exists=${exists})`
    );
    manropePathLogged = true;
  }
  try {
    const buffer = await fs.readFile(MANROPE_FONT_PATH);
    if (!buffer.length) {
      throw new Error('Fuente Manrope vacia.');
    }
    manropeFontBase64 = buffer.toString('base64');
    return manropeFontBase64;
  } catch (error) {
    throw new Error(
      `No se pudo cargar la fuente Manrope (${MANROPE_FONT_PATH}).`
    );
  }
};

const escapeSvgText = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const buildStickerOverlay = async (editorState: any, tempDir: string) => {
  if (!editorState || !Array.isArray(editorState.stickers)) return null;
  const stickers = editorState.stickers.filter((sticker: any) => String(sticker?.text || '').trim());
  if (!stickers.length) return null;
  const spec = resolveEditorSpec(editorState);
  const fontBase64 = await loadManropeFont();
  const fontFace = `
  <defs>
    <style type="text/css">
      @font-face {
        font-family: 'Manrope';
        src: url("data:font/ttf;base64,${fontBase64}") format('truetype');
        font-weight: 100 900;
        font-style: normal;
      }
    </style>
  </defs>`;

  const elements = stickers.map((sticker: any) => {
    const rawText = String(sticker?.text || '').trim();
    const normalizedX = normalizeFromSpec(Number(sticker.x), spec?.width);
    const normalizedY = normalizeFromSpec(Number(sticker.y), spec?.height);
    const x = Math.round(clampNumber(normalizedX, -2, 2, 0) * TARGET_WIDTH);
    const y = Math.round(clampNumber(normalizedY, -2, 2, 0) * TARGET_HEIGHT);
    const scale = clampNumber(Number(sticker.scale ?? 1), 0.5, 3, 1);
    const baseFontSize = Number(sticker.fontSize ?? 42);
    const baseLineHeight = Number(sticker.lineHeight ?? baseFontSize * 1.25);
    const fontSize = Math.max(10, Math.round(scaleFromSpec(baseFontSize, spec) * scale));
    const lineHeight = Math.max(10, Math.round(scaleFromSpec(baseLineHeight, spec) * scale));
    const color = String(sticker.color || '#ffffff');
    const rotation = clampNumber(Number(sticker.rotation ?? 0), -180, 180, 0);
    const fontFamily = 'Manrope';
    const textAnchor = resolveTextAnchor(sticker.anchorX);
    const baseline = resolveBaseline(sticker.anchorY);
    const lines = rawText.split(/\r?\n/);
    const tspans = lines
      .map((line, index) => {
        const safeLine = escapeSvgText(line);
        const dy = index === 0 ? '0' : String(lineHeight);
        return `<tspan x="${x}" dy="${dy}">${safeLine}</tspan>`;
      })
      .join('');
    const transform = rotation ? ` transform="rotate(${rotation} ${x} ${y})"` : '';
    return `<text x="${x}" y="${y}" fill="${color}" font-size="${fontSize}" font-family="${fontFamily}" text-anchor="${textAnchor}" dominant-baseline="${baseline}"${transform}>${tspans}</text>`;
  });

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${TARGET_WIDTH}" height="${TARGET_HEIGHT}" viewBox="0 0 ${TARGET_WIDTH} ${TARGET_HEIGHT}">
  ${fontFace}
  ${elements.join('\n')}
</svg>`;

  const overlayPath = path.join(tempDir, 'reel-overlay.png');
  await sharp(Buffer.from(svg)).png().toFile(overlayPath);
  return overlayPath;
};

const buildEditorFilter = (editorState: any, mediaIndex = 0, withOverlay = false) => {
  const spec = resolveEditorSpec(editorState);
  const transforms = Array.isArray(editorState?.mediaTransforms) ? editorState.mediaTransforms : [];
  const transform = transforms[mediaIndex] || transforms[0];
  const fitMode = transform?.fit || editorState?.fit || 'contain';
  const cropRect = resolveCropRect(transform, spec);
  let baseFilter =
    fitMode === 'cover'
      ? `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=increase,crop=${TARGET_WIDTH}:${TARGET_HEIGHT},setsar=1`
      : `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease,pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  if (cropRect) {
    baseFilter += `,crop=${cropRect.width}:${cropRect.height}:${cropRect.x}:${cropRect.y},scale=${TARGET_WIDTH}:${TARGET_HEIGHT}`;
  }
  let filter = `[0:v]${baseFilter}[base]`;
  let currentLabel = 'base';
  if (transform) {
    const scale = clampNumber(Number(transform.scale ?? 1), 0.2, 4, 1);
    const rotationRad = ((Number(transform.rotation) || 0) * Math.PI) / 180;
    const normalizedX = normalizeFromSpec(Number(transform.x), spec?.width);
    const normalizedY = normalizeFromSpec(Number(transform.y), spec?.height);
    const offsetX = Math.round(normalizedX * TARGET_WIDTH);
    const offsetY = Math.round(normalizedY * TARGET_HEIGHT);
    const overlayX = `(W-w)/2+${offsetX}`;
    const overlayY = `(H-h)/2+${offsetY}`;
    filter += `;[base]scale=iw*${scale}:ih*${scale},rotate=${rotationRad}:fillcolor=black@0[scaled]`;
    filter += `;nullsrc=size=${TARGET_WIDTH}x${TARGET_HEIGHT}[canvas]`;
    filter += `;[canvas][scaled]overlay=${overlayX}:${overlayY}[v0]`;
    currentLabel = 'v0';
  }

  if (withOverlay) {
    filter += `;[${currentLabel}][1:v]overlay=0:0[v1]`;
    currentLabel = 'v1';
  }

  // Ensure final crop to the exact canvas to avoid overflow in the story viewer.
  filter += `;[${currentLabel}]crop=${TARGET_WIDTH}:${TARGET_HEIGHT}:0:0[vout]`;

  return { filter, outputLabel: 'vout' };
};

const processPhotoSet = async (
  shopId: string,
  files: Express.Multer.File[],
  tempDir: string,
  editorState?: any
) => {
  const outputs: string[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file) continue;
    const publicUrl = await processPhotoFromPath(shopId, file.path, tempDir, editorState, index);
    outputs.push(publicUrl);
  }
  return outputs;
};

export const processPhotoFromPath = async (
  shopId: string,
  sourcePath: string,
  tempDir: string,
  editorState?: any,
  mediaIndex = 0,
  timeoutMs = FFMPEG_TIMEOUT_MS
) => {
  ensureFfmpeg();
  await fs.mkdir(tempDir, { recursive: true });
  const stat = await fs.stat(sourcePath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Archivo fuente invalido o vacio: ${sourcePath}`);
  }
  const outputName = `reel-photo-${mediaIndex}.jpg`;
  const overlayPath = await buildStickerOverlay(editorState, tempDir);
  const { filter, outputLabel } = buildEditorFilter(editorState, mediaIndex, Boolean(overlayPath));

  const outputPath = path.join(tempDir, outputName);
  const stderr: string[] = [];

  const command = ffmpeg(sourcePath);
  if (overlayPath) {
    command.input(overlayPath);
  }
  command
    .complexFilter(filter)
    .outputOptions([
      '-map',
      `[${outputLabel}]`,
      '-frames:v',
      '1',
      '-q:v',
      '4',
      '-update',
      '1',
      '-y',
    ])
    .output(outputPath);

  try {
    await runFfmpegCommand({
      command,
      timeoutMs,
      timeoutLabel: `Render de foto ${mediaIndex + 1}`,
      stderrCollector: stderr,
    });
  } catch (error) {
    const details = stderr.length ? `\nffmpeg:\n${stderr.join('\n')}` : '';
    if (error instanceof Error) {
      throw new Error(`${error.message}${details}`);
    }
    throw new Error(`Error procesando imagen.${details}`);
  }

  const buffer = await fs.readFile(outputPath);
  if (!buffer.length) {
    const details = stderr.length ? `\nffmpeg:\n${stderr.join('\n')}` : '';
    throw new Error(`No se pudo renderizar la imagen del reel (sin salida).${details}`);
  }

  return uploadBuffer(buildKey(shopId, outputName), buffer, 'image/jpeg');
};

export const processVideoFromPath = async (
  shopId: string,
  sourcePath: string,
  tempDir: string,
  editorState?: any,
  onProgress?: (progress: number) => void,
  timeoutMs = FFMPEG_TIMEOUT_MS
) => {
  ensureFfmpeg();
  await fs.mkdir(tempDir, { recursive: true });
  const sourceStat = await fs.stat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.size === 0) {
    throw new Error(`Archivo fuente invalido o vacio: ${sourcePath}`);
  }
  const sourceSizeMb = sourceStat.size / (1024 * 1024);
  if (sourceSizeMb > MAX_SOURCE_VIDEO_MB) {
    throw new Error(
      `Video demasiado pesado (${sourceSizeMb.toFixed(1)}MB). Maximo permitido: ${MAX_SOURCE_VIDEO_MB}MB.`
    );
  }
  const videoOutput = path.join(tempDir, 'out.mp4');
  const thumbOutput = path.join(tempDir, 'out-thumb.jpg');
  const overlayPath = await buildStickerOverlay(editorState, tempDir);
  const { filter, outputLabel } = buildEditorFilter(editorState, 0, Boolean(overlayPath));

  const renderCommand = ffmpeg(sourcePath);
  if (overlayPath) {
    renderCommand.input(overlayPath).inputOptions(['-loop', '1']);
  }
  renderCommand
    .complexFilter(filter)
    .outputOptions([
      '-map',
      `[${outputLabel}]`,
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-threads',
      String(FFMPEG_THREADS),
      '-preset',
      'veryfast',
      '-crf',
      '28',
      '-r',
      '30',
      '-maxrate',
      '1800k',
      '-bufsize',
      '3600k',
      '-g',
      '60',
      '-movflags',
      '+faststart',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-shortest',
      '-y',
    ])
    .output(videoOutput);

  await runFfmpegCommand({
    command: renderCommand,
    timeoutMs,
    timeoutLabel: 'Render de video',
    onProgress: (progress: { percent?: number }) => {
      const percent = Number(progress?.percent);
      if (Number.isFinite(percent)) {
        onProgress?.(percent);
      }
    },
  });

  const videoStat = await fs.stat(videoOutput);
  if (!videoStat.isFile() || videoStat.size === 0) {
    throw new Error('No se pudo renderizar el video final (sin salida).');
  }

  await new Promise<void>((resolve, reject) => {
    const screenshotCommand = ffmpeg(videoOutput).outputOptions([
      '-threads',
      String(FFMPEG_THREADS),
    ]);
    let settled = false;
    const timeoutHandle = setTimeout(() => {
      try {
        screenshotCommand.kill('SIGKILL');
      } catch {
        // ignore kill errors
      }
      if (!settled) {
        settled = true;
        reject(new Error(`Render de thumbnail excedio el timeout (${timeoutMs}ms).`));
      }
    }, timeoutMs);

    screenshotCommand
      .on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolve();
      })
      .on('error', (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        if (error instanceof Error) {
          reject(error);
          return;
        }
        reject(new Error('Error al generar thumbnail.'));
      })
      .screenshots({
        timestamps: ['1'],
        filename: path.basename(thumbOutput),
        folder: tempDir,
        size: '720x?',
      });
  });

  const thumbStat = await fs.stat(thumbOutput);
  if (!thumbStat.isFile() || thumbStat.size === 0) {
    throw new Error('No se pudo generar el thumbnail del video.');
  }

  const videoUrl = await uploadFileFromPath(buildKey(shopId, 'reel.mp4'), videoOutput, 'video/mp4');
  const thumbnailUrl = await uploadFileFromPath(
    buildKey(shopId, 'reel-thumb.jpg'),
    thumbOutput,
    'image/jpeg'
  );

  return { videoUrl, thumbnailUrl };
};

const processVideo = async (
  shopId: string,
  file: Express.Multer.File,
  tempDir: string,
  editorState?: any
) => {
  return processVideoFromPath(shopId, file.path, tempDir, editorState);
};

const cleanupFiles = async (files: Express.Multer.File[], tempDir: string) => {
  const paths = files.map((file) => file.path);
  await Promise.allSettled(paths.map((filePath) => fs.unlink(filePath)));
  await fs.rm(tempDir, { recursive: true, force: true });
};

const runQueue = async () => {
  if (queueRunning) return;
  queueRunning = true;
  while (videoQueue.length > 0) {
    const job = videoQueue.shift();
    if (!job) continue;
    try {
      const { videoUrl, thumbnailUrl } = await processVideo(job.shopId, job.file, job.tempDir);
      const updated = await prisma.reel.updateMany({
        where: { processingJobId: job.jobId },
        data: { videoUrl, thumbnailUrl, status: ReelStatus.ACTIVE },
      });
      if (updated.count === 0) {
        completedJobs.set(job.jobId, { videoUrl, thumbnailUrl });
      }
    } catch (error) {
      await prisma.reel.updateMany({
        where: { processingJobId: job.jobId },
        data: { status: ReelStatus.HIDDEN, hidden: true },
      });
    } finally {
      await cleanupFiles([job.file], job.tempDir);
    }
  }
  queueRunning = false;
};

export const enqueueReelVideoJob = async (shopId: string, file: Express.Multer.File) => {
  const jobId = crypto.randomUUID();
  const tempDir = await createTempDir();
  videoQueue.push({
    jobId,
    shopId,
    file,
    tempDir,
    createdAt: Date.now(),
  });
  void runQueue();
  return jobId;
};

export const consumeCompletedJob = (jobId: string) => {
  const data = completedJobs.get(jobId);
  if (data) {
    completedJobs.delete(jobId);
  }
  return data;
};

export const processReelUpload = async ({
  shopId,
  type,
  files,
  editorState,
}: {
  shopId: string;
  type: 'VIDEO' | 'PHOTO_SET';
  files: Express.Multer.File[];
  editorState?: any;
}) => {
  if (!files.length) {
    throw new Error('No se recibieron archivos para procesar.');
  }
  const tempDir = await createTempDir();
  try {
    if (type === 'VIDEO') {
      const { videoUrl, thumbnailUrl } = await processVideo(shopId, files[0], tempDir, editorState);
      return { videoUrl, thumbnailUrl, photoUrls: [] as string[] };
    }

    const photoUrls = await processPhotoSet(shopId, files, tempDir, editorState);
    return { photoUrls, videoUrl: null, thumbnailUrl: null };
  } finally {
    await cleanupFiles(files, tempDir);
  }
};
