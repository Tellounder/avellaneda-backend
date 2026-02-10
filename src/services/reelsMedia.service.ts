import { createClient } from '@supabase/supabase-js';
import prisma from '../../prisma/client';
import { ReelStatus } from '@prisma/client';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import fsSync from 'fs';
import ffmpegPath from 'ffmpeg-static';
// `fluent-ffmpeg` does not ship typings in our runtime path.
const ffmpeg: any = require('fluent-ffmpeg');

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const reelsBucket = process.env.SUPABASE_REELS_BUCKET || 'reels';
const fontFile = process.env.REEL_FONT_FILE || '';
const resolvedFontFile =
  fontFile && fsSync.existsSync(fontFile) ? fontFile : '';
const TARGET_WIDTH = 720;
const TARGET_HEIGHT = 1280;

const assertSupabaseConfigured = () => {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase no configurado. Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.');
  }
};

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

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

const createTempDir = async () => {
  const base = path.join(os.tmpdir(), 'avellaneda-reels');
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, 'job-'));
};

const uploadBuffer = async (filePath: string, buffer: Buffer, contentType: string) => {
  assertSupabaseConfigured();
  const { error } = await supabase.storage.from(reelsBucket).upload(filePath, buffer, {
    contentType,
    upsert: true,
  });
  if (error) {
    throw new Error(error.message || 'No se pudo subir el archivo procesado.');
  }
  const { data } = supabase.storage.from(reelsBucket).getPublicUrl(filePath);
  return data.publicUrl;
};

const buildKey = (shopId: string, name: string) => {
  const safeName = name.replace(/[^\w.-]+/g, '-').slice(0, 120);
  return `processed/shops/${shopId}/${Date.now()}-${safeName}`;
};

const clampNumber = (value: number, min: number, max: number, fallback: number) => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
};

const escapeDrawText = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");

const buildEditorFilter = (editorState: any, mediaIndex = 0) => {
  const baseFilter = `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease,pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  let filter = `[0:v]${baseFilter}[base]`;
  let currentLabel = 'base';

  const transforms = Array.isArray(editorState?.mediaTransforms) ? editorState.mediaTransforms : [];
  const transform = transforms[mediaIndex] || transforms[0];
  if (transform) {
    const scale = clampNumber(Number(transform.scale ?? 1), 0.2, 4, 1);
    const rotationRad = ((Number(transform.rotation) || 0) * Math.PI) / 180;
    const offsetX = Math.round((Number(transform.x) || 0) * TARGET_WIDTH);
    const offsetY = Math.round((Number(transform.y) || 0) * TARGET_HEIGHT);
    const overlayX = `(W-w)/2+${offsetX}`;
    const overlayY = `(H-h)/2+${offsetY}`;
    filter += `;[base]scale=iw*${scale}:ih*${scale},rotate=${rotationRad}:fillcolor=black@0[scaled]`;
    filter += `;nullsrc=size=${TARGET_WIDTH}x${TARGET_HEIGHT}[canvas]`;
    filter += `;[canvas][scaled]overlay=${overlayX}:${overlayY}[v0]`;
    currentLabel = 'v0';
  }

  const stickers = Array.isArray(editorState?.stickers) ? editorState.stickers : [];
  const fontOption = resolvedFontFile
    ? `:fontfile='${escapeDrawText(resolvedFontFile)}'`
    : '';

  stickers.forEach((sticker: any, index: number) => {
    const rawText = String(sticker?.text || '').trim();
    if (!rawText) return;
    const x = Math.round(clampNumber(Number(sticker.x), -2, 2, 0) * TARGET_WIDTH);
    const y = Math.round(clampNumber(Number(sticker.y), -2, 2, 0) * TARGET_HEIGHT);
    const scale = clampNumber(Number(sticker.scale ?? 1), 0.5, 3, 1);
    const fontSize = Math.max(16, Math.round(42 * scale));
    const color = String(sticker.color || '#ffffff').replace('#', '') || 'ffffff';
    const text = escapeDrawText(rawText);
    const nextLabel = `vt${index}`;
    filter += `;[${currentLabel}]drawtext${fontOption}:text='${text}':x=${x}:y=${y}:fontsize=${fontSize}:fontcolor=${color}:shadowcolor=black@0.45:shadowx=2:shadowy=2[${nextLabel}]`;
    currentLabel = nextLabel;
  });

  if (currentLabel !== 'vout') {
    filter += `;[${currentLabel}]null[vout]`;
  }

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
  mediaIndex = 0
) => {
  ensureFfmpeg();
  await fs.mkdir(tempDir, { recursive: true });
  const stat = await fs.stat(sourcePath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Archivo fuente invalido o vacio: ${sourcePath}`);
  }
  const outputName = `reel-photo-${mediaIndex}.jpg`;
  const { filter, outputLabel } = buildEditorFilter(editorState, mediaIndex);

  const outputPath = path.join(tempDir, outputName);
  const stderr: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown) => {
      const details = stderr.length ? `\nffmpeg:\n${stderr.join('\n')}` : '';
      const message =
        error instanceof Error ? `${error.message}${details}` : `Error procesando imagen.${details}`;
      reject(new Error(message));
    };
    ffmpeg(sourcePath)
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
      .output(outputPath)
      .on('stderr', (line: string) => {
        if (stderr.length < 20) stderr.push(line);
      })
      .on('end', resolve)
      .on('error', onError)
      .run();
  });

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
  editorState?: any
) => {
  ensureFfmpeg();
  await fs.mkdir(tempDir, { recursive: true });
  const videoOutput = path.join(tempDir, 'reel-video.mp4');
  const thumbOutput = path.join(tempDir, 'reel-thumb.jpg');
  const { filter, outputLabel } = buildEditorFilter(editorState, 0);

  await new Promise<void>((resolve, reject) => {
    ffmpeg(sourcePath)
      .complexFilter(filter)
      .outputOptions([
        '-map',
        `[${outputLabel}]`,
        '-map',
        '0:a?',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '28',
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
      .output(videoOutput)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  await new Promise<void>((resolve, reject) => {
    ffmpeg(videoOutput)
      .on('end', resolve)
      .on('error', reject)
      .screenshots({
        timestamps: ['1'],
        filename: path.basename(thumbOutput),
        folder: tempDir,
        size: '720x?',
      });
  });

  const videoBuffer = await fs.readFile(videoOutput);
  const thumbBuffer = await fs.readFile(thumbOutput);

  const videoUrl = await uploadBuffer(buildKey(shopId, 'reel.mp4'), videoBuffer, 'video/mp4');
  const thumbnailUrl = await uploadBuffer(
    buildKey(shopId, 'reel-thumb.jpg'),
    thumbBuffer,
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
