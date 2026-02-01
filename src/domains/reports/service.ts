import { ReportStatus } from '@prisma/client';
import prisma from './repo';

export const reportStream = async (streamId: string, userId: string, reason?: string) => {
  if (!userId) {
    throw new Error('Usuario requerido para reportar.');
  }
  const stream = await prisma.stream.findUnique({
    where: { id: streamId },
    select: { shopId: true, status: true },
  });
  if (!stream) {
    throw new Error('Vivo no encontrado.');
  }
  if (stream.status !== 'LIVE') {
    throw new Error('Solo puedes reportar vivos en vivo.');
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
      shopId: stream.shopId,
      userId,
      reason: reason?.trim() || 'Sin motivo',
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

export const resolveReport = async (id: string, reviewedByAdminId?: string) => {
  return prisma.report.update({
    where: { id },
    data: {
      resolved: true,
      status: ReportStatus.VALIDATED,
      reviewedByAdminId: reviewedByAdminId || null,
      reviewedAt: new Date(),
    },
  });
};

export const rejectReport = async (id: string, reviewedByAdminId?: string) => {
  return prisma.report.update({
    where: { id },
    data: {
      resolved: true,
      status: ReportStatus.REJECTED,
      reviewedByAdminId: reviewedByAdminId || null,
      reviewedAt: new Date(),
    },
  });
};
