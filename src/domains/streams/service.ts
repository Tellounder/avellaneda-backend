import {
  AuthUserStatus,
  QuotaActorType,
  QuotaDirection,
  QuotaReason,
  QuotaRefType,
  QuotaResource,
  NotificationType,
  ReportStatus,
  ShopStatus,
  SocialPlatform,
  StreamStatus,
} from '@prisma/client';
import prisma from './repo';
import { getShopRatingsMap, updateShopAggregate } from '../../services/ratings.service';
import { createQuotaTransaction, getLiveQuotaSnapshot, reserveLiveQuota } from '../../services/quota.service';
import { createNotification, notifyAdmins } from '../notifications/service';

const normalizePlatform = (value: unknown): SocialPlatform => {
  if (value === 'Instagram' || value === 'TikTok' || value === 'Facebook' || value === 'YouTube') {
    return value;
  }
  return 'Instagram';
};

const parseScheduledAt = (data: any) => {
  const raw = data.scheduledAt || data.fullDateISO || data.startTime || data.startDate;
  if (!raw) return new Date();
  const parsed = new Date(raw);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
};

const resolveHidden = (data: any) => {
  if (typeof data.hidden === 'boolean') return data.hidden;
  if (typeof data.isVisible === 'boolean') return !data.isVisible;
  return false;
};

const getTimeZoneOffset = (date: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return (asUtc - date.getTime()) / 60000;
};

const getZonedDate = (year: number, month: number, day: number, timeZone: string, hour = 0, minute = 0, second = 0) => {
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offsetMinutes = getTimeZoneOffset(utc, timeZone);
  return new Date(utc.getTime() - offsetMinutes * 60 * 1000);
};

const getDayRange = (date: Date, timeZone = 'America/Argentina/Buenos_Aires') => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const start = getZonedDate(year, month, day, timeZone, 0, 0, 0);
  const end = getZonedDate(year, month, day, timeZone, 23, 59, 59);
  end.setMilliseconds(999);
  return { start, end };
};

const clearRemindersForStream = async (streamId: string) => {
  const agendaUsers = await prisma.agenda.findMany({
    where: { streamId },
    select: { userId: true },
  });
  if (agendaUsers.length === 0) return;

  await prisma.agenda.deleteMany({ where: { streamId } });

  await prisma.notification.createMany({
    data: agendaUsers.map((entry) => ({
      userId: entry.userId,
      message: 'El vivo que agendaste fue cancelado o suspendido.',
      read: false,
      type: NotificationType.SYSTEM,
      refId: streamId,
      notifyAt: null,
    })),
  });
};

const hasSocialHandle = (handles: { platform: SocialPlatform }[], platform: SocialPlatform) =>
  handles.some((handle) => handle.platform === platform);

const validateStreamSchedule = async (data: any, excludeId?: string, client = prisma) => {
  const shopId = String(data.shopId || data.shop?.id || '');
  if (!shopId) throw new Error('Tienda invalida.');

  const shop = await client.shop.findUnique({
    where: { id: shopId },
    include: { socialHandles: true },
  });
  if (!shop) throw new Error('Tienda no encontrada.');

  if (shop.status !== ShopStatus.ACTIVE) {
    if (shop.status === ShopStatus.AGENDA_SUSPENDED) {
      if (shop.agendaSuspendedUntil && shop.agendaSuspendedUntil.getTime() <= Date.now()) {
        await client.shop.update({
          where: { id: shopId },
          data: {
            status: ShopStatus.ACTIVE,
            statusReason: null,
            statusChangedAt: new Date(),
            agendaSuspendedUntil: null,
            agendaSuspendedReason: null,
          },
        });
      } else {
        const until = shop.agendaSuspendedUntil ? new Date(shop.agendaSuspendedUntil).toISOString() : 'sin fecha';
        throw new Error(`Agenda suspendida hasta ${until}.`);
      }
    } else {
      throw new Error('La tienda no esta habilitada para agendar vivos.');
    }
  }

  const scheduledAt = parseScheduledAt(data);
  if (scheduledAt.getTime() < Date.now()) {
    throw new Error('No puedes agendar un vivo en el pasado.');
  }

  const platform = normalizePlatform(data.platform);
  if (!hasSocialHandle(shop.socialHandles, platform)) {
    throw new Error(`Configura tu usuario de ${platform} antes de agendar.`);
  }

  const { start: dayStart, end: dayEnd } = getDayRange(scheduledAt);
  const statusFilter = { in: [StreamStatus.UPCOMING, StreamStatus.LIVE, StreamStatus.PENDING_REPROGRAMMATION] };

  const dayCount = await client.stream.count({
    where: {
      shopId,
      id: excludeId ? { not: excludeId } : undefined,
      status: statusFilter,
      scheduledAt: { gte: dayStart, lte: dayEnd },
    },
  });
  if (dayCount >= 1) {
    throw new Error('Limite diario: ya tienes un vivo programado ese dia.');
  }

  const quotaSnapshot = await getLiveQuotaSnapshot(shopId, scheduledAt, client, excludeId);
  const weekCount = quotaSnapshot.weekCount;
  if (weekCount >= 7) {
    throw new Error('Limite semanal alcanzado (maximo 7 vivos).');
  }

  if (quotaSnapshot.baseRemaining <= 0 && quotaSnapshot.wallet.liveExtraBalance <= 0) {
    throw new Error('No tienes cupos disponibles para agendar.');
  }
};

