import { PurchaseStatus, PurchaseType, QuotaActorType, QuotaRefType } from '@prisma/client';
import prisma from '../../prisma/client';
import { creditLiveExtra, creditReelExtra } from './quota.service';

export const getPurchases = async (status?: PurchaseStatus) => {
  return prisma.purchaseRequest.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
    include: {
      shop: true,
      approvedByAdmin: true,
    },
  });
};

export const getPurchasesByShop = async (shopId: string, status?: PurchaseStatus) => {
  return prisma.purchaseRequest.findMany({
    where: {
      shopId,
      ...(status ? { status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    include: {
      approvedByAdmin: true,
    },
  });
};

export const approvePurchase = async (purchaseId: string, adminId: string) => {
  return prisma.$transaction(async (tx) => {
    const purchase = await tx.purchaseRequest.findUnique({ where: { purchaseId } });
    if (!purchase) {
      throw new Error('Solicitud no encontrada.');
    }
    if (purchase.status !== PurchaseStatus.PENDING) {
      throw new Error('La solicitud ya fue procesada.');
    }

    if (purchase.type === PurchaseType.LIVE_PACK) {
      await creditLiveExtra(purchase.shopId, purchase.quantity, tx, {
        refType: QuotaRefType.PURCHASE,
        refId: purchase.purchaseId,
        actorType: QuotaActorType.ADMIN,
        actorId: adminId,
      });
    } else if (purchase.type === PurchaseType.REEL_PACK) {
      await creditReelExtra(purchase.shopId, purchase.quantity, tx, {
        refType: QuotaRefType.PURCHASE,
        refId: purchase.purchaseId,
        actorType: QuotaActorType.ADMIN,
        actorId: adminId,
      });
    }

    return tx.purchaseRequest.update({
      where: { purchaseId },
      data: {
        status: PurchaseStatus.APPROVED,
        approvedAt: new Date(),
        approvedByAdminId: adminId,
      },
      include: { shop: true },
    });
  });
};

export const rejectPurchase = async (purchaseId: string, adminId: string, notes?: string) => {
  return prisma.purchaseRequest.update({
    where: { purchaseId },
    data: {
      status: PurchaseStatus.REJECTED,
      approvedByAdminId: adminId,
      approvedAt: new Date(),
      notes: notes || null,
    },
    include: { shop: true },
  });
};
