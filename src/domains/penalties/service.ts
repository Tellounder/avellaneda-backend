import prisma from './repo';

export const getPenalties = async () => {
  return prisma.penalty.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      shop: true,
    },
  });
};

export const applyPenalty = async (shopId: string, reason: string = 'Manual penalty') => {
  return prisma.penalty.create({
    data: {
      shopId,
      reason,
      active: true,
    },
  });
};

export const removePenalty = async (shopId: string) => {
  return prisma.penalty.updateMany({
    where: { shopId, active: true },
    data: { active: false },
  });
};