export const getStreams = async () => {
  const streams = await prisma.stream.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      shop: {
        include: {
          socialHandles: true,
          whatsappLines: true,
          penalties: true,
        },
      },
    },
  });

  const ratings = await getShopRatingsMap();
  return streams.map((stream) => {
    if (!stream.shop) return stream;
    const rating = ratings.get(stream.shop.id);
    return {
      ...stream,
      shop: {
        ...stream.shop,
        ratingAverage: rating?.avg ?? 0,
        ratingCount: rating?.count ?? 0,
      },
    };
  });
};

export const getStreamById = async (id: string) => {
  const stream = await prisma.stream.findUnique({
    where: { id },
    include: {
      shop: {
        include: {
          socialHandles: true,
          whatsappLines: true,
          penalties: true,
        },
      },
    },
  });
  if (!stream || !stream.shop) {
    return stream;
  }
  const ratings = await getShopRatingsMap();
  const rating = ratings.get(stream.shop.id);
  return {
    ...stream,
    shop: {
      ...stream.shop,
      ratingAverage: rating?.avg ?? 0,
      ratingCount: rating?.count ?? 0,
    },
  };
};

export const createStream = async (data: any) => {
  const isAdminOverride = Boolean(data.isAdminOverride);
  const scheduledAt = parseScheduledAt(data);
  const platform = normalizePlatform(data.platform);
  const shopId = String(data.shopId || data.shop?.id || '');
  const scheduledEndPlanned = new Date(scheduledAt.getTime() + 30 * 60 * 1000);

  return prisma.$transaction(
    async (tx) => {
      let reservation: { useBase: boolean } | null = null;
      if (!isAdminOverride) {
        await validateStreamSchedule(data, undefined, tx);
        reservation = await reserveLiveQuota(shopId, scheduledAt, tx);
      }

    const stream = await tx.stream.create({
      data: {
        title: data.title,
        description: data.description,
        status: data.status || StreamStatus.UPCOMING,
        scheduledAt,
        scheduledEndPlanned,
        shopId,
        platform,
        url: data.url || null,
        hidden: resolveHidden(data),
        extensionCount: typeof data.extensionCount === 'number' ? data.extensionCount : 0,
        reportCount: typeof data.reportCount === 'number' ? data.reportCount : 0,
        originalScheduledAt: data.originalScheduledAt ? new Date(data.originalScheduledAt) : null,
      },
      include: {
        shop: {
          include: {
            socialHandles: true,
            whatsappLines: true,
            penalties: true,
          },
        },
      },
    });

    if (reservation) {
      await createQuotaTransaction(
        {
          shopId,
          resource: QuotaResource.LIVE,
          direction: QuotaDirection.DEBIT,
          amount: 1,
          reason: reservation.useBase ? QuotaReason.PLAN_BASE : QuotaReason.PURCHASE,
          refType: QuotaRefType.LIVE,
          refId: stream.id,
          actorType: QuotaActorType.SHOP,
          actorId: shopId,
        },
        tx
      );
    }

      return stream;
    },
    {
      maxWait: 5000,
      timeout: 15000,
    }
  );
};

