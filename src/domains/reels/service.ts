import {
  QuotaActorType,
  QuotaDirection,
  QuotaReason,
  QuotaRefType,
  QuotaResource,
  ReelStatus,
  ReelType,
  SocialPlatform,
} from '@prisma/client';
import prisma from './repo';
import { createQuotaTransaction, reserveReelQuota } from '../../services/quota.service';

const normalizePlatform = (value: unknown): SocialPlatform => {
  if (value === 'Instagram' || value === 'TikTok' || value === 'Facebook' || value === 'YouTube') {
    return value;
  }
  return 'Instagram';
};

const SHOP_PUBLIC_SELECT = {
  id: true,
  name: true,
  slug: true,
  logoUrl: true,
  coverUrl: true,
  website: true,
  address: true,
  addressDetails: true,
  socialHandles: true,
  whatsappLines: true,
  plan: true,
} as const;

const REEL_PUBLIC_SELECT = {
  id: true,
  shopId: true,
  type: true,
  videoUrl: true,
  photoUrls: true,
  thumbnailUrl: true,
  presetLabel: true,
  editorState: true,
  durationSeconds: true,
  status: true,
  processingJobId: true,
  platform: true,
  hidden: true,
  views: true,
  createdAt: true,
  expiresAt: true,
  shop: { select: SHOP_PUBLIC_SELECT },
} as const;

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

export const getAllReelsAdmin = async () => {
  return prisma.reel.findMany({
    orderBy: { createdAt: 'desc' },
    select: REEL_PUBLIC_SELECT,
  });
};

export const getReelsByShop = async (shopId: string, limit = 120) => {
  return prisma.reel.findMany({
    where: { shopId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: REEL_PUBLIC_SELECT,
  });
};

export const getReelById = async (id: string) => {
  return prisma.reel.findUnique({
    where: { id },
    select: REEL_PUBLIC_SELECT,
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
  return Math.max(5, Math.min(10, Math.floor(value)));
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

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return prisma.$transaction(
    async (tx) => {
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
        select: REEL_PUBLIC_SELECT,
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
    select: REEL_PUBLIC_SELECT,
  });
};

export const reactivateReel = async (id: string) => {
  return prisma.reel.update({
    where: { id },
    data: { hidden: false, status: ReelStatus.ACTIVE },
    select: REEL_PUBLIC_SELECT,
  });
};

export const deleteReel = async (id: string) => {
  return prisma.$transaction(async (tx) => {
    await tx.reelView.deleteMany({ where: { reelId: id } });
    return tx.reel.delete({
      where: { id },
      select: REEL_PUBLIC_SELECT,
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



