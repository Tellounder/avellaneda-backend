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
const TARGET_ASPECT = TARGET_WIDTH / TARGET_HEIGHT;
const OVERLAY_SUPERSAMPLE = Math.max(
  1,
  Math.min(3, Number(process.env.REEL_OVERLAY_SUPERSAMPLE || 2))
);
const OVERLAY_WIDTH = TARGET_WIDTH * OVERLAY_SUPERSAMPLE;
const OVERLAY_HEIGHT = TARGET_HEIGHT * OVERLAY_SUPERSAMPLE;
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
  Number(process.env.REEL_MAX_SOURCE_VIDEO_MB || 100)
);
const MAX_SOURCE_VIDEO_SECONDS = Math.max(
  5,
  Number(process.env.REEL_MAX_SOURCE_VIDEO_SECONDS || 17)
);
export const REEL_RENDER_PROFILE_VERSION = 'reels-render-v3-p2';
const PHOTO_ENCODE_PROFILE = Object.freeze({
  codec: 'mjpeg',
  qualityQv: 2,
  pixFmt: 'yuvj444p',
});
const VIDEO_ENCODE_PROFILE = Object.freeze({
  codec: 'libx264',
  preset: 'veryfast',
  profile: 'high',
  level: '4.0',
  crf: 23,
  fps: 30,
  maxrate: '3200k',
  bufsize: '6400k',
  gop: 60,
  pixFmt: 'yuv420p',
  audioCodec: 'aac',
  audioBitrate: '128k',
});
let manropeFontBase64: string | null = null;
let manropePathLogged = false;

type RenderDiagnostics = {
  profileVersion: string;
  kind: 'PHOTO' | 'VIDEO';
  filterHash: string;
  normalization: Record<string, any>;
  encode: Record<string, any>;
  source: Record<string, any>;
  output?: Record<string, any>;
  overlay: {
    hasOverlay: boolean;
    source: 'downloaded' | 'generated' | 'none';
  };
};

type ResolvedEditorSpec = {
  width: number;
  height: number;
  frameWidth: number;
  frameHeight: number;
  frameOffsetX: number;
  frameOffsetY: number;
  aspect: number;
  usesLetterbox: boolean;
};

