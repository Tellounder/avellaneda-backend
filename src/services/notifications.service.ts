import prisma from '../../prisma/client';

export const createNotification = async (userId: string, message: string) => {
  return prisma.notification.create({
    data: {
      userId,
      message,
      read: false,
    },
  });
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
