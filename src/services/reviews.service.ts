import prisma from '../../prisma/client';

export const getReviewsByStream = async (streamId: string) => {
  return prisma.review.findMany({
    where: { streamId },
    orderBy: { createdAt: 'desc' },
  });
};

export const createReview = async (streamId: string, data: any, userId: string) => {
  const rating = Number(data?.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    throw new Error('La calificación debe estar entre 1 y 5.');
  }
  const existingReview = await prisma.review.findFirst({
    where: { streamId, userId },
  });
  if (existingReview) {
    throw new Error('Ya calificaste este vivo.');
  }
  return prisma.review.create({
    data: {
      streamId,
      userId,
      rating,
      comment: data?.comment,
    },
  });
};
