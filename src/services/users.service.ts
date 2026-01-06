import prisma from '../../prisma/client';

export const getUsers = async () => {
  return prisma.authUser.findMany({
    include: {
      favorites: { include: { shop: true } },
      agenda: { include: { stream: true } },
    },
  });
};

export const getUserById = async (id: string) => {
  return prisma.authUser.findUnique({
    where: { id },
    include: {
      favorites: { include: { shop: true } },
      agenda: { include: { stream: true } },
    },
  });
};

export const createUser = async (data: any) => {
  return prisma.authUser.create({
    data: {
      email: String(data?.email || '').trim().toLowerCase(),
      userType: data?.userType || 'CLIENT',
      status: data?.status || 'ACTIVE',
    },
  });
};

export const updateUser = async (id: string, data: any) => {
  return prisma.authUser.update({
    where: { id },
    data,
  });
};

export const addFavoriteShop = async (userId: string, shopId: string) => {
  const existing = await prisma.favorite.findFirst({ where: { userId, shopId } });
  if (!existing) {
    await prisma.favorite.create({ data: { userId, shopId } });
  }
  return prisma.authUser.findUnique({
    where: { id: userId },
    include: { favorites: { include: { shop: true } } },
  });
};

export const removeFavoriteShop = async (userId: string, shopId: string) => {
  await prisma.favorite.deleteMany({ where: { userId, shopId } });
  return prisma.authUser.findUnique({
    where: { id: userId },
    include: { favorites: { include: { shop: true } } },
  });
};

export const addToAgenda = async (userId: string, streamId: string) => {
  const existing = await prisma.agenda.findFirst({ where: { userId, streamId } });
  if (!existing) {
    await prisma.agenda.create({ data: { userId, streamId } });
  }
  return prisma.authUser.findUnique({
    where: { id: userId },
    include: { agenda: { include: { stream: true } } },
  });
};

export const removeFromAgenda = async (userId: string, streamId: string) => {
  await prisma.agenda.deleteMany({ where: { userId, streamId } });
  return prisma.authUser.findUnique({
    where: { id: userId },
    include: { agenda: { include: { stream: true } } },
  });
};
