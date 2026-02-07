import {
  AuditEntityType,
  AuthUserStatus,
  AuthUserType,
  LiveScheduleAction,
  QuotaReason,
  ReportStatus,
  ShopStatus,
  StreamStatus,
} from '@prisma/client';
import prisma from '../src/prisma/client';
import { runSanctionsEngine } from '../src/services/sanctions.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const assertOrThrow = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

const getExpectedSuspensionDays = (plan: string | null | undefined) => {
  const normalized = String(plan || '').trim().toLowerCase();
  if (normalized.includes('maxima') || normalized === 'pro') return 4;
  return 7;
};

const approxDays = (start: Date, end: Date) => (end.getTime() - start.getTime()) / DAY_MS;

const run = async () => {
  if (process.env.QA_STEP7_CONFIRM !== 'YES') {
    throw new Error('Debes ejecutar con QA_STEP7_CONFIRM=YES para correr este QA.');
  }

  const tag = `QA_STEP7_${Date.now()}`;
  const createdUserIds: string[] = [];
  const createdStreamIds: string[] = [];
  let qaShopId: string | null = null;
  let summary: Record<string, unknown> = {};

  try {
    const qaShop = await prisma.shop.create({
      data: {
        name: `${tag}_SHOP`,
        slug: `${tag.toLowerCase()}-shop`,
        paymentMethods: [],
        plan: 'PRO',
        status: ShopStatus.ACTIVE,
        active: true,
        streamQuota: 3,
        reelQuota: 5,
      },
    });
    qaShopId = qaShop.id;

    for (let i = 1; i <= 5; i += 1) {
      const authUser = await prisma.authUser.create({
        data: {
          email: `${tag.toLowerCase()}_user${i}@qa.local`,
          userType: AuthUserType.CLIENT,
          status: AuthUserStatus.ACTIVE,
        },
      });
      createdUserIds.push(authUser.id);
    }

    const now = new Date();
    const liveStart = new Date(now.getTime() - 7 * 60 * 1000);
    const liveScheduled = new Date(now.getTime() - 10 * 60 * 1000);

    const targetLive = await prisma.stream.create({
      data: {
        shopId: qaShop.id,
        title: `${tag}_LIVE_TARGET`,
        status: StreamStatus.LIVE,
        scheduledAt: liveScheduled,
        startTime: liveStart,
        platform: 'Instagram',
        url: 'https://example.com/live-target',
      },
    });
    createdStreamIds.push(targetLive.id);

    const upcomingForPending = await prisma.stream.create({
      data: {
        shopId: qaShop.id,
        title: `${tag}_UPCOMING_PENDING`,
        status: StreamStatus.UPCOMING,
        scheduledAt: addDays(now, 1),
        platform: 'Instagram',
        url: 'https://example.com/upcoming-pending',
      },
    });
    createdStreamIds.push(upcomingForPending.id);

    const conflictStream = await prisma.stream.create({
      data: {
        shopId: qaShop.id,
        title: `${tag}_CONFLICT_STREAM`,
        status: StreamStatus.UPCOMING,
        scheduledAt: addDays(upcomingForPending.scheduledAt, 7),
        platform: 'Instagram',
        url: 'https://example.com/conflict',
      },
    });
    createdStreamIds.push(conflictStream.id);

    const upcomingForReprogram = await prisma.stream.create({
      data: {
        shopId: qaShop.id,
        title: `${tag}_UPCOMING_REPROGRAM`,
        status: StreamStatus.UPCOMING,
        scheduledAt: addDays(now, 2),
        platform: 'Instagram',
        url: 'https://example.com/upcoming-reprogram',
      },
    });
    createdStreamIds.push(upcomingForReprogram.id);

    const reportCreatedAt = new Date(liveStart.getTime() + 7 * 60 * 1000);
    for (const userId of createdUserIds) {
      await prisma.report.create({
        data: {
          streamId: targetLive.id,
          shopId: qaShop.id,
          userId,
          reason: `${tag}_VALIDATED_REPORT`,
          status: ReportStatus.VALIDATED,
          resolved: false,
          createdAt: reportCreatedAt,
        },
      });
    }
    await prisma.stream.update({
      where: { id: targetLive.id },
      data: { reportCount: 5 },
    });

    const engineRun1 = await runSanctionsEngine();

    const sanitizedLive = await prisma.stream.findUnique({ where: { id: targetLive.id } });
    assertOrThrow(sanitizedLive, 'No se encontro el live target luego de ejecutar sanciones.');
    assertOrThrow(sanitizedLive?.status === StreamStatus.MISSED, 'El live no paso a MISSED.');
    assertOrThrow(sanitizedLive?.hidden === true, 'El live no quedo oculto.');
    assertOrThrow(Boolean(sanitizedLive?.endTime), 'El live MISSED no tiene endTime.');

    const suspension = await prisma.agendaSuspension.findFirst({
      where: { shopId: qaShop.id },
      orderBy: { createdAt: 'desc' },
    });
    assertOrThrow(suspension, 'No se creo AgendaSuspension.');
    const expectedDays = getExpectedSuspensionDays(qaShop.plan);
    const suspensionDays = suspension ? approxDays(suspension.startAt, suspension.endAt) : 0;
    assertOrThrow(
      suspensionDays >= expectedDays - 0.5 && suspensionDays <= expectedDays + 0.5,
      `AgendaSuspension fuera de rango esperado. Esperado ~${expectedDays}, obtenido ${suspensionDays.toFixed(2)}.`
    );

    const missedBurnTarget = await prisma.quotaTransaction.findFirst({
      where: {
        shopId: qaShop.id,
        reason: QuotaReason.MISSED_BURN,
        refId: targetLive.id,
      },
    });
    assertOrThrow(missedBurnTarget, 'No se creo QuotaTransaction MISSED_BURN del live sancionado.');

    const autoFinishEvent = await prisma.liveScheduleEvent.findFirst({
      where: { liveId: targetLive.id, action: LiveScheduleAction.AUTO_FINISH },
    });
    assertOrThrow(autoFinishEvent, 'No se creo LiveScheduleEvent AUTO_FINISH.');

    const pendingAfterRun1 = await prisma.stream.findUnique({ where: { id: upcomingForPending.id } });
    const reprogramAfterRun1 = await prisma.stream.findUnique({ where: { id: upcomingForReprogram.id } });
    assertOrThrow(
      pendingAfterRun1?.status === StreamStatus.PENDING_REPROGRAMMATION,
      'El vivo en conflicto no quedo en PENDING_REPROGRAMMATION.'
    );
    assertOrThrow(
      reprogramAfterRun1?.scheduledAt &&
        Math.abs(reprogramAfterRun1.scheduledAt.getTime() - addDays(upcomingForReprogram.scheduledAt, 7).getTime()) <
          60_000,
      'El vivo sin conflicto no fue reprogramado +7 dias.'
    );

    await prisma.shop.update({
      where: { id: qaShop.id },
      data: {
        status: ShopStatus.ACTIVE,
        statusChangedAt: new Date(Date.now() - 49 * HOUR_MS),
        agendaSuspendedUntil: null,
        agendaSuspendedReason: null,
      },
    });

    const engineRun2 = await runSanctionsEngine();

    const pendingAfterTimeout = await prisma.stream.findUnique({ where: { id: upcomingForPending.id } });
    assertOrThrow(
      pendingAfterTimeout?.status === StreamStatus.MISSED,
      'El PENDING_REPROGRAMMATION no paso a MISSED luego de 48h.'
    );

    const missedBurnPending = await prisma.quotaTransaction.findFirst({
      where: {
        shopId: qaShop.id,
        reason: QuotaReason.MISSED_BURN,
        refId: upcomingForPending.id,
      },
    });
    assertOrThrow(missedBurnPending, 'No se creo MISSED_BURN para el vivo expirado de PENDING.');

    const auditMarkedMissed = await prisma.auditLog.findFirst({
      where: {
        entityType: AuditEntityType.LIVE,
        entityId: targetLive.id,
        action: 'LIVE_MARKED_MISSED',
      },
    });
    assertOrThrow(auditMarkedMissed, 'No se encontro AuditLog LIVE_MARKED_MISSED.');

    summary = {
      tag,
      shopId: qaShop.id,
      streamTargetId: targetLive.id,
      streamPendingId: upcomingForPending.id,
      streamReprogramId: upcomingForReprogram.id,
      engineRun1,
      engineRun2,
      suspensionDays: Number(suspensionDays.toFixed(2)),
    };

    console.log('[QA_STEP7] OK', JSON.stringify(summary, null, 2));
  } finally {
    if (qaShopId) {
      await prisma.report.deleteMany({ where: { streamId: { in: createdStreamIds } } });
      await prisma.liveScheduleEvent.deleteMany({ where: { liveId: { in: createdStreamIds } } });
      await prisma.streamLike.deleteMany({ where: { streamId: { in: createdStreamIds } } });
      await prisma.review.deleteMany({ where: { streamId: { in: createdStreamIds } } });
      await prisma.agenda.deleteMany({ where: { streamId: { in: createdStreamIds } } });
      await prisma.stream.deleteMany({ where: { id: { in: createdStreamIds } } });

      await prisma.agendaSuspension.deleteMany({ where: { shopId: qaShopId } });
      await prisma.purchaseRequest.deleteMany({ where: { shopId: qaShopId } });
      await prisma.quotaTransaction.deleteMany({ where: { shopId: qaShopId } });
      await prisma.quotaWallet.deleteMany({ where: { shopId: qaShopId } });
      await prisma.shopSocialHandle.deleteMany({ where: { shopId: qaShopId } });
      await prisma.shopWhatsappLine.deleteMany({ where: { shopId: qaShopId } });
      await prisma.favorite.deleteMany({ where: { shopId: qaShopId } });
      await prisma.shopAggregate.deleteMany({ where: { shopId: qaShopId } });
      await prisma.penalty.deleteMany({ where: { shopId: qaShopId } });
      await prisma.shop.deleteMany({ where: { id: qaShopId } });
    }

    if (createdUserIds.length > 0) {
      await prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.favorite.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.review.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.report.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.streamLike.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.reelView.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.agenda.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.client.deleteMany({ where: { authUserId: { in: createdUserIds } } });
      await prisma.authUser.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  }
};

run()
  .catch((error) => {
    console.error('[QA_STEP7] ERROR', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
