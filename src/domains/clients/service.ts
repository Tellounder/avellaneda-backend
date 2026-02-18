import {
  NotificationStatus,
  NotificationType,
  ReminderStatus,
  StreamStatus,
} from '@prisma/client';
import prisma from './repo';
import { createNotification } from '../notifications/service';

const subtractMinutes = (date: Date, minutes: number) =>
  new Date(date.getTime() - minutes * 60 * 1000);

const normalizeText = (value: unknown) => {
  const text = String(value || '').trim();
  return text.length ? text : null;
};

const normalizePhone = (value: unknown) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.replace(/\s+/g, '');
  if (!/^\+?[0-9]{8,20}$/.test(normalized)) {
    throw new Error('Telefono invalido. Usa prefijo de pais, por ejemplo +549...');
  }
  return normalized;
};

const normalizeTags = (input: unknown): string[] => {
  if (!Array.isArray(input)) return [];
  const tags = input
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 8);
  return Array.from(new Set(tags));
};

const PROFILE_REQUIRED_FIELDS = [
  { key: 'displayName', label: 'Nombre' },
  { key: 'phone', label: 'Telefono' },
  { key: 'city', label: 'Ciudad' },
  { key: 'province', label: 'Provincia' },
] as const;

const buildProfileCompletion = (profile: {
  displayName?: string | null;
  phone?: string | null;
  city?: string | null;
  province?: string | null;
  avatarUrl?: string | null;
  instagramHandle?: string | null;
}) => {
  const missingRequired = PROFILE_REQUIRED_FIELDS.filter(
    ({ key }) => !profile[key as keyof typeof profile]
  ).map(({ label }) => label);

  const optionalChecks = [profile.avatarUrl, profile.instagramHandle];
  const requiredDone = PROFILE_REQUIRED_FIELDS.length - missingRequired.length;
  const optionalDone = optionalChecks.filter(Boolean).length;
  const total = PROFILE_REQUIRED_FIELDS.length + optionalChecks.length;
  const done = requiredDone + optionalDone;
  const completionPercent = Math.max(0, Math.min(100, Math.round((done / total) * 100)));

  return {
    isComplete: missingRequired.length === 0,
    completionPercent,
    missingRequired,
  };
};

const ensureClient = async (authUserId: string) => {
  return prisma.client.upsert({
    where: { authUserId },
    update: {},
    create: { authUserId },
  });
};

const listFavorites = async (userId: string) => {
  const favorites = await prisma.favorite.findMany({
    where: { userId },
    select: { shopId: true },
  });
  return favorites.map((item) => item.shopId);
};

const listFavoriteShops = async (userId: string) => {
  const favorites = await prisma.favorite.findMany({
    where: { userId },
    orderBy: { id: 'desc' },
    include: {
      shop: {
        select: {
          id: true,
          name: true,
          logoUrl: true,
          addressDisplay: true,
          visibilityState: true,
          status: true,
        },
      },
    },
    take: 50,
  });

  return favorites.map((item) => ({
    shopId: item.shopId,
    id: item.shop.id,
    name: item.shop.name,
    logoUrl: item.shop.logoUrl,
    addressDisplay: item.shop.addressDisplay,
    visibilityState: item.shop.visibilityState,
    status: item.shop.status,
  }));
};

const listReminders = async (userId: string) => {
  const reminders = await prisma.agenda.findMany({
    where: { userId, status: ReminderStatus.ACTIVE },
    select: { streamId: true },
  });
  return reminders.map((item) => item.streamId);
};

