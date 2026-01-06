import prisma from '../../prisma/client';

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
