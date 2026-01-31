import prisma from './repo';
import { updateShopAggregate } from '../../services/ratings.service';

export const getReviewsByStream = async (streamId: string) => {
  return prisma.review.findMany({
    where: { streamId },
    orderBy: { createdAt: 'desc' },
  });
};

export const createReview = async (streamId: string, data: any, userId: string) => {
  const stream = await prisma.stream.findUnique({
    where: { id: streamId },
    select: { shopId: true, status: true },
  });
  if (!stream) {
    throw new Error('Vivo no encontrado.');
  }
  if (stream.status !== 'FINISHED') {
    throw new Error('Solo puedes calificar vivos finalizados.');
  }
  const rating = Number(data?.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    throw new Error('La calificacion debe estar entre 1 y 5.');
  }
  const existingReview = await prisma.review.findFirst({
    where: { streamId, userId },
  });
  if (existingReview) {
    throw new Error('Ya calificaste este vivo.');
  }
  const review = await prisma.review.create({
    data: {
      streamId,
      shopId: stream.shopId,
      userId,
      rating,
      comment: data?.comment,
    },
  });
  await updateShopAggregate(stream.shopId);
  return review;
};

