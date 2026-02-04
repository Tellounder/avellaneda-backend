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
import { consumeCompletedJob } from '../../services/reelsMedia.service';

const normalizePlatform = (value: unknown): SocialPlatform => {
  if (value === 'Instagram' || value === 'TikTok' || value === 'Facebook' || value === 'YouTube') {
    return value;
  }
  return 'Instagram';
};

export const getActiveReels = async () => {
  const now = new Date();
  return prisma.reel.findMany({
    where: {
      hidden: false,
      status: ReelStatus.ACTIVE,
      expiresAt: { gte: now },
    },
    orderBy: { createdAt: 'desc' },
    include: { shop: true },
  });
};

export const getAllReelsAdmin = async () => {
  return prisma.reel.findMany({
    orderBy: { createdAt: 'desc' },
    include: { shop: true },
  });
};

export const getReelsByShop = async (shopId: string) => {
  return prisma.reel.findMany({
    where: { shopId },
    orderBy: { createdAt: 'desc' },
    include: { shop: true },
  });
};

export const getReelById = async (id: string) => {
  return prisma.reel.findUnique({
    where: { id },
    include: { shop: true },
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
  let status = input.status ?? ReelStatus.ACTIVE;
  let thumbnailUrl = input.thumbnailUrl || null;
  const presetLabelRaw = input.presetLabel?.trim() || '';
  const presetLabel = presetLabelRaw ? presetLabelRaw.slice(0, 48) : null;

  if (status === ReelStatus.PROCESSING && input.processingJobId) {
    const processed = consumeCompletedJob(input.processingJobId);
    if (processed) {
      status = ReelStatus.ACTIVE;
      videoUrl = processed.videoUrl;
      thumbnailUrl = processed.thumbnailUrl;
    }
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
          durationSeconds,
          status,
          expiresAt,
          platform: normalizedPlatform,
          hidden: false,
          views: 0,
          processingJobId: status === ReelStatus.ACTIVE ? null : input.processingJobId || null,
        },
        include: { shop: true },
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
    include: { shop: true },
  });
};

export const reactivateReel = async (id: string) => {
  return prisma.reel.update({
    where: { id },
    data: { hidden: false, status: ReelStatus.ACTIVE },
    include: { shop: true },
  });
};

export const deleteReel = async (id: string) => {
  return prisma.$transaction(async (tx) => {
    await tx.reelView.deleteMany({ where: { reelId: id } });
    return tx.reel.delete({
      where: { id },
      include: { shop: true },
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

