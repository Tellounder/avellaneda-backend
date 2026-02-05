import prisma from '../../prisma/client';
import { getOrSetCache } from '../utils/publicCache';

const RATINGS_CACHE_MS = 60_000;

type RatingRow = {
  shopId: string;
  ratingAvg: number | string | null;
  ratingCount: number | string | null;
};

export const getShopRatingsMap = async () => {
  return getOrSetCache('ratings:map', RATINGS_CACHE_MS, async () => {
    const rows = (await prisma.shopAggregate.findMany({
      select: { shopId: true, ratingAvg: true, ratingCount: true },
    })) as RatingRow[];

    const map = new Map<string, { avg: number; count: number }>();
    rows.forEach((row) => {
      map.set(row.shopId, {
        avg: Number(row.ratingAvg) || 0,
        count: Number(row.ratingCount) || 0,
      });
    });

    const legacyRows = (await prisma.$queryRawUnsafe(
      'SELECT s."shopId" as "shopId", AVG(r.rating)::float as "avg", COUNT(*)::int as "count" FROM "Review" r JOIN "Stream" s ON s.id = r."streamId" GROUP BY s."shopId"'
    )) as { shopId: string; avg: number | string | null; count: number | string | null }[];

    legacyRows.forEach((row) => {
      if (!map.has(row.shopId)) {
        map.set(row.shopId, {
          avg: Number(row.avg) || 0,
          count: Number(row.count) || 0,
        });
      }
    });

    return map;
  });
};

export const updateShopAggregate = async (shopId: string) => {
  const stats = await prisma.review.aggregate({
    where: { shopId },
    _avg: { rating: true },
    _count: { _all: true },
  });

  const avg = Number(stats._avg.rating) || 0;
  const count = Number(stats._count._all) || 0;

  await prisma.shopAggregate.upsert({
    where: { shopId },
    create: { shopId, ratingAvg: avg, ratingCount: count },
    update: { ratingAvg: avg, ratingCount: count },
  });

  return { avg, count };
};
