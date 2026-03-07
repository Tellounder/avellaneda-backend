import {
  QuotaActorType,
  QuotaDirection,
  QuotaReason,
  QuotaRefType,
  QuotaResource,
  ReelStatus,
  ShopPlanTier,
  ShopStatus,
  ReelType,
  SocialPlatform,
} from '@prisma/client';
import http from 'http';
import https from 'https';
import { createHash } from 'crypto';
import prisma from './repo';
import { createQuotaTransaction, reserveReelQuota } from '../../services/quota.service';

const normalizePlatform = (value: unknown): SocialPlatform => {
  if (value === 'Instagram' || value === 'TikTok' || value === 'Facebook' || value === 'YouTube') {
    return value;
  }
  return 'Instagram';
};

const normalizePlanCode = (value: unknown) => String(value || '').trim().toUpperCase();
const isShopWithoutPlan = (shop: { plan?: unknown; planTier?: ShopPlanTier | null }) =>
  shop.planTier === ShopPlanTier.NONE ||
  normalizePlanCode(shop.plan) === 'MAP_ONLY' ||
  normalizePlanCode(shop.plan) === 'SIN_PLAN';

const SHOP_PUBLIC_SELECT = {
  id: true,
  name: true,
  slug: true,
  logoUrl: true,
  coverUrl: true,
  website: true,
  addressDetails: true,
} as const;

const REEL_BASE_SELECT = {
  id: true,
  shopId: true,
  type: true,
  videoUrl: true,
  photoUrls: true,
  thumbnailUrl: true,
  presetLabel: true,
  durationSeconds: true,
  status: true,
  platform: true,
  hidden: true,
  views: true,
  createdAt: true,
  expiresAt: true,
  shop: { select: SHOP_PUBLIC_SELECT },
} as const;

const REEL_PUBLIC_SELECT = {
  ...REEL_BASE_SELECT,
} as const;

const REEL_OWNER_SELECT = {
  ...REEL_BASE_SELECT,
  editorState: true,
  processingJobId: true,
} as const;

const REEL_PROGRESS_SELECT = {
  id: true,
  shopId: true,
  type: true,
  status: true,
  processingJobId: true,
  editorState: true,
  videoUrl: true,
  photoUrls: true,
  thumbnailUrl: true,
} as const;

type ShowcaseBucket = {
  key: string;
  minAgeHours: number;
  maxAgeHours: number | null;
};

const SHOWCASE_BUCKETS: ShowcaseBucket[] = [
  { key: 'h24', minAgeHours: 0, maxAgeHours: 24 },
  { key: 'h48', minAgeHours: 24, maxAgeHours: 48 },
  { key: 'h72', minAgeHours: 48, maxAgeHours: 72 },
  { key: 'h168', minAgeHours: 72, maxAgeHours: 168 },
  { key: 'h336', minAgeHours: 168, maxAgeHours: 336 },
  { key: 'h720', minAgeHours: 336, maxAgeHours: 720 },
  { key: 'legacy', minAgeHours: 720, maxAgeHours: null },
];

const SHOWCASE_STATUS_POOL = [ReelStatus.ACTIVE, ReelStatus.EXPIRED] as const;
const SHOWCASE_FETCH_PER_BUCKET = Math.max(
  20,
  Number(process.env.REELS_SHOWCASE_FETCH_PER_BUCKET || 120)
);

const scoreBySeed = (seed: string, reelId: string) => {
  const hash = createHash('sha1').update(`${seed}:${reelId}`).digest('hex').slice(0, 12);
  return Number.parseInt(hash, 16);
};