export const updateStream = async (id: string, data: any) => {
  const isAdminOverride = Boolean(data.isAdminOverride);
  const scheduledAt =
    data.scheduledAt || data.fullDateISO ? parseScheduledAt(data) : undefined;

  let existing: Awaited<ReturnType<typeof prisma.stream.findUnique>> | null = null;
  if (!isAdminOverride && scheduledAt) {
    existing = await prisma.stream.findUnique({ where: { id }, include: { shop: true } });
    if (existing && ![StreamStatus.UPCOMING, StreamStatus.PENDING_REPROGRAMMATION].includes(existing.status)) {
      throw new Error('Solo puedes editar vivos programados.');
    }
    await validateStreamSchedule({ ...data, shopId: existing?.shopId }, id, prisma);
  }

  const hidden =
    typeof data.hidden === 'boolean' || typeof data.isVisible === 'boolean'
      ? resolveHidden(data)
      : undefined;

  const cleanData: any = {
    title: data.title,
    description: data.description,
    status: data.status,
    scheduledAt,
    platform: data.platform ? normalizePlatform(data.platform) : undefined,
    url: data.url,
    hidden,
    extensionCount: typeof data.extensionCount === 'number' ? data.extensionCount : undefined,
    reportCount: typeof data.reportCount === 'number' ? data.reportCount : undefined,
    startTime: data.startTime,
    endTime: data.endTime,
    cancelReason: data.cancelReason,
    cancelledAt: data.cancelledAt,
    visibilityReason: data.visibilityReason,
    reprogramReason: data.reprogramReason,
    pendingReprogramNote: data.pendingReprogramNote,
    reprogramBatchId: data.reprogramBatchId,
  };

  Object.keys(cleanData).forEach((key) => cleanData[key] === undefined && delete cleanData[key]);

  if (existing && existing.status === StreamStatus.PENDING_REPROGRAMMATION && scheduledAt && cleanData.status === undefined) {
    cleanData.status = StreamStatus.UPCOMING;
  }

  if (scheduledAt) {
    cleanData.lastEditedAt = new Date();
    cleanData.editCount = { increment: 1 };
  }

  return prisma.stream.update({
    where: { id },
    data: cleanData,
    include: {
      shop: {
        include: {
          socialHandles: true,
          whatsappLines: true,
          penalties: true,
        },
      },
    },
  });
};

export const deleteStream = async (id: string) => {
  return prisma.stream.delete({ where: { id } });
};

export const reportStream = async (streamId: string, userId: string, payload?: { reason?: string }) => {
  if (!userId) {
    throw new Error('Usuario requerido para reportar.');
  }
  const stream = await prisma.stream.findUnique({
    where: { id: streamId },
    include: { shop: true },
  });
  if (!stream) {
    throw new Error('Vivo no encontrado.');
  }
  if (stream.status !== StreamStatus.LIVE) {
    throw new Error('Solo puedes reportar vivos en vivo.');
  }

  const existingReport = await prisma.report.findFirst({
    where: { streamId, userId },
  });
  if (existingReport) {
    throw new Error('Ya reportaste este vivo.');
  }

  const reason = String(payload?.reason || '').trim() || 'Sin motivo';

  const report = await prisma.report.create({
    data: {
      streamId,
      shopId: stream.shopId,
      userId,
      reason,
      resolved: false,
      status: ReportStatus.OPEN,
    },
  });

  await prisma.stream.update({
    where: { id: streamId },
    data: { reportCount: { increment: 1 } },
  });

  await notifyAdmins(`Nuevo reporte: ${stream.title} (${stream.shop?.name || 'Sin tienda'}).`, {
    type: NotificationType.SYSTEM,
    refId: report.id,
  });

  return report;
};

export const rateStream = async (streamId: string, data: any, userId?: string) => {
  const stream = await prisma.stream.findUnique({ where: { id: streamId } });
  if (!stream) {
    throw new Error('Vivo no encontrado.');
  }
  if (stream.status !== StreamStatus.FINISHED) {
    throw new Error('Solo puedes calificar vivos finalizados.');
  }
  if (!userId) {
    throw new Error('Usuario requerido para calificar.');
  }
  const rating = Number(data?.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    throw new Error('La calificación debe estar entre 1 y 5.');
  }

  const existingReview = await prisma.review.findFirst({
    where: { streamId, userId },
  });
  if (existingReview) {
    throw new Error('Ya calificaste este vivo.');
  }

  const review = await prisma.review.create({
    data: {
      streamId,
      shopId: stream.shopId,
      userId,
      rating,
      comment: data?.comment,
    },
  });
  await updateShopAggregate(stream.shopId);
  return review;
};

