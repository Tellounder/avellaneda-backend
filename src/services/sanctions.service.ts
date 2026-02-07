import {
  AuditEntityType,
  LiveScheduleAction,
  Prisma,
  PrismaClient,
  QuotaActorType,
  QuotaDirection,
  QuotaReason,
  QuotaRefType,
  QuotaResource,
  ReportStatus,
  ShopStatus,
  StreamStatus,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import prisma from '../../prisma/client';
import { createQuotaTransaction } from './quota.service';

const REPORT_THRESHOLD = 5;
const REPORT_GRACE_MINUTES = 6;
const REPROGRAM_DAYS = 7;
const RESOLUTION_WINDOW_HOURS = 48;

type PrismaClientLike = Prisma.TransactionClient | PrismaClient;

const addMinutes = (date: Date, minutes: number) =>
  new Date(date.getTime() + minutes * 60 * 1000);

const addHours = (date: Date, hours: number) =>
  new Date(date.getTime() + hours * 60 * 60 * 1000);

const addDays = (date: Date, days: number) =>
  new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

const getDayRange = (date: Date) => {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

const getSuspensionDays = (plan: string | null | undefined) => {
  const key = String(plan || '').toLowerCase();
  if (key.includes('maxima') || key.includes('pro')) {
    return 4;
  }
  return 7;
};

const SANCTION_BLOCKED_STATUSES: StreamStatus[] = [
  StreamStatus.MISSED,
  StreamStatus.BANNED,
  StreamStatus.CANCELLED,
];

const isSanctionBlocked = (status: StreamStatus) => SANCTION_BLOCKED_STATUSES.includes(status);

const createAuditLog = async (
  data: {
    action: string;
    entityType: AuditEntityType;
    entityId?: string | null;
    meta?: Prisma.InputJsonValue;
  },
  client: PrismaClientLike = prisma
) => {
  return client.auditLog.create({
    data: {
      actorType: QuotaActorType.SYSTEM,
      actorId: null,
      action: data.action,
      entityType: data.entityType,
      entityId: data.entityId || null,
      meta: data.meta ?? undefined,
    },
  });
};

const countValidatedReports = async (
  streamId: string,
  validFrom: Date,
  client: PrismaClientLike = prisma
) => {
  return client.report.count({
    where: {
      streamId,
      status: ReportStatus.VALIDATED,
      createdAt: { gte: validFrom },
    },
  });
};

const ensureMissedBurn = async (
  shopId: string,
  streamId: string,
  client: PrismaClientLike = prisma
) => {
  const existing = await client.quotaTransaction.findFirst({
    where: {
      shopId,
      reason: QuotaReason.MISSED_BURN,
      refType: QuotaRefType.LIVE,
      refId: streamId,
    },
  });
  if (existing) {
    return false;
  }
  await createQuotaTransaction(
    {
      shopId,
      resource: QuotaResource.LIVE,
      direction: QuotaDirection.DEBIT,
      amount: 1,
      reason: QuotaReason.MISSED_BURN,
      refType: QuotaRefType.LIVE,
      refId: streamId,
      actorType: QuotaActorType.SYSTEM,
      actorId: null,
    },
    client
  );
  return true;
};

const reprogramUpcomingLives = async (
  shopId: string,
  suspendedUntil: Date,
  client: PrismaClientLike = prisma
) => {
  const batchId = randomUUID();
  const now = new Date();
  const upcoming = await client.stream.findMany({
    where: {
      shopId,
      status: StreamStatus.UPCOMING,
      scheduledAt: { gte: now, lte: suspendedUntil },
    },
  });

  let reprogrammed = 0;
  let pending = 0;

  for (const stream of upcoming) {
    const targetDate = addDays(stream.scheduledAt, REPROGRAM_DAYS);
    const { start, end } = getDayRange(targetDate);
    const conflict = await client.stream.findFirst({
      where: {
        shopId,
        id: { not: stream.id },
        status: {
          in: [StreamStatus.UPCOMING, StreamStatus.LIVE, StreamStatus.PENDING_REPROGRAMMATION],
        },
        scheduledAt: { gte: start, lte: end },
      },
    });

    const baseData = {
      reprogramReason: 'Sancion de agenda',
      reprogramBatchId: batchId,
      originalScheduledAt: stream.originalScheduledAt || stream.scheduledAt,
    };

    if (conflict) {
      await client.stream.update({
        where: { id: stream.id },
        data: {
          status: StreamStatus.PENDING_REPROGRAMMATION,
          pendingReprogramNote: 'Conflicto de agenda por sancion',
          ...baseData,
        },
      });

      await client.liveScheduleEvent.create({
        data: {
          liveId: stream.id,
          shopId,
          action: LiveScheduleAction.SET_PENDING_REPROGRAM,
          fromScheduledAt: stream.scheduledAt,
          toScheduledAt: targetDate,
          reason: 'Sancion de agenda',
          actorType: QuotaActorType.SYSTEM,
          actorId: null,
        },
      });

      await createAuditLog(
        {
          action: 'LIVE_PENDING_REPROGRAM',
          entityType: AuditEntityType.LIVE,
          entityId: stream.id,
          meta: { reason: 'Sancion de agenda', batchId },
        },
        client
      );

      pending += 1;
      continue;
    }

    await client.stream.update({
      where: { id: stream.id },
      data: {
        scheduledAt: targetDate,
        pendingReprogramNote: null,
        ...baseData,
      },
    });

    await client.liveScheduleEvent.create({
      data: {
        liveId: stream.id,
        shopId,
        action: LiveScheduleAction.AUTO_REPROGRAM,
        fromScheduledAt: stream.scheduledAt,
        toScheduledAt: targetDate,
        reason: 'Sancion de agenda',
        actorType: QuotaActorType.SYSTEM,
        actorId: null,
      },
    });

    await createAuditLog(
      {
        action: 'LIVE_REPROGRAMMED',
        entityType: AuditEntityType.LIVE,
        entityId: stream.id,
        meta: { reason: 'Sancion de agenda', batchId },
      },
      client
    );

    reprogrammed += 1;
  }

  return { reprogrammed, pending };
};

const processSanctionForLive = async (streamId: string) => {
  const now = new Date();

  const client = prisma;
  const stream = await client.stream.findUnique({
    where: { id: streamId },
    include: { shop: true },
  });
  if (!stream || !stream.shop) {
    return { skipped: true };
  }
  if (stream.status !== StreamStatus.LIVE) {
    return { skipped: true };
  }
  if (isSanctionBlocked(stream.status)) {
    return { skipped: true };
  }

  const referenceTime = stream.startTime || stream.scheduledAt;
  const validFrom = addMinutes(referenceTime, REPORT_GRACE_MINUTES);
  const validatedReports = await countValidatedReports(stream.id, validFrom, client);
  if (validatedReports < REPORT_THRESHOLD) {
    return { skipped: true };
  }

  await client.stream.update({
    where: { id: stream.id },
    data: {
      status: StreamStatus.MISSED,
      hidden: true,
      endTime: now,
      visibilityReason: 'Reportes validados',
    },
  });

  await client.liveScheduleEvent.create({
    data: {
      liveId: stream.id,
      shopId: stream.shopId,
      action: LiveScheduleAction.AUTO_FINISH,
      fromScheduledAt: stream.scheduledAt,
      toScheduledAt: now,
      reason: 'Reportes validados',
      actorType: QuotaActorType.SYSTEM,
      actorId: null,
    },
  });

  await createAuditLog(
    {
      action: 'LIVE_MARKED_MISSED',
      entityType: AuditEntityType.LIVE,
      entityId: stream.id,
      meta: { reason: 'Reportes validados', reportCount: validatedReports },
    },
    client
  );

  const suspensionDays = getSuspensionDays(stream.shop.plan);
  let suspension = await client.agendaSuspension.findFirst({
    where: {
      shopId: stream.shopId,
      endAt: { gt: now },
    },
    orderBy: { endAt: 'desc' },
  });

  if (!suspension) {
    const endAt = addDays(now, suspensionDays);
    suspension = await client.agendaSuspension.create({
      data: {
        shopId: stream.shopId,
        startAt: now,
        endAt,
        reason: 'Reportes validados',
        createdByAdminId: null,
      },
    });

    await createAuditLog(
      {
        action: 'AGENDA_SUSPENDED',
        entityType: AuditEntityType.SUSPENSION,
        entityId: suspension.suspensionId,
        meta: { shopId: stream.shopId, endAt: suspension.endAt.toISOString() },
      },
      client
    );
  }

  if (
    stream.shop.status !== ShopStatus.AGENDA_SUSPENDED ||
    !stream.shop.agendaSuspendedUntil ||
    stream.shop.agendaSuspendedUntil.getTime() < suspension.endAt.getTime()
  ) {
    await client.shop.update({
      where: { id: stream.shopId },
      data: {
        status: ShopStatus.AGENDA_SUSPENDED,
        statusChangedAt: now,
        agendaSuspendedUntil: suspension.endAt,
        agendaSuspendedReason: 'Reportes validados',
      },
    });
  }

  const burned = await ensureMissedBurn(stream.shopId, stream.id, client);
  if (burned) {
    await createAuditLog(
      {
        action: 'QUOTA_MISSED_BURN',
        entityType: AuditEntityType.LIVE,
        entityId: stream.id,
        meta: { shopId: stream.shopId },
      },
      client
    );
  }

  const reprogramResult = await reprogramUpcomingLives(stream.shopId, suspension.endAt, client);

  return {
    sanctioned: true,
    reprogrammed: reprogramResult.reprogrammed,
    pending: reprogramResult.pending,
    suspensionId: suspension.suspensionId,
    burnCreated: burned,
  };
};

const processPendingReprogramTimeouts = async () => {
  const now = new Date();
  const pendingStreams = await prisma.stream.findMany({
    where: { status: StreamStatus.PENDING_REPROGRAMMATION },
    include: { shop: true },
  });

  let expired = 0;
  for (const stream of pendingStreams) {
    if (!stream.shop || stream.shop.status !== ShopStatus.ACTIVE) {
      continue;
    }
    if (stream.shop.agendaSuspendedUntil && stream.shop.agendaSuspendedUntil.getTime() > now.getTime()) {
      continue;
    }
    if (!stream.shop.statusChangedAt) {
      continue;
    }

    const deadline = addHours(stream.shop.statusChangedAt, RESOLUTION_WINDOW_HOURS);
    if (now.getTime() <= deadline.getTime()) {
      continue;
    }

    await prisma.stream.update({
      where: { id: stream.id },
      data: {
        status: StreamStatus.MISSED,
        hidden: true,
        endTime: now,
        visibilityReason: 'Reprogramacion no resuelta',
      },
    });

    await prisma.liveScheduleEvent.create({
      data: {
        liveId: stream.id,
        shopId: stream.shopId,
        action: LiveScheduleAction.AUTO_FINISH,
        fromScheduledAt: stream.scheduledAt,
        toScheduledAt: now,
        reason: 'Reprogramacion no resuelta',
        actorType: QuotaActorType.SYSTEM,
        actorId: null,
      },
    });

    await ensureMissedBurn(stream.shopId, stream.id, prisma);

    await createAuditLog(
      {
        action: 'LIVE_MISSED_AFTER_PENDING',
        entityType: AuditEntityType.LIVE,
        entityId: stream.id,
        meta: { shopId: stream.shopId },
      },
      prisma
    );

    expired += 1;
  }

  return expired;
};

export const runSanctionsEngine = async () => {
  const candidates = await prisma.stream.findMany({
    where: { status: StreamStatus.LIVE },
    select: { id: true, startTime: true, scheduledAt: true },
  });

  let sanctioned = 0;
  let skipped = 0;
  let reprogrammed = 0;
  let pending = 0;
  const details: Array<{ streamId: string; result: string }> = [];

  for (const candidate of candidates) {
    const startTime = candidate.startTime || candidate.scheduledAt;
    const validFrom = addMinutes(startTime, REPORT_GRACE_MINUTES);
    const validatedReports = await countValidatedReports(candidate.id, validFrom);
    if (validatedReports < REPORT_THRESHOLD) {
      skipped += 1;
      details.push({ streamId: candidate.id, result: 'threshold_not_met' });
      continue;
    }

    const result = await processSanctionForLive(candidate.id);
    if (result?.sanctioned) {
      sanctioned += 1;
      reprogrammed += result.reprogrammed || 0;
      pending += result.pending || 0;
      details.push({ streamId: candidate.id, result: 'sanctioned' });
    } else {
      skipped += 1;
      details.push({ streamId: candidate.id, result: 'skipped' });
    }
  }

  const expiredPending = await processPendingReprogramTimeouts();

  return {
    candidates: candidates.length,
    sanctioned,
    skipped,
    reprogrammed,
    pending,
    pendingExpired: expiredPending,
    details,
  };
};
