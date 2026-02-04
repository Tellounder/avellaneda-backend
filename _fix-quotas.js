const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const normalizePlanKey = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

const resolvePlanLimits = (plan) => {
  const key = normalizePlanKey(plan);
  const liveMap = {
    estandar: 0,
    standard: 0,
    basic: 0,
    alta: 1,
    'alta visibilidad': 1,
    premium: 1,
    maxima: 3,
    'maxima visibilidad': 3,
    pro: 3,
  };
  const reelMap = {
    estandar: 1,
    standard: 1,
    basic: 1,
    alta: 3,
    'alta visibilidad': 3,
    premium: 3,
    maxima: 5,
    'maxima visibilidad': 5,
    pro: 5,
  };
  if (liveMap[key] !== undefined && reelMap[key] !== undefined) {
    return { weeklyLiveBaseLimit: liveMap[key], reelDailyLimit: reelMap[key] };
  }
  if (key.includes('maxima') || key === 'pro') return { weeklyLiveBaseLimit: 3, reelDailyLimit: 5 };
  if (key.includes('alta') || key.includes('premium')) return { weeklyLiveBaseLimit: 1, reelDailyLimit: 3 };
  return { weeklyLiveBaseLimit: 0, reelDailyLimit: 1 };
};

const pad2 = (value) => String(value).padStart(2, '0');
const formatDateKey = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const getWeekStart = (date) => {
  const start = new Date(date);
  const day = start.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diff);
  start.setHours(0, 0, 0, 0);
  return start;
};

const getWeekKey = (date) => formatDateKey(getWeekStart(date));

const getDayRange = (date) => {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

const getWeekRange = (date) => {
  const start = getWeekStart(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  end.setMilliseconds(end.getMilliseconds() - 1);
  return { start, end };
};

(async () => {
  const now = new Date();
  const weekKey = getWeekKey(now);
  const dayKey = formatDateKey(now);
  const { start: weekStart, end: weekEnd } = getWeekRange(now);
  const { start: dayStart, end: dayEnd } = getDayRange(now);

  const [shops, weekCounts, dayCounts] = await Promise.all([
    prisma.shop.findMany({
      select: {
        id: true,
        name: true,
        plan: true,
        streamQuota: true,
        reelQuota: true,
      },
    }),
    prisma.stream.groupBy({
      by: ['shopId'],
      _count: { _all: true },
      where: {
        status: { in: ['UPCOMING', 'LIVE', 'PENDING_REPROGRAMMATION'] },
        scheduledAt: { gte: weekStart, lte: weekEnd },
      },
    }),
    prisma.reel.groupBy({
      by: ['shopId'],
      _count: { _all: true },
      where: {
        createdAt: { gte: dayStart, lte: dayEnd },
      },
    }),
  ]);

  const weekCountByShop = new Map(weekCounts.map((row) => [row.shopId, row._count._all]));
  const dayCountByShop = new Map(dayCounts.map((row) => [row.shopId, row._count._all]));

  const summary = {
    total: shops.length,
    createdWallet: 0,
    updatedWallet: 0,
    updatedLegacy: 0,
  };

  for (const shop of shops) {
    const limits = resolvePlanLimits(shop.plan);
    const baseLive = limits.weeklyLiveBaseLimit;
    const baseReel = limits.reelDailyLimit;

    const desiredStreamTotal = Math.max(baseLive, Number(shop.streamQuota || 0));
    const desiredReelTotal = Math.max(baseReel, Number(shop.reelQuota || 0));

    const wallet = await prisma.quotaWallet.findUnique({ where: { shopId: shop.id } });

    if (!wallet) {
      await prisma.quotaWallet.create({
        data: {
          shopId: shop.id,
          weeklyLiveBaseLimit: baseLive,
          weeklyLiveUsed: 0,
          weeklyLiveWeekKey: weekKey,
          liveExtraBalance: Math.max(0, desiredStreamTotal - baseLive),
          reelDailyLimit: baseReel,
          reelDailyUsed: 0,
          reelDailyDateKey: dayKey,
          reelExtraBalance: Math.max(0, desiredReelTotal - baseReel),
        },
      });
      summary.createdWallet += 1;
    }

    const refreshed = await prisma.quotaWallet.findUnique({ where: { shopId: shop.id } });
    if (!refreshed) continue;

    const updateWallet = {};
    if (refreshed.weeklyLiveBaseLimit !== baseLive) updateWallet.weeklyLiveBaseLimit = baseLive;
    if (refreshed.reelDailyLimit !== baseReel) updateWallet.reelDailyLimit = baseReel;
    if (refreshed.weeklyLiveWeekKey !== weekKey) updateWallet.weeklyLiveWeekKey = weekKey;
    if (refreshed.reelDailyDateKey !== dayKey) updateWallet.reelDailyDateKey = dayKey;

    const weekCount = weekCountByShop.get(shop.id) || 0;
    const dayCount = dayCountByShop.get(shop.id) || 0;
    const nextWeeklyUsed = Math.min(weekCount, baseLive);
    const nextDailyUsed = Math.min(dayCount, baseReel);

    if (refreshed.weeklyLiveUsed !== nextWeeklyUsed) updateWallet.weeklyLiveUsed = nextWeeklyUsed;
    if (refreshed.reelDailyUsed !== nextDailyUsed) updateWallet.reelDailyUsed = nextDailyUsed;

    if (Object.keys(updateWallet).length > 0) {
      await prisma.quotaWallet.update({ where: { shopId: shop.id }, data: updateWallet });
      summary.updatedWallet += 1;
    }

    const liveExtra = refreshed.liveExtraBalance || 0;
    const reelExtra = refreshed.reelExtraBalance || 0;
    const baseRemaining = Math.max(0, baseLive - nextWeeklyUsed);
    const reelRemaining = Math.max(0, baseReel - nextDailyUsed);
    const nextStreamQuota = baseRemaining + liveExtra;
    const nextReelQuota = reelRemaining + reelExtra;

    if (shop.streamQuota !== nextStreamQuota || shop.reelQuota !== nextReelQuota) {
      await prisma.shop.update({
        where: { id: shop.id },
        data: { streamQuota: nextStreamQuota, reelQuota: nextReelQuota },
      });
      summary.updatedLegacy += 1;
    }
  }

  console.log('Audit + fix finished:', summary);
})();
