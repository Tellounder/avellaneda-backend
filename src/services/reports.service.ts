import { ReportStatus } from '@prisma/client';
import prisma from '../../prisma/client';

export const reportStream = async (streamId: string, userId: string) => {
  if (!userId) {
    throw new Error('Usuario requerido para reportar.');
  }
  const existing = await prisma.report.findFirst({
    where: { streamId, userId },
  });
  if (existing) {
    throw new Error('Ya reportaste este vivo.');
  }
  return prisma.report.create({
    data: {
      streamId,
      userId,
      reason: 'Inappropriate content',
      resolved: false,
      status: ReportStatus.OPEN,
    },
  });
};

export const getReports = async () => {
  return prisma.report.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      stream: {
        include: {
          shop: true,
        },
      },
    },
  });
};

export const resolveReport = async (id: string) => {
  return prisma.report.update({
    where: { id },
    data: { resolved: true, status: ReportStatus.VALIDATED },
  });
};

export const rejectReport = async (id: string) => {
  return prisma.report.update({
    where: { id },
    data: { resolved: true, status: ReportStatus.REJECTED },
  });
};