const sortBySeed = <T extends { id: string; createdAt: Date }>(items: T[], seed: string) =>
  [...items].sort((a, b) => {
    const scoreA = scoreBySeed(seed, a.id);
    const scoreB = scoreBySeed(seed, b.id);
    if (scoreA !== scoreB) return scoreA - scoreB;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

const buildBucketDateWhere = (now: Date, bucket: ShowcaseBucket) => {
  const dateWhere: { gte?: Date; lt?: Date } = {};
  if (bucket.maxAgeHours !== null) {
    dateWhere.gte = new Date(now.getTime() - bucket.maxAgeHours * 60 * 60 * 1000);
  }
  if (bucket.minAgeHours > 0) {
    dateWhere.lt = new Date(now.getTime() - bucket.minAgeHours * 60 * 60 * 1000);
  } else {
    dateWhere.lt = now;
  }
  return dateWhere;
};

export const getActiveReels = async (limit = 80) => {
  const now = new Date();
  return prisma.reel.findMany({
    where: {
      hidden: false,
      status: ReelStatus.ACTIVE,
      expiresAt: { gte: now },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: REEL_PUBLIC_SELECT,
  });
};

export const getShowcaseReels = async (limit = 6, rotateSeed?: string) => {
  const safeLimit = Math.min(24, Math.max(1, Number(limit) || 6));
  const now = new Date();
  const seed = String(rotateSeed || '').trim() || now.toISOString().slice(0, 13);
  const picked: Array<{
    id: string;
    shopId: string;
    type: ReelType;
    videoUrl: string | null;
    photoUrls: string[];
    thumbnailUrl: string | null;
    presetLabel: string | null;
    durationSeconds: number;
    status: ReelStatus;
    platform: SocialPlatform;
    hidden: boolean;
    views: number;
    createdAt: Date;
    expiresAt: Date;
    shop: {
      id: string;
      name: string;
      slug: string;
      logoUrl: string | null;
      coverUrl: string | null;
      website: string | null;
      addressDetails: unknown;
    } | null;
  }> = [];
  const pickedIds = new Set<string>();

  for (const bucket of SHOWCASE_BUCKETS) {
    if (picked.length >= safeLimit) break;
    const rows = await prisma.reel.findMany({
      where: {
        hidden: false,
        status: { in: [...SHOWCASE_STATUS_POOL] },
        createdAt: buildBucketDateWhere(now, bucket),
        OR: [{ videoUrl: { not: null } }, { photoUrls: { isEmpty: false } }],
      },
      orderBy: { createdAt: 'desc' },
      take: SHOWCASE_FETCH_PER_BUCKET,
      select: REEL_PUBLIC_SELECT,
    });
    if (!rows.length) continue;

    const randomized = sortBySeed(rows, `${seed}:${bucket.key}`);
    for (const reel of randomized) {
      if (picked.length >= safeLimit) break;
      if (pickedIds.has(reel.id)) continue;
      picked.push(reel);
      pickedIds.add(reel.id);
    }
  }

  if (picked.length < safeLimit) {
    const fallbackRows = await prisma.reel.findMany({
      where: {
        hidden: false,
        status: { in: [...SHOWCASE_STATUS_POOL] },
        OR: [{ videoUrl: { not: null } }, { photoUrls: { isEmpty: false } }],
      },
      orderBy: { createdAt: 'desc' },
      take: SHOWCASE_FETCH_PER_BUCKET * 2,
      select: REEL_PUBLIC_SELECT,
    });
    const randomized = sortBySeed(fallbackRows, `${seed}:fallback`);
    for (const reel of randomized) {
      if (picked.length >= safeLimit) break;
      if (pickedIds.has(reel.id)) continue;
      picked.push(reel);
      pickedIds.add(reel.id);
    }
  }

  return picked.slice(0, safeLimit);
};

export const getAllReelsAdmin = async () => {
  return prisma.reel.findMany({
    orderBy: { createdAt: 'desc' },
    select: REEL_OWNER_SELECT,
  });
};

export const getReelsByShop = async (shopId: string, limit = 120) => {
  return prisma.reel.findMany({
    where: { shopId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: REEL_OWNER_SELECT,
  });
};

export const getReelById = async (id: string) => {
  return prisma.reel.findUnique({
    where: { id },
    select: REEL_OWNER_SELECT,
  });
};

export const getReelProcessingStatus = async (id: string) => {
  return prisma.reel.findUnique({
    where: { id },
    select: REEL_PROGRESS_SELECT,
  });
};

type CreateReelInput = {
  shopId: string;
  type: ReelType;
  platform: string;
  videoUrl?: string | null;
  photoUrls?: string[];
  thumbnailUrl?: string | null;
  presetLabel?: string | null;
  editorState?: any;
  durationSeconds?: number;
  status?: ReelStatus;
  processingJobId?: string | null;
};

const normalizeReelType = (value: unknown): ReelType =>
  value === 'PHOTO_SET' ? ReelType.PHOTO_SET : ReelType.VIDEO;

const clampDuration = (value: number | undefined, fallback: number) => {
  if (!value || Number.isNaN(value)) return fallback;
  return Math.max(5, Math.min(17, Math.floor(value)));
};

const ENFORCE_SINGLE_PROCESSING_PER_SHOP =
  String(process.env.REEL_SINGLE_PROCESSING_PER_SHOP || 'true').toLowerCase() !== 'false';
const PROCESSING_STALE_MINUTES = Math.max(
  15,
  Number(process.env.REEL_PROCESSING_STALE_MINUTES || 45)
);
const MEDIA_VALIDATION_TIMEOUT_MS = Math.max(
  3_000,
  Number(process.env.REEL_MEDIA_VALIDATION_TIMEOUT_MS || 15_000)
);
const MEDIA_VALIDATION_MAX_REDIRECTS = 3;

type MediaExpectation = 'video' | 'image';

const inspectRemoteMedia = async (
  url: string,
  method: 'HEAD' | 'GET' = 'HEAD',
  redirects = 0
): Promise<{ contentType: string; contentLength: number | null }> => {
  if (redirects > MEDIA_VALIDATION_MAX_REDIRECTS) {
    throw new Error('Demasiadas redirecciones validando el archivo.');
  }
  const client = url.startsWith('https') ? https : http;

  return new Promise<{ contentType: string; contentLength: number | null }>((resolve, reject) => {
    const req = client.request(url, { method }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        inspectRemoteMedia(nextUrl, method, redirects + 1).then(resolve).catch(reject);
        return;
      }

      if (status === 405 && method === 'HEAD') {
        res.resume();
        inspectRemoteMedia(url, 'GET', redirects).then(resolve).catch(reject);
        return;
      }

      if (status >= 400) {
        res.resume();
        reject(new Error(`No se pudo validar el archivo subido (HTTP ${status}).`));
        return;
      }

      const contentType = String(res.headers['content-type'] || '').toLowerCase();
      const contentLengthRaw = res.headers['content-length'];
      const contentLength = contentLengthRaw ? Number(contentLengthRaw) : null;
      res.resume();
      resolve({
        contentType,
        contentLength: Number.isFinite(contentLength) ? contentLength : null,
      });
    });

    req.setTimeout(MEDIA_VALIDATION_TIMEOUT_MS, () => {
      req.destroy(new Error(`Timeout validando archivo (${MEDIA_VALIDATION_TIMEOUT_MS}ms).`));
    });
    req.on('error', reject);
    req.end();
  });
};

const ensureMediaUrlReady = async (url: string, expectation: MediaExpectation) => {
  const normalized = String(url || '').trim();
  if (!normalized) {
    throw new Error('Falta URL de archivo para publicar.');
  }

  let inspected: { contentType: string; contentLength: number | null };
  try {
    inspected = await inspectRemoteMedia(normalized, 'HEAD');
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : 'No se pudo validar el archivo en storage.'
    );
  }

  const expectedPrefix = expectation === 'video' ? 'video/' : 'image/';
  if (inspected.contentType && !inspected.contentType.startsWith(expectedPrefix)) {
    throw new Error(
      expectation === 'video'
        ? 'El archivo subido no es un video valido.'
        : 'El archivo subido no es una imagen valida.'
    );
  }

  if (inspected.contentLength !== null && inspected.contentLength <= 0) {
    throw new Error('El archivo subido esta vacio.');
  }
};

export const createReel = async (
  input: CreateReelInput,
  options?: { isAdminOverride?: boolean }
) => {
  const normalizedPlatform = normalizePlatform(input.platform);
  const normalizedType = normalizeReelType(input.type);
  const isAdminOverride = Boolean(options?.isAdminOverride);
  const photoUrls = Array.isArray(input.photoUrls) ? input.photoUrls.filter(Boolean) : [];
  let videoUrl = input.videoUrl?.trim() || null;
  const durationSeconds = clampDuration(input.durationSeconds, 10);
  let status = ReelStatus.PROCESSING;
  let thumbnailUrl = input.thumbnailUrl || null;
  const presetLabelRaw = input.presetLabel?.trim() || '';
  const presetLabel = presetLabelRaw ? presetLabelRaw.slice(0, 48) : null;
  const editorState = input.editorState ?? null;

  // All reels are processed by the worker before publishing.
  if (normalizedType === ReelType.VIDEO || normalizedType === ReelType.PHOTO_SET) {
    status = ReelStatus.PROCESSING;
  }

  if (normalizedType === ReelType.VIDEO && !videoUrl && status !== ReelStatus.PROCESSING) {
    throw new Error('Se requiere videoUrl para reels de video.');
  }
  if (normalizedType === ReelType.PHOTO_SET) {
    if (photoUrls.length === 0) {
      throw new Error('Se requieren fotos para reels de imagenes.');
    }
    if (photoUrls.length > 5) {
      throw new Error('Maximo 5 fotos por reel.');
    }
  }

  if (normalizedType === ReelType.VIDEO) {
    if (!videoUrl) {
      throw new Error('Se requiere videoUrl para reels de video.');
    }
    await ensureMediaUrlReady(videoUrl, 'video');
  }

  if (normalizedType === ReelType.PHOTO_SET) {
    for (const url of photoUrls) {
      await ensureMediaUrlReady(url, 'image');
    }
  }

  if (!isAdminOverride) {
    const shop = await prisma.shop.findUnique({
      where: { id: input.shopId },
      select: { id: true, active: true, status: true, plan: true, planTier: true },
    });
    if (!shop) {
      throw new Error('Tienda no encontrada.');
    }
    if (!shop.active || shop.status !== ShopStatus.ACTIVE) {
      throw new Error('La tienda no esta habilitada para publicar reels.');
    }
    if (isShopWithoutPlan(shop)) {
      throw new Error('Tu tienda esta en SIN PLAN. Asigna un plan para habilitar reels.');
    }
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return prisma.$transaction(
    async (tx) => {
      if (!isAdminOverride && ENFORCE_SINGLE_PROCESSING_PER_SHOP) {
        const staleCutoff = new Date(Date.now() - PROCESSING_STALE_MINUTES * 60_000);
        const existingProcessing = await tx.reel.findFirst({
          where: {
            shopId: input.shopId,
            hidden: false,
            status: ReelStatus.PROCESSING,
            expiresAt: { gte: new Date() },
          },
          select: { id: true, createdAt: true },
        });
        if (existingProcessing) {
          const isStale = existingProcessing.createdAt < staleCutoff;
          if (isStale) {
            await tx.reel.updateMany({
              where: {
                id: existingProcessing.id,
                shopId: input.shopId,
                status: ReelStatus.PROCESSING,
                hidden: false,
              },
              data: {
                status: ReelStatus.HIDDEN,
                hidden: true,
                processingJobId: null,
              },
            });
          } else {
            throw {
              status: 409,
              message: 'Ya tenes una historia en procesamiento. Espera que termine para publicar otra.',
            };
          }
        }
      }

      const reservation = isAdminOverride
        ? null
        : await reserveReelQuota(input.shopId, new Date(), tx);
      const reel = await tx.reel.create({
        data: {
          shopId: input.shopId,
          type: normalizedType,
          videoUrl,
          photoUrls,
          thumbnailUrl,
          presetLabel,
          editorState,
          durationSeconds,
          status,
          expiresAt,
          platform: normalizedPlatform,
          hidden: false,
          views: 0,
          processingJobId: null,
        },
        select: REEL_OWNER_SELECT,
      });

      if (reservation) {
        await createQuotaTransaction(
          {
            shopId: input.shopId,
            resource: QuotaResource.REEL,
            direction: QuotaDirection.DEBIT,
            amount: 1,
            reason: reservation.useBase ? QuotaReason.PLAN_BASE : QuotaReason.PURCHASE,
            refType: QuotaRefType.SYSTEM,
            refId: reel.id,
            actorType: QuotaActorType.SHOP,
            actorId: input.shopId,
          },
          tx
        );
      }

      return reel;
    },
    {
      maxWait: 5000,
      timeout: 15000,
    }
  );
};

export const hideReel = async (id: string) => {
  return prisma.reel.update({
    where: { id },
    data: { hidden: true, status: ReelStatus.HIDDEN },
    select: REEL_OWNER_SELECT,
  });
};

export const reactivateReel = async (id: string) => {
  return prisma.reel.update({
    where: { id },
    data: { hidden: false, status: ReelStatus.ACTIVE },
    select: REEL_OWNER_SELECT,
  });
};

export const deleteReel = async (id: string) => {
  return prisma.$transaction(async (tx) => {
    await tx.reelView.deleteMany({ where: { reelId: id } });
    return tx.reel.delete({
      where: { id },
      select: REEL_OWNER_SELECT,
    });
  });
};

export const registerView = async (id: string, userId: string) => {
  const existing = await prisma.reelView.findFirst({
    where: { reelId: id, userId },
  });
  if (existing) {
    return existing;
  }

  await prisma.reelView.create({
    data: {
      reelId: id,
      userId,
    },
  });

  await prisma.reel.update({
    where: { id },
    data: { views: { increment: 1 } },
  });

  return { reelId: id, userId };
};