const listReminderStreams = async (userId: string) => {
  const reminders = await prisma.agenda.findMany({
    where: { userId, status: ReminderStatus.ACTIVE },
    orderBy: { notifyAt: 'asc' },
    include: {
      stream: {
        select: {
          id: true,
          title: true,
          status: true,
          scheduledAt: true,
          shop: {
            select: {
              id: true,
              name: true,
              logoUrl: true,
            },
          },
        },
      },
    },
    take: 50,
  });

  return reminders.map((item) => ({
    streamId: item.streamId,
    id: item.stream.id,
    title: item.stream.title,
    status: item.stream.status,
    scheduledAt: item.stream.scheduledAt,
    shop: item.stream.shop,
    notifyAt: item.notifyAt,
  }));
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

export const createClient = async (
  authUserId: string,
  data: { displayName?: string; avatarUrl?: string }
) => {
  return prisma.client.upsert({
    where: { authUserId },
    update: {
      displayName: normalizeText(data.displayName) || undefined,
      avatarUrl: normalizeText(data.avatarUrl) || undefined,
      lastSeenAt: new Date(),
    },
    create: {
      authUserId,
      displayName: normalizeText(data.displayName),
      avatarUrl: normalizeText(data.avatarUrl),
      lastSeenAt: new Date(),
    },
  });
};

export const getClientState = async (authUserId: string) => {
  await ensureClient(authUserId);
  const [favorites, reminders, viewedReels, likes] = await Promise.all([
    listFavorites(authUserId),
    listReminders(authUserId),
    listReelViews(authUserId),
    listStreamLikes(authUserId),
  ]);
  return { favorites, reminders, viewedReels, likes };
};

export const getClientProfile = async (authUserId: string) => {
  const [client, authUser] = await Promise.all([
    ensureClient(authUserId),
    prisma.authUser.findUnique({
      where: { id: authUserId },
      select: { email: true },
    }),
  ]);

  const completion = buildProfileCompletion(client);

  return {
    authUserId,
    email: authUser?.email || null,
    displayName: client.displayName,
    avatarUrl: client.avatarUrl,
    phone: client.phone,
    city: client.city,
    province: client.province,
    instagramHandle: client.instagramHandle,
    birthDate: client.birthDate,
    styleTags: client.styleTags || [],
    marketingOptIn: client.marketingOptIn,
    profileCompletedAt: client.profileCompletedAt,
    completion,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
  };
};

export const updateClientProfile = async (
  authUserId: string,
  data: {
    displayName?: unknown;
    avatarUrl?: unknown;
    phone?: unknown;
    city?: unknown;
    province?: unknown;
    instagramHandle?: unknown;
    birthDate?: unknown;
    styleTags?: unknown;
    marketingOptIn?: unknown;
  }
) => {
  const payload: Record<string, any> = {};

  if (data.displayName !== undefined) {
    payload.displayName = normalizeText(data.displayName);
  }
  if (data.avatarUrl !== undefined) {
    payload.avatarUrl = normalizeText(data.avatarUrl);
  }
  if (data.phone !== undefined) {
    payload.phone = normalizePhone(data.phone);
  }
  if (data.city !== undefined) {
    payload.city = normalizeText(data.city);
  }
  if (data.province !== undefined) {
    payload.province = normalizeText(data.province);
  }
  if (data.instagramHandle !== undefined) {
    const handle = normalizeText(data.instagramHandle);
    payload.instagramHandle = handle ? handle.replace(/^@+/, '') : null;
  }
  if (data.birthDate !== undefined) {
    if (!data.birthDate) {
      payload.birthDate = null;
    } else {
      const parsed = new Date(String(data.birthDate));
      if (Number.isNaN(parsed.getTime())) {
        throw new Error('Fecha de nacimiento invalida.');
      }
      payload.birthDate = parsed;
    }
  }
  if (data.styleTags !== undefined) {
    payload.styleTags = normalizeTags(data.styleTags);
  }
  if (data.marketingOptIn !== undefined) {
    payload.marketingOptIn = Boolean(data.marketingOptIn);
  }

  const updated = await prisma.client.upsert({
    where: { authUserId },
    update: payload,
    create: {
      authUserId,
      ...payload,
    },
  });

  const completion = buildProfileCompletion(updated);
  await prisma.client.update({
    where: { authUserId },
    data: {
      profileCompletedAt: completion.isComplete ? new Date() : null,
      lastSeenAt: new Date(),
    },
  });

  return getClientProfile(authUserId);
};

export const getClientActivity = async (authUserId: string) => {
  await ensureClient(authUserId);

  const [
    profile,
    favorites,
    reminders,
    viewedReels,
    likes,
    notifications,
    unreadNotifications,
    conversations,
  ] = await Promise.all([
    getClientProfile(authUserId),
    listFavoriteShops(authUserId),
    listReminderStreams(authUserId),
    listReelViews(authUserId),
    listStreamLikes(authUserId),
    prisma.notification.findMany({
      where: { userId: authUserId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        message: true,
        type: true,
        refId: true,
        notifyAt: true,
        status: true,
        read: true,
        createdAt: true,
      },
    }),
    prisma.notification.count({
      where: {
        userId: authUserId,
        read: false,
        status: { in: [NotificationStatus.QUEUED, NotificationStatus.SENT] },
      },
    }),
    prisma.chatConversation.findMany({
      where: { clientAuthUserId: authUserId },
      orderBy: { updatedAt: 'desc' },
      take: 20,
      select: {
        id: true,
        status: true,
        updatedAt: true,
        createdAt: true,
        firstResponseSeconds: true,
        lastMessagePreview: true,
        lastClientMessageAt: true,
        lastShopMessageAt: true,
        shop: {
          select: {
            id: true,
            name: true,
            logoUrl: true,
          },
        },
      },
    }),
  ]);

  return {
    profile,
    stats: {
      favoritesCount: favorites.length,
      remindersCount: reminders.length,
      viewedReelsCount: viewedReels.length,
      likesCount: likes.length,
      unreadNotificationsCount: unreadNotifications,
      conversationsCount: conversations.length,
    },
    state: {
      favorites: favorites.map((item) => item.shopId),
      reminders: reminders.map((item) => item.streamId),
      viewedReels,
      likes,
    },
    favorites,
    reminders,
    notifications,
    conversations,
  };
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

export const getFavoriteList = async (authUserId: string) => {
  return listFavoriteShops(authUserId);
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
    ? new Date(stream.scheduledAt).toLocaleString('es-AR', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
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

export const getReminderList = async (authUserId: string) => {
  return listReminderStreams(authUserId);
};
