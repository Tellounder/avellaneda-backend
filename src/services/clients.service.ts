import { NotificationStatus, NotificationType, ReminderStatus, StreamStatus } from '@prisma/client';
import prisma from '../../prisma/client';
import { createNotification } from './notifications.service';

const subtractMinutes = (date: Date, minutes: number) =>
  new Date(date.getTime() - minutes * 60 * 1000);

const listFavorites = async (userId: string) => {
  const favorites = await prisma.favorite.findMany({
    where: { userId },
    select: { shopId: true },
  });
  return favorites.map((item) => item.shopId);
};

const listReminders = async (userId: string) => {
  const reminders = await prisma.agenda.findMany({
    where: { userId, status: ReminderStatus.ACTIVE },
    select: { streamId: true },
  });
  return reminders.map((item) => item.streamId);
};

const listReelViews = async (userId: string) => {
  const views = await prisma.reelView.findMany({
    where: { userId },
    select: { reelId: true },
  });
  return views.map((item) => item.reelId);
};

const listStreamLikes = async (userId: string) => {
  const likes = await prisma.streamLike.findMany({
    where: { userId },
    select: { streamId: true },
  });
  return likes.map((item) => item.streamId);
};

export const createClient = async (authUserId: string, data: { displayName?: string; avatarUrl?: string }) => {
  return prisma.client.upsert({
    where: { authUserId },
    update: {
      displayName: data.displayName,
      avatarUrl: data.avatarUrl,
    },
    create: {
      authUserId,
      displayName: data.displayName,
      avatarUrl: data.avatarUrl,
    },
  });
};

export const getClientState = async (authUserId: string) => {
  const [favorites, reminders, viewedReels, likes] = await Promise.all([
    listFavorites(authUserId),
    listReminders(authUserId),
    listReelViews(authUserId),
    listStreamLikes(authUserId),
  ]);
  return { favorites, reminders, viewedReels, likes };
};

export const addFavorite = async (authUserId: string, shopId: string) => {
  const existing = await prisma.favorite.findFirst({
    where: { userId: authUserId, shopId },
  });
  if (!existing) {
    await prisma.favorite.create({ data: { userId: authUserId, shopId } });
  }
  return listFavorites(authUserId);
};

export const removeFavorite = async (authUserId: string, shopId: string) => {
  await prisma.favorite.deleteMany({
    where: { userId: authUserId, shopId },
  });
  return listFavorites(authUserId);
};

export const addReminder = async (authUserId: string, streamId: string) => {
  const stream = await prisma.stream.findUnique({
    where: { id: streamId },
    select: { id: true, title: true, scheduledAt: true, status: true },
  });
  if (!stream) {
    throw new Error('Vivo no encontrado.');
  }
  if (stream.status !== StreamStatus.UPCOMING) {
    throw new Error('Solo puedes agendar recordatorios de vivos programados.');
  }
  const notifyAt = stream.scheduledAt ? subtractMinutes(new Date(stream.scheduledAt), 15) : null;
  const existing = await prisma.agenda.findFirst({
    where: { userId: authUserId, streamId },
  });
  if (!existing) {
    await prisma.agenda.create({
      data: {
        userId: authUserId,
        streamId,
        status: ReminderStatus.ACTIVE,
        notifyAt,
      },
    });
  } else if (existing.status !== ReminderStatus.ACTIVE) {
    await prisma.agenda.update({
      where: { id: existing.id },
      data: { status: ReminderStatus.ACTIVE, notifyAt },
    });
  }

  const dateLabel = stream.scheduledAt
    ? new Date(stream.scheduledAt).toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' })
    : 'fecha pendiente';
  const existingNotification = await prisma.notification.findFirst({
    where: {
      userId: authUserId,
      type: NotificationType.REMINDER,
      refId: stream.id,
      status: NotificationStatus.QUEUED,
    },
  });
  if (!existingNotification) {
    await createNotification(authUserId, `Recordatorio activo: ${stream.title} (${dateLabel}).`, {
      type: NotificationType.REMINDER,
      refId: stream.id,
      notifyAt,
      status: NotificationStatus.QUEUED,
    });
  }
  return listReminders(authUserId);
};

export const removeReminder = async (authUserId: string, streamId: string) => {
  await prisma.agenda.updateMany({
    where: { userId: authUserId, streamId },
    data: { status: ReminderStatus.CANCELED },
  });
  await prisma.notification.updateMany({
    where: {
      userId: authUserId,
      type: NotificationType.REMINDER,
      refId: streamId,
      status: { in: [NotificationStatus.QUEUED, NotificationStatus.SENT] },
    },
    data: { status: NotificationStatus.CANCELED },
  });
  return listReminders(authUserId);
};
