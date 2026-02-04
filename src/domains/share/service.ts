import prisma from '../../prisma/client';

export const getReelShareData = async (id: string) => {
  return prisma.reel.findUnique({
    where: { id },
    include: { shop: true },
  });
};

export const getStreamShareData = async (id: string) => {
  return prisma.stream.findUnique({
    where: { id },
    include: { shop: true },
  });
};
