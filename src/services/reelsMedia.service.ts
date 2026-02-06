import { createClient } from '@supabase/supabase-js';
import prisma from '../../prisma/client';
import { ReelStatus } from '@prisma/client';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const reelsBucket = process.env.SUPABASE_REELS_BUCKET || 'reels';

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

const processPhotoSet = async (
  shopId: string,
  files: Express.Multer.File[],
  tempDir: string
) => {
  const outputs: string[] = [];
  for (const file of files) {
    const outputName = `${path.parse(file.originalname).name}.webp`;
    const outputPath = path.join(tempDir, outputName);
    await sharp(file.path)
      .resize({ width: 1080, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(outputPath);

    const buffer = await fs.readFile(outputPath);
    const publicUrl = await uploadBuffer(buildKey(shopId, outputName), buffer, 'image/webp');
    outputs.push(publicUrl);
  }
  return outputs;
};

export const processVideoFromPath = async (
  shopId: string,
  sourcePath: string,
  tempDir: string
) => {
  ensureFfmpeg();
  const videoOutput = path.join(tempDir, 'reel-video.mp4');
  const thumbOutput = path.join(tempDir, 'reel-thumb.jpg');

  await new Promise<void>((resolve, reject) => {
    ffmpeg(sourcePath)
      .outputOptions([
        '-vf',
        'scale=-2:720',
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
      ])
      .output(videoOutput)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  await new Promise<void>((resolve, reject) => {
    ffmpeg(sourcePath)
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
  tempDir: string
) => {
  return processVideoFromPath(shopId, file.path, tempDir);
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
}: {
  shopId: string;
  type: 'VIDEO' | 'PHOTO_SET';
  files: Express.Multer.File[];
}) => {
  if (!files.length) {
    throw new Error('No se recibieron archivos para procesar.');
  }
  const tempDir = await createTempDir();
  try {
    if (type === 'VIDEO') {
      const { videoUrl, thumbnailUrl } = await processVideo(shopId, files[0], tempDir);
      return { videoUrl, thumbnailUrl, photoUrls: [] as string[] };
    }

    const photoUrls = await processPhotoSet(shopId, files, tempDir);
    return { photoUrls, videoUrl: null, thumbnailUrl: null };
  } finally {
    await cleanupFiles(files, tempDir);
  }
};