const resolveEditorSpec = (editorState: any): ResolvedEditorSpec | null => {
  const spec = editorState?.spec;
  const width = Number(spec?.width);
  const height = Number(spec?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const aspect = width / height;
  const aspectDelta = Math.abs(aspect - TARGET_ASPECT);
  if (aspectDelta < 0.0005) {
    return {
      width,
      height,
      frameWidth: width,
      frameHeight: height,
      frameOffsetX: 0,
      frameOffsetY: 0,
      aspect,
      usesLetterbox: false,
    };
  }
  if (aspect > TARGET_ASPECT) {
    const frameHeight = height;
    const frameWidth = frameHeight * TARGET_ASPECT;
    return {
      width,
      height,
      frameWidth,
      frameHeight,
      frameOffsetX: (width - frameWidth) / 2,
      frameOffsetY: 0,
      aspect,
      usesLetterbox: true,
    };
  }
  const frameWidth = width;
  const frameHeight = frameWidth / TARGET_ASPECT;
  return {
    width,
    height,
    frameWidth,
    frameHeight,
    frameOffsetX: 0,
    frameOffsetY: (height - frameHeight) / 2,
    aspect,
    usesLetterbox: true,
  };
};

const normalizeDimensionFromSpec = (value: number, specValue: number | undefined) => {
  if (!Number.isFinite(value)) return 0;
  if (!specValue || !Number.isFinite(specValue) || specValue <= 0) return value;
  return value / specValue;
};

const normalizeFromSpec = (
  value: number,
  spec: ResolvedEditorSpec | null,
  axis: 'x' | 'y'
) => {
  if (!Number.isFinite(value)) return 0;
  // Compatibilidad: algunos clients ya envian valores normalizados.
  if (Math.abs(value) <= 1.5) return value;
  if (!spec) return value;
  const size = axis === 'x' ? spec.frameWidth : spec.frameHeight;
  const offset = axis === 'x' ? spec.frameOffsetX : spec.frameOffsetY;
  if (!Number.isFinite(size) || size <= 0) return value;
  return (value - offset) / size;
};

const scaleFromSpec = (value: number, spec: ResolvedEditorSpec | null) => {
  if (!Number.isFinite(value)) return 0;
  if (!spec) return value;
  const ratio = TARGET_WIDTH / spec.frameWidth;
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
  spec: ResolvedEditorSpec | null
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
  const widthNorm = normalized
    ? rawWidth
    : normalizeDimensionFromSpec(rawWidth, spec?.frameWidth);
  const heightNorm = normalized
    ? rawHeight
    : normalizeDimensionFromSpec(rawHeight, spec?.frameHeight);
  const xNorm = normalized ? rawX : normalizeFromSpec(rawX, spec, 'x');
  const yNorm = normalized ? rawY : normalizeFromSpec(rawY, spec, 'y');
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

const normalizeHexColor = (value: unknown, fallback = '0x0f172a') => {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const hex = raw.startsWith('#') ? raw.slice(1) : raw;
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return `0x${hex.toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    const expanded = hex
      .split('')
      .map((char) => `${char}${char}`)
      .join('');
    return `0x${expanded.toLowerCase()}`;
  }
  return fallback;
};

const resolveMediaBackground = (editorState: any) => {
  const rawMode = String(editorState?.mediaBackground?.mode || '')
    .trim()
    .toLowerCase();
  const mode =
    rawMode === 'color' || rawMode === 'solid'
      ? 'color'
      : rawMode === 'blur' || rawMode === 'glass'
        ? 'blur'
        : 'blur';
  const color = normalizeHexColor(editorState?.mediaBackground?.color, '0x334155');
  const source = rawMode || 'default-blur';
  return { mode, color, source };
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

const hashFilterGraph = (filter: string) =>
  crypto.createHash('sha1').update(filter).digest('hex').slice(0, 12);

const readVideoProbe = async (
  sourcePath: string
): Promise<{ durationSec: number; width: number | null; height: number | null }> =>
  new Promise<{ durationSec: number; width: number | null; height: number | null }>(
    (resolve, reject) => {
      ffmpeg.ffprobe(sourcePath, (error: unknown, data: any) => {
        if (error) {
          reject(error instanceof Error ? error : new Error('No se pudo inspeccionar el video.'));
          return;
        }
      const duration = Number(data?.format?.duration || 0);
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error('No se pudo determinar la duracion del video.'));
        return;
      }
      const videoStream = Array.isArray(data?.streams)
        ? data.streams.find((stream: any) => stream?.codec_type === 'video')
        : null;
      const width = Number(videoStream?.width);
      const height = Number(videoStream?.height);
        resolve({
          durationSec: duration,
          width: Number.isFinite(width) && width > 0 ? width : null,
          height: Number.isFinite(height) && height > 0 ? height : null,
        });
      });
    }
  );

const readVideoDurationSeconds = async (sourcePath: string): Promise<number> => {
  const probe = await readVideoProbe(sourcePath);
  return probe.durationSec;
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

const resolveVideoTrimWindow = (
  editorState: any,
  sourceDurationSeconds: number
): { startSec: number; durationSec: number; endSec: number } | null => {
  const rawTrim = editorState?.videoTrim;
  if (!rawTrim || typeof rawTrim !== 'object') return null;
  const startRaw = Number(rawTrim.startSec);
  const durationRaw = Number(rawTrim.durationSec);
  if (!Number.isFinite(startRaw) || !Number.isFinite(durationRaw)) return null;
  const durationSec = clampNumber(
    durationRaw,
    0.5,
    MAX_SOURCE_VIDEO_SECONDS,
    Math.min(MAX_SOURCE_VIDEO_SECONDS, sourceDurationSeconds)
  );
  const startSec = clampNumber(startRaw, 0, Math.max(0, sourceDurationSeconds - durationSec), 0);
  const endSec = Math.min(sourceDurationSeconds, startSec + durationSec);
  if (!Number.isFinite(endSec) || endSec - startSec <= 0.4) return null;
  return {
    startSec,
    durationSec: endSec - startSec,
    endSec,
  };
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
    const normalizedX = normalizeFromSpec(Number(sticker.x), spec, 'x');
    const normalizedY = normalizeFromSpec(Number(sticker.y), spec, 'y');
    const x = Math.round(clampNumber(normalizedX, -2, 2, 0) * OVERLAY_WIDTH);
    const y = Math.round(clampNumber(normalizedY, -2, 2, 0) * OVERLAY_HEIGHT);
    const scale = clampNumber(Number(sticker.scale ?? 1), 0.5, 3, 1);
    const baseFontSize = Number(sticker.fontSize ?? 42);
    const baseLineHeight = Number(sticker.lineHeight ?? baseFontSize * 1.25);
    const fontSize = Math.max(
      10,
      Math.round(scaleFromSpec(baseFontSize, spec) * scale * OVERLAY_SUPERSAMPLE)
    );
    const lineHeight = Math.max(
      10,
      Math.round(scaleFromSpec(baseLineHeight, spec) * scale * OVERLAY_SUPERSAMPLE)
    );
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
<svg xmlns="http://www.w3.org/2000/svg" width="${OVERLAY_WIDTH}" height="${OVERLAY_HEIGHT}" viewBox="0 0 ${OVERLAY_WIDTH} ${OVERLAY_HEIGHT}">
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
  const background = resolveMediaBackground(editorState);
  const normalizationMeta = spec
    ? {
        source: 'editor-spec',
        usesLetterbox: spec.usesLetterbox,
        inputWidth: spec.width,
        inputHeight: spec.height,
        frameWidth: Math.round(spec.frameWidth),
        frameHeight: Math.round(spec.frameHeight),
        frameOffsetX: Math.round(spec.frameOffsetX),
        frameOffsetY: Math.round(spec.frameOffsetY),
        inputAspect: Number(spec.aspect.toFixed(6)),
      }
    : {
        source: 'default-target',
        usesLetterbox: false,
        inputWidth: TARGET_WIDTH,
        inputHeight: TARGET_HEIGHT,
        frameWidth: TARGET_WIDTH,
        frameHeight: TARGET_HEIGHT,
        frameOffsetX: 0,
        frameOffsetY: 0,
        inputAspect: Number(TARGET_ASPECT.toFixed(6)),
      };
  const filterParts: string[] = [];

  if (background.mode === 'color') {
    filterParts.push(`color=c=${background.color}:s=${TARGET_WIDTH}x${TARGET_HEIGHT}:d=1,format=rgba[bg]`);
  } else {
    filterParts.push(
      `[0:v]scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos,crop=${TARGET_WIDTH}:${TARGET_HEIGHT},boxblur=24:8,eq=saturation=0.9:brightness=0.78,format=rgba[bg_blur]`
    );
    filterParts.push(`[bg_blur]drawbox=x=0:y=0:w=iw:h=ih:color=black@0.42:t=fill[bg]`);
  }

  let baseFilter =
    fitMode === 'cover'
      ? `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos,crop=${TARGET_WIDTH}:${TARGET_HEIGHT},setsar=1`
      : `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1`;
  if (cropRect) {
    baseFilter += `,crop=${cropRect.width}:${cropRect.height}:${cropRect.x}:${cropRect.y},scale=${TARGET_WIDTH}:${TARGET_HEIGHT}`;
  }
  filterParts.push(`[0:v]${baseFilter},format=rgba[base]`);
  const baseLabel = 'base';

  const scale = clampNumber(Number(transform?.scale ?? 1), 0.2, 4, 1);
  const rotationRad = ((Number(transform?.rotation) || 0) * Math.PI) / 180;
  const normalizedX = normalizeFromSpec(Number(transform?.x), spec, 'x');
  const normalizedY = normalizeFromSpec(Number(transform?.y), spec, 'y');
  const offsetX = Math.round(normalizedX * TARGET_WIDTH);
  const offsetY = Math.round(normalizedY * TARGET_HEIGHT);
  const overlayX = `(W-w)/2+${offsetX}`;
  const overlayY = `(H-h)/2+${offsetY}`;
  const scaleFactor = Number.isFinite(scale) ? scale.toFixed(6) : '1.000000';
  const rotationValue = Number.isFinite(rotationRad) ? rotationRad.toFixed(9) : '0.000000000';

  filterParts.push(
    `[${baseLabel}]scale=iw*${scaleFactor}:ih*${scaleFactor}:flags=lanczos,rotate=${rotationValue}:ow=rotw(iw):oh=roth(ih):fillcolor=0x00000000[scaled]`
  );
  filterParts.push(`[bg][scaled]overlay=${overlayX}:${overlayY}:format=auto:shortest=1[v0]`);

  let currentLabel = 'v0';
  if (withOverlay) {
    filterParts.push(
      `[1:v]format=rgba,scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=0x00000000[editor_overlay]`
    );
    filterParts.push(
      `[${currentLabel}][editor_overlay]overlay=0:0:format=auto:shortest=1[v1]`
    );
    currentLabel = 'v1';
  }

  filterParts.push(`[${currentLabel}]crop=${TARGET_WIDTH}:${TARGET_HEIGHT}:0:0,format=rgb24[vout]`);

  return {
    filter: filterParts.join(';'),
    outputLabel: 'vout',
    normalizationMeta: {
      ...normalizationMeta,
      backgroundMode: background.mode,
      backgroundSource: background.source,
    },
  };
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
  timeoutMs = FFMPEG_TIMEOUT_MS,
  providedOverlayPath?: string | null,
  onRenderDiagnostics?: (meta: RenderDiagnostics) => void
) => {
  ensureFfmpeg();
  await fs.mkdir(tempDir, { recursive: true });
  const stat = await fs.stat(sourcePath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Archivo fuente invalido o vacio: ${sourcePath}`);
  }
  const startedAt = Date.now();
  const outputName = `reel-photo-${mediaIndex}.jpg`;
  const overlayPath = providedOverlayPath || (await buildStickerOverlay(editorState, tempDir));
  const overlaySource: RenderDiagnostics['overlay']['source'] = providedOverlayPath
    ? 'downloaded'
    : overlayPath
      ? 'generated'
      : 'none';
  const { filter, outputLabel, normalizationMeta } = buildEditorFilter(
    editorState,
    mediaIndex,
    Boolean(overlayPath)
  );
  const filterHash = hashFilterGraph(filter);
  const sourceImageMeta = await sharp(sourcePath)
    .metadata()
    .then((meta) => ({
      width: Number(meta.width) || null,
      height: Number(meta.height) || null,
    }))
    .catch(() => ({ width: null, height: null }));
  if (normalizationMeta.usesLetterbox) {
    console.log(
      `[reels-render] Stage normalization photo media=${mediaIndex} source=${normalizationMeta.source} input=${normalizationMeta.inputWidth}x${normalizationMeta.inputHeight} frame=${normalizationMeta.frameWidth}x${normalizationMeta.frameHeight} offset=${normalizationMeta.frameOffsetX},${normalizationMeta.frameOffsetY}`
    );
  }

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
      '2',
      '-pix_fmt',
      'yuvj444p',
      '-an',
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
  const elapsedMs = Date.now() - startedAt;
  onRenderDiagnostics?.({
    profileVersion: REEL_RENDER_PROFILE_VERSION,
    kind: 'PHOTO',
    filterHash,
    normalization: normalizationMeta,
    encode: { ...PHOTO_ENCODE_PROFILE },
    source: {
      path: sourcePath,
      sizeBytes: stat.size,
      ...sourceImageMeta,
      mediaIndex,
    },
    output: {
      width: TARGET_WIDTH,
      height: TARGET_HEIGHT,
      sizeBytes: buffer.length,
      elapsedMs,
    },
    overlay: {
      hasOverlay: Boolean(overlayPath),
      source: overlaySource,
    },
  });
  console.log(
    `[reels-render] photo done shop=${shopId} media=${mediaIndex} hash=${filterHash} bytes=${buffer.length} ms=${elapsedMs} overlay=${overlaySource}`
  );

  return uploadBuffer(buildKey(shopId, outputName), buffer, 'image/jpeg');
};

