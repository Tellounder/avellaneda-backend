import {
  QuotaActorType,
  QuotaDirection,
  QuotaReason,
  QuotaRefType,
  QuotaResource,
  SocialPlatform,
} from '@prisma/client';
import prisma from '../../prisma/client';
import { createQuotaTransaction, reserveReelQuota } from './quota.service';

const normalizePlatform = (value: unknown): SocialPlatform => {
  if (value === 'Instagram' || value === 'TikTok' || value === 'Facebook' || value === 'YouTube') {
    return value;
  }
  return 'Instagram';
};

export const getActiveReels = async () => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return prisma.reel.findMany({
    where: {
      hidden: false,
      createdAt: { gte: cutoff },
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

export const createReel = async (shopId: string, url: string, platform: string) => {
  const normalizedPlatform = normalizePlatform(platform);
  return prisma.$transaction(async (tx) => {
    const reservation = await reserveReelQuota(shopId, new Date(), tx);
    const reel = await tx.reel.create({
      data: {
        shopId,
        url,
        platform: normalizedPlatform,
        hidden: false,
        views: 0,
      },
      include: { shop: true },
    });

    await createQuotaTransaction(
      {
        shopId,
        resource: QuotaResource.REEL,
        direction: QuotaDirection.DEBIT,
        amount: 1,
        reason: reservation.useBase ? QuotaReason.PLAN_BASE : QuotaReason.PURCHASE,
        refType: QuotaRefType.SYSTEM,
        refId: reel.id,
        actorType: QuotaActorType.SHOP,
        actorId: shopId,
      },
      tx
    );

    return reel;
  });
};

export const hideReel = async (id: string) => {
  return prisma.reel.update({
    where: { id },
    data: { hidden: true },
    include: { shop: true },
  });
};

export const reactivateReel = async (id: string) => {
  return prisma.reel.update({
    where: { id },
    data: { hidden: false },
    include: { shop: true },
  });
};

export const registerView = async (id: string) => {
  return prisma.reel.update({
    where: { id },
    data: { views: { increment: 1 } },
  });
};
