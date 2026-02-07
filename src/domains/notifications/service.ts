import {
  AuthUserStatus,
  AuthUserType,
  NotificationStatus,
  NotificationType,
  Prisma,
  ReminderStatus,
  StreamStatus,
} from '@prisma/client';
import prisma from './repo';

const addMinutes = (date: Date, minutes: number) =>
  new Date(date.getTime() + minutes * 60 * 1000);

export const getAllNotifications = async (options?: {
  limit?: number;
  unreadOnly?: boolean;
  type?: NotificationType;
}) => {
  const limit = Math.min(Math.max(Number(options?.limit || 50), 1), 200);
  const where: Record<string, any> = {};
  if (options?.unreadOnly) {
    where.read = false;
  }
  if (options?.type) {
    where.type = options.type;
  }
  return prisma.notification.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      user: {
        select: {
          id: true,
          email: true,
          userType: true,
        },
      },
    },
  });
};

export const createNotification = async (
  userId: string,
  message: string,
  options?: {
    type?: NotificationType;
    refId?: string | null;
    notifyAt?: Date | null;
    status?: NotificationStatus;
    payload?: Prisma.InputJsonValue | null;
  }
) => {
  return prisma.notification.create({
    data: {
      userId,
      message,
      read: false,
      type: options?.type ?? NotificationType.SYSTEM,
      refId: options?.refId ?? null,
      notifyAt: options?.notifyAt ?? null,
      status: options?.status ?? NotificationStatus.QUEUED,
      sentAt:
        options?.status === NotificationStatus.SENT ? new Date() : null,
      payload: options?.payload ?? undefined,
    },
  });
};

export const notifyAdmins = async (
  message: string,
  options?: { type?: NotificationType; refId?: string | null; notifyAt?: Date | null }
) => {
  const admins = await prisma.authUser.findMany({
    where: { userType: AuthUserType.ADMIN, status: AuthUserStatus.ACTIVE },
    select: { id: true },
  });
  if (!admins.length) {
    return { created: 0 };
  }
  await prisma.notification.createMany({
    data: admins.map((admin) => ({
      userId: admin.id,
      message,
      read: false,
      type: options?.type ?? NotificationType.SYSTEM,
      refId: options?.refId ?? null,
      notifyAt: options?.notifyAt ?? null,
      status: NotificationStatus.QUEUED,
    })),
  });
  return { created: admins.length };
};

export const getNotificationsByUser = async (userId: string) => {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
};

export const getNotificationById = async (id: string) => {
  return prisma.notification.findUnique({
    where: { id },
  });
};

export const markAsRead = async (id: string) => {
  return prisma.notification.update({
    where: { id },
    data: { read: true },
  });
};

export const markAllAsRead = async (userId: string) => {
  return prisma.notification.updateMany({
    where: { userId, read: false },
    data: { read: true },
  });
};

export const runReminderNotifications = async (minutesAhead: number = 15) => {
  const now = new Date();
  const cutoff = addMinutes(now, minutesAhead);
  const agenda = await prisma.agenda.findMany({
    where: {
      status: ReminderStatus.ACTIVE,
      stream: {
        status: StreamStatus.UPCOMING,
        scheduledAt: { gt: now, lte: cutoff },
      },
    },
    include: {
      stream: true,
    },
  });

  let created = 0;
  let skipped = 0;

  for (const item of agenda) {
    const stream = item.stream;
    if (!stream) {
      skipped += 1;
      continue;
    }

    const timeLabel = new Date(stream.scheduledAt).toLocaleTimeString('es-AR', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const dateLabel = new Date(stream.scheduledAt).toLocaleDateString('es-AR', {
      day: '2-digit',
      month: 'short',
    });
    const message = `Recordatorio: ${stream.title} hoy ${dateLabel} ${timeLabel} hs.`;

    const existing = await prisma.notification.findFirst({
      where: {
        userId: item.userId,
        type: NotificationType.REMINDER,
        refId: stream.id,
      },
    });
    if (existing) {
      if (existing.status === NotificationStatus.QUEUED) {
        await prisma.notification.update({
          where: { id: existing.id },
          data: { status: NotificationStatus.SENT, sentAt: new Date() },
        });
        created += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    await createNotification(item.userId, message, {
      type: NotificationType.REMINDER,
      refId: stream.id,
      notifyAt: addMinutes(stream.scheduledAt, -minutesAhead),
      status: NotificationStatus.SENT,
    });
    created += 1;
  }

  return { created, skipped, windowMinutes: minutesAhead };
};