export const toggleLikeStream = async (streamId: string, userId: string) => {
  const stream = await prisma.stream.findUnique({
    where: { id: streamId },
    select: { id: true, status: true, hidden: true, likes: true },
  });
  if (!stream) {
    throw new Error('Vivo no encontrado.');
  }
  if (stream.status === StreamStatus.BANNED) {
    throw new Error('No puedes interactuar con un vivo bloqueado.');
  }

  return prisma.$transaction(async (tx) => {
    const current = await tx.stream.findUnique({
      where: { id: streamId },
      select: { likes: true },
    });
    const currentLikes = current?.likes ?? 0;
    const existing = await tx.streamLike.findUnique({
      where: { streamId_userId: { streamId, userId } },
    });
    if (existing) {
      await tx.streamLike.delete({ where: { id: existing.id } });
      const nextLikes = Math.max(0, currentLikes - 1);
      const updated = await tx.stream.update({
        where: { id: streamId },
        data: { likes: nextLikes },
        select: { likes: true },
      });
      return { liked: false, likes: updated.likes };
    }

    await tx.streamLike.create({ data: { streamId, userId } });
    const updated = await tx.stream.update({
      where: { id: streamId },
      data: { likes: { increment: 1 } },
      select: { likes: true },
    });
    return { liked: true, likes: updated.likes };
  });
};

export const goLive = async (id: string) => {
  return prisma.stream.update({
    where: { id },
    data: {
      status: StreamStatus.LIVE,
      startTime: new Date(),
    },
  });
};

export const continueLive = async (id: string) => {
  const stream = await prisma.stream.findUnique({ where: { id } });
  if (!stream) return null;

  return prisma.stream.update({
    where: { id },
    data: { status: StreamStatus.LIVE },
  });
};

export const finishStream = async (id: string) => {
  return prisma.stream.update({
    where: { id },
    data: {
      status: StreamStatus.FINISHED,
      endTime: new Date(),
    },
  });
};

export const runStreamLifecycle = async () => {
  const now = new Date();
  const started = await prisma.stream.updateMany({
    where: {
      status: StreamStatus.UPCOMING,
      scheduledAt: { lte: now },
    },
    data: {
      status: StreamStatus.LIVE,
      startTime: now,
    },
  });

  const liveStreams = await prisma.stream.findMany({
    where: { status: StreamStatus.LIVE },
    select: { id: true, scheduledAt: true, startTime: true, extensionCount: true },
  });

  const toFinish = liveStreams.filter((stream) => {
    const baseStart = stream.startTime || stream.scheduledAt;
    const extension = Math.max(0, stream.extensionCount || 0);
    const durationMinutes = 30 + extension * 30;
    const endTime = new Date(baseStart.getTime() + durationMinutes * 60 * 1000);
    return endTime.getTime() <= now.getTime();
  });

  if (toFinish.length > 0) {
    await prisma.stream.updateMany({
      where: { id: { in: toFinish.map((stream) => stream.id) } },
      data: { status: StreamStatus.FINISHED, endTime: now },
    });
  }

  return { started: started.count, finished: toFinish.length };
};

export const cancelStream = async (id: string, reason?: string) => {
  const stream = await prisma.stream.findUnique({ where: { id } });
  if (!stream) {
    throw new Error('Vivo no encontrado.');
  }
  if (![StreamStatus.UPCOMING, StreamStatus.PENDING_REPROGRAMMATION].includes(stream.status)) {
    throw new Error('Solo puedes cancelar vivos programados.');
  }
  const updated = await prisma.stream.update({
    where: { id },
    data: {
      status: StreamStatus.CANCELLED,
      cancelledAt: new Date(),
      cancelReason: reason || 'Cancelado por tienda',
    },
  });
  await clearRemindersForStream(id);
  return updated;
};

export const banStream = async (id: string, reason?: string) => {
  const stream = await prisma.stream.update({
    where: { id },
    data: {
      status: StreamStatus.BANNED,
      hidden: true,
      visibilityReason: reason || 'Interrumpido por administrador',
    },
  });
  const updatedShop = await prisma.shop.update({
    where: { id: stream.shopId },
    data: {
      status: ShopStatus.BANNED,
      statusReason: reason || 'Bloqueo por moderacion',
      statusChangedAt: new Date(),
    },
  });
  if (updatedShop.authUserId) {
    await prisma.authUser.update({
      where: { id: updatedShop.authUserId },
      data: { status: AuthUserStatus.SUSPENDED },
    });
  }
  await prisma.stream.updateMany({
    where: { shopId: stream.shopId },
    data: { hidden: true },
  });
  await clearRemindersForStream(id);
  return stream;
};

export const hideStream = async (id: string) => {
  return prisma.stream.update({
    where: { id },
    data: { hidden: true },
  });
};

export const showStream = async (id: string) => {
  return prisma.stream.update({
    where: { id },
    data: { hidden: false },
  });
};