export const processVideoFromPath = async (
  shopId: string,
  sourcePath: string,
  tempDir: string,
  editorState?: any,
  onProgress?: (progress: number) => void,
  timeoutMs = FFMPEG_TIMEOUT_MS,
  providedOverlayPath?: string | null,
  onRenderDiagnostics?: (meta: RenderDiagnostics) => void
) => {
  ensureFfmpeg();
  await fs.mkdir(tempDir, { recursive: true });
  const startedAt = Date.now();
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
  const videoProbe = await readVideoProbe(sourcePath);
  const sourceDurationSeconds = videoProbe.durationSec;
  const trimWindow = resolveVideoTrimWindow(editorState, sourceDurationSeconds);
  if (!trimWindow && sourceDurationSeconds > MAX_SOURCE_VIDEO_SECONDS) {
    throw new Error(
      `Video demasiado largo (${sourceDurationSeconds.toFixed(1)}s). Maximo permitido: ${MAX_SOURCE_VIDEO_SECONDS}s.`
    );
  }
  const videoOutput = path.join(tempDir, 'out.mp4');
  const thumbOutput = path.join(tempDir, 'out-thumb.jpg');
  const overlayPath = providedOverlayPath || (await buildStickerOverlay(editorState, tempDir));
  const overlaySource: RenderDiagnostics['overlay']['source'] = providedOverlayPath
    ? 'downloaded'
    : overlayPath
      ? 'generated'
      : 'none';
  const { filter, outputLabel, normalizationMeta } = buildEditorFilter(
    editorState,
    0,
    Boolean(overlayPath)
  );
  const filterHash = hashFilterGraph(filter);
  if (normalizationMeta.usesLetterbox) {
    console.log(
      `[reels-render] Stage normalization video source=${normalizationMeta.source} input=${normalizationMeta.inputWidth}x${normalizationMeta.inputHeight} frame=${normalizationMeta.frameWidth}x${normalizationMeta.frameHeight} offset=${normalizationMeta.frameOffsetX},${normalizationMeta.frameOffsetY}`
    );
  }

  const renderCommand = ffmpeg(sourcePath);
  if (trimWindow) {
    renderCommand.setStartTime(trimWindow.startSec);
    renderCommand.duration(trimWindow.durationSec);
  }
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
      '-profile:v',
      'high',
      '-level:v',
      '4.0',
      '-crf',
      '23',
      '-r',
      '30',
      '-maxrate',
      '3200k',
      '-bufsize',
      '6400k',
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
  const elapsedMs = Date.now() - startedAt;
  onRenderDiagnostics?.({
    profileVersion: REEL_RENDER_PROFILE_VERSION,
    kind: 'VIDEO',
    filterHash,
    normalization: normalizationMeta,
    encode: { ...VIDEO_ENCODE_PROFILE },
    source: {
      path: sourcePath,
      sizeBytes: sourceStat.size,
      durationSec: Number(sourceDurationSeconds.toFixed(3)),
      width: videoProbe.width,
      height: videoProbe.height,
      trimWindow: trimWindow || null,
    },
    output: {
      width: TARGET_WIDTH,
      height: TARGET_HEIGHT,
      sizeBytes: videoStat.size,
      thumbnailSizeBytes: thumbStat.size,
      elapsedMs,
    },
    overlay: {
      hasOverlay: Boolean(overlayPath),
      source: overlaySource,
    },
  });
  console.log(
    `[reels-render] video done shop=${shopId} hash=${filterHash} bytes=${videoStat.size} thumbBytes=${thumbStat.size} ms=${elapsedMs} overlay=${overlaySource}`
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
