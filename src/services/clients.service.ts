import prisma from '../../prisma/client';

const ensureLegacyUser = async (email: string, name?: string) => {
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        name: name || 'Cliente',
      },
    });
  }
  return user;
};

const listFavorites = async (userId: string) => {
  const favorites = await prisma.favorite.findMany({
    where: { userId },
    select: { shopId: true },
  });
  return favorites.map((item) => item.shopId);
};

const listReminders = async (userId: string) => {
  const reminders = await prisma.agenda.findMany({
    where: { userId },
    select: { streamId: true },
  });
  return reminders.map((item) => item.streamId);
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

export const getClientState = async (email: string, name?: string) => {
  const user = await ensureLegacyUser(email, name);
  const [favorites, reminders] = await Promise.all([
    listFavorites(user.id),
    listReminders(user.id),
  ]);
  return { favorites, reminders };
};

export const addFavorite = async (email: string, name: string | undefined, shopId: string) => {
  const user = await ensureLegacyUser(email, name);
  const existing = await prisma.favorite.findFirst({
    where: { userId: user.id, shopId },
  });
  if (!existing) {
    await prisma.favorite.create({ data: { userId: user.id, shopId } });
  }
  return listFavorites(user.id);
};

export const removeFavorite = async (email: string, name: string | undefined, shopId: string) => {
  const user = await ensureLegacyUser(email, name);
  await prisma.favorite.deleteMany({
    where: { userId: user.id, shopId },
  });
  return listFavorites(user.id);
};

export const addReminder = async (email: string, name: string | undefined, streamId: string) => {
  const user = await ensureLegacyUser(email, name);
  const existing = await prisma.agenda.findFirst({
    where: { userId: user.id, streamId },
  });
  if (!existing) {
    await prisma.agenda.create({ data: { userId: user.id, streamId } });
  }
  return listReminders(user.id);
};

export const removeReminder = async (email: string, name: string | undefined, streamId: string) => {
  const user = await ensureLegacyUser(email, name);
  await prisma.agenda.deleteMany({
    where: { userId: user.id, streamId },
  });
  return listReminders(user.id);
};
