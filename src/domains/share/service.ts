import prisma from '../../prisma/client';

export const getReelShareData = async (id: string) => {
  return prisma.reel.findUnique({
    where: { id },
    include: { shop: true },
  });
};
