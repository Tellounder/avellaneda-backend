import prisma from '../../prisma/client';

export const getAgendaByUser = async (userId: string) => {
  return prisma.authUser.findUnique({
    where: { id: userId },
    include: {
      agenda: {
        include: { stream: true },
      },
    },
  });
};

export const addToAgenda = async (userId: string, streamId: string) => {
  return prisma.authUser.update({
    where: { id: userId },
    data: {
      agenda: {
        create: {
          stream: {
            connect: { id: streamId },
          },
        },
      },
    },
  });
};

export const removeFromAgenda = async (userId: string, streamId: string) => {
  return prisma.authUser.update({
    where: { id: userId },
    data: {
      agenda: {
        deleteMany: {
          streamId: streamId,
        },
      },
    },
  });
};
