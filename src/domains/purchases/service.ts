import { NotificationType, PurchaseStatus, PurchaseType, QuotaActorType, QuotaRefType } from '@prisma/client';
import prisma from './repo';
import { creditLiveExtra, creditReelExtra, syncQuotaWalletToPlan } from '../../services/quota.service';
import { createNotification } from '../notifications/service';
import { isUpgradeAllowed, resolvePlanCode } from '../shops/plan';

const parsePlanUpgradeTarget = (notes?: string | null) => {
  if (!notes) return null;
  const trimmed = notes.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.plan) return resolvePlanCode(parsed.plan);
    } catch {
      return null;
    }
  }
  if (trimmed.toUpperCase().startsWith('PLAN:')) {
    return resolvePlanCode(trimmed.split(':').slice(1).join(':').trim());
  }
  return resolvePlanCode(trimmed);
};

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
  const updated = await prisma.$transaction(async (tx) => {
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
    } else if (purchase.type === PurchaseType.PLAN_UPGRADE) {
      const targetPlan = parsePlanUpgradeTarget(purchase.notes);
      if (!targetPlan) {
        throw new Error('Plan objetivo no especificado.');
      }
      const shop = await tx.shop.findUnique({ where: { id: purchase.shopId }, select: { plan: true } });
      if (!shop) {
        throw new Error('Tienda no encontrada.');
      }
      if (!isUpgradeAllowed(shop.plan, targetPlan)) {
        throw new Error('El plan solicitado no es un upgrade valido.');
      }
      await tx.shop.update({ where: { id: purchase.shopId }, data: { plan: targetPlan } });
      await syncQuotaWalletToPlan(purchase.shopId, targetPlan, tx);
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

  if (updated.shop?.authUserId) {
    const message =
      updated.type === PurchaseType.PLAN_UPGRADE
        ? 'Tu plan fue actualizado correctamente.'
        : `Tu compra fue aprobada (${updated.quantity} cupos).`;
    await createNotification(updated.shop.authUserId, message, {
      type: NotificationType.PURCHASE,
      refId: updated.purchaseId,
    });
  }

  return updated;
};

export const rejectPurchase = async (purchaseId: string, adminId: string, notes?: string) => {
  const updated = await prisma.purchaseRequest.update({
    where: { purchaseId },
    data: {
      status: PurchaseStatus.REJECTED,
      approvedByAdminId: adminId,
      approvedAt: new Date(),
      notes: notes || null,
    },
    include: { shop: true },
  });

  if (updated.shop?.authUserId) {
    await createNotification(updated.shop.authUserId, 'Tu compra fue rechazada. Revisá el detalle en el panel.', {
      type: NotificationType.PURCHASE,
      refId: updated.purchaseId,
    });
  }

  return updated;
};


