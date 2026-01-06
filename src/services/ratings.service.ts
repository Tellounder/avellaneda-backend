import prisma from '../../prisma/client';

type RatingRow = {
  shopId: string;
  avg: number | string | null;
  count: number | string | null;
};

export const getShopRatingsMap = async () => {
  const rows = (await prisma.$queryRawUnsafe(
    'SELECT s."shopId" as "shopId", AVG(r.rating)::float as "avg", COUNT(*)::int as "count" FROM "Review" r JOIN "Stream" s ON s.id = r."streamId" GROUP BY s."shopId"'
  )) as RatingRow[];

  const map = new Map<string, { avg: number; count: number }>();
  rows.forEach((row) => {
    map.set(row.shopId, {
      avg: Number(row.avg) || 0,
      count: Number(row.count) || 0,
    });
  });

  return map;
};
