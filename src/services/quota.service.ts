import {
  Prisma,
  PrismaClient,
  QuotaActorType,
  QuotaDirection,
  QuotaReason,
  QuotaRefType,
  QuotaResource,
  ShopStatus,
  StreamStatus,
} from '@prisma/client';
import prisma from '../../prisma/client';

type PrismaClientLike = Prisma.TransactionClient | PrismaClient;

const LIVE_BASE_LIMITS: Record<string, number> = {
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

const REEL_DAILY_LIMITS: Record<string, number> = {
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

const normalizePlanKey = (plan: string | null | undefined) => String(plan || '').trim().toLowerCase();

const resolvePlanLimits = (plan: string | null | undefined) => {
  const key = normalizePlanKey(plan);
  if (LIVE_BASE_LIMITS[key] !== undefined && REEL_DAILY_LIMITS[key] !== undefined) {
    return {
      weeklyLiveBaseLimit: LIVE_BASE_LIMITS[key],
      reelDailyLimit: REEL_DAILY_LIMITS[key],
    };
  }
  if (key.includes('maxima') || key === 'pro') {
    return { weeklyLiveBaseLimit: 3, reelDailyLimit: 5 };
  }
  if (key.includes('alta') || key.includes('premium')) {
    return { weeklyLiveBaseLimit: 1, reelDailyLimit: 3 };
  }
  return { weeklyLiveBaseLimit: 0, reelDailyLimit: 1 };
};

const pad2 = (value: number) => String(value).padStart(2, '0');

const formatDateKey = (date: Date) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const getWeekStart = (date: Date) => {
  const start = new Date(date);
  const day = start.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diff);
  start.setHours(0, 0, 0, 0);
  return start;
};

const getWeekKey = (date: Date) => formatDateKey(getWeekStart(date));

const getDayRange = (date: Date) => {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

const getWeekRange = (date: Date) => {
  const start = getWeekStart(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  end.setMilliseconds(end.getMilliseconds() - 1);
  return { start, end };
};

const ensureQuotaWallet = async (
  shop: { id: string; plan: string | null },
  client: PrismaClientLike,
  liveDate: Date,
  reelDate: Date
) => {
  const existing = await client.quotaWallet.findUnique({ where: { shopId: shop.id } });
  if (existing) return existing;

  const limits = resolvePlanLimits(shop.plan);
  return client.quotaWallet.create({
    data: {
      shopId: shop.id,
      weeklyLiveBaseLimit: limits.weeklyLiveBaseLimit,
      weeklyLiveUsed: 0,
      weeklyLiveWeekKey: getWeekKey(liveDate),
      liveExtraBalance: 0,
      reelDailyLimit: limits.reelDailyLimit,
      reelDailyUsed: 0,
      reelDailyDateKey: formatDateKey(reelDate),
      reelExtraBalance: 0,
    },
  });
};

const updateQuotaWallet = async (
  shopId: string,
  data: Prisma.QuotaWalletUpdateInput,
  client: PrismaClientLike
) => {
  if (Object.keys(data).length === 0) {
    return client.quotaWallet.findUnique({ where: { shopId } });
  }
  return client.quotaWallet.update({ where: { shopId }, data });
};

export const buildWalletFromLegacy = (
  plan: string | null,
  streamQuota: number | null,
  reelQuota: number | null,
  now: Date
) => {
  const limits = resolvePlanLimits(plan);
  const safeStreamQuota = Math.max(0, Number(streamQuota || 0));
  const safeReelQuota = Math.max(0, Number(reelQuota || 0));

  const liveBaseRemaining = Math.min(safeStreamQuota, limits.weeklyLiveBaseLimit);
  const liveExtraBalance = Math.max(0, safeStreamQuota - limits.weeklyLiveBaseLimit);
  const weeklyLiveUsed = Math.max(0, limits.weeklyLiveBaseLimit - liveBaseRemaining);

  const reelBaseRemaining = Math.min(safeReelQuota, limits.reelDailyLimit);
  const reelExtraBalance = Math.max(0, safeReelQuota - limits.reelDailyLimit);
  const reelDailyUsed = Math.max(0, limits.reelDailyLimit - reelBaseRemaining);

  return {
    walletData: {
      weeklyLiveBaseLimit: limits.weeklyLiveBaseLimit,
      weeklyLiveUsed,
      weeklyLiveWeekKey: getWeekKey(now),
      liveExtraBalance,
      reelDailyLimit: limits.reelDailyLimit,
      reelDailyUsed,
      reelDailyDateKey: formatDateKey(now),
      reelExtraBalance,
    },
    legacyTotals: {
      streamQuota: liveBaseRemaining + liveExtraBalance,
      reelQuota: reelBaseRemaining + reelExtraBalance,
    },
    extraBalances: {
      liveExtraBalance,
      reelExtraBalance,
    },
  };
};

export const createQuotaWalletFromLegacy = async (
  shop: { id: string; plan: string | null; streamQuota: number | null; reelQuota: number | null },
  client: PrismaClientLike,
  now = new Date()
) => {
  const computed = buildWalletFromLegacy(shop.plan, shop.streamQuota, shop.reelQuota, now);
  await client.quotaWallet.create({
    data: {
      shopId: shop.id,
      ...computed.walletData,
    },
  });
  await client.shop.update({
    where: { id: shop.id },
    data: computed.legacyTotals,
  });
  return computed.extraBalances;
};

export const backfillQuotaWallets = async (options?: { batchSize?: number; now?: Date }) => {
  const batchSize = Math.max(1, Number(options?.batchSize || process.env.QUOTA_WALLET_FIX_BATCH || 25));
  const now = options?.now || new Date();

  const shops = await prisma.shop.findMany({
    where: { quotaWallet: { is: null } },
    select: { id: true, plan: true, streamQuota: true, reelQuota: true },
    take: batchSize,
  });

  let created = 0;
  for (const shop of shops) {
    try {
      await prisma.$transaction(async (tx) => {
        const existing = await tx.quotaWallet.findUnique({ where: { shopId: shop.id } });
        if (existing) return;
        await createQuotaWalletFromLegacy(shop, tx, now);
      });
      created += 1;
    } catch (error) {
      console.error('[quota-wallet-backfill] Error creando wallet para', shop.id, error);
    }
  }

  return { scanned: shops.length, created };
};

export const syncQuotaWalletToPlan = async (
  shopId: string,
  plan: string | null,
  client: PrismaClientLike = prisma
) => {
  const limits = resolvePlanLimits(plan);
  const wallet = await client.quotaWallet.findUnique({ where: { shopId } });
  if (!wallet) {
    const shop = await client.shop.findUnique({
      where: { id: shopId },
      select: { id: true, plan: true, streamQuota: true, reelQuota: true },
    });
    if (shop) {
      await createQuotaWalletFromLegacy(shop, client, new Date());
    }
    return null;
  }

  const nextWeeklyUsed = Math.min(wallet.weeklyLiveUsed, limits.weeklyLiveBaseLimit);
  const nextReelUsed = Math.min(wallet.reelDailyUsed, limits.reelDailyLimit);

  return client.quotaWallet.update({
    where: { shopId },
    data: {
      weeklyLiveBaseLimit: limits.weeklyLiveBaseLimit,
      weeklyLiveUsed: nextWeeklyUsed,
      reelDailyLimit: limits.reelDailyLimit,
      reelDailyUsed: nextReelUsed,
    },
  });
};

export const getLiveQuotaSnapshot = async (
  shopId: string,
  scheduledAt: Date,
  client: PrismaClientLike = prisma,
  excludeStreamId?: string
) => {
  const shop = await client.shop.findUnique({
    where: { id: shopId },
    select: { id: true, plan: true },
  });
  if (!shop) {
    throw new Error('Tienda no encontrada.');
  }

  let wallet = await ensureQuotaWallet(shop, client, scheduledAt, new Date());
  const weekKey = getWeekKey(scheduledAt);
  const limits = resolvePlanLimits(shop.plan);

  const updateData: Prisma.QuotaWalletUpdateInput = {};
  let baseLimit = wallet.weeklyLiveBaseLimit;

  if (wallet.weeklyLiveWeekKey !== weekKey) {
    baseLimit = limits.weeklyLiveBaseLimit;
    updateData.weeklyLiveWeekKey = weekKey;
    updateData.weeklyLiveBaseLimit = baseLimit;
    updateData.weeklyLiveUsed = 0;
  }

  const { start, end } = getWeekRange(scheduledAt);
  const weekCount = await client.stream.count({
    where: {
      shopId,
      id: excludeStreamId ? { not: excludeStreamId } : undefined,
      status: { in: [StreamStatus.UPCOMING, StreamStatus.LIVE, StreamStatus.PENDING_REPROGRAMMATION] },
      scheduledAt: { gte: start, lte: end },
    },
  });

  const nextWeeklyUsed = Math.min(weekCount, baseLimit);
  if (wallet.weeklyLiveUsed !== nextWeeklyUsed) {
    updateData.weeklyLiveUsed = nextWeeklyUsed;
  }

  wallet = (await updateQuotaWallet(shopId, updateData, client)) || wallet;

  const baseRemaining = Math.max(0, baseLimit - weekCount);

  return {
    shop,
    wallet,
    weekCount,
    baseLimit,
    baseRemaining,
  };
};

export const getReelQuotaSnapshot = async (
  shopId: string,
  date: Date,
  client: PrismaClientLike = prisma
) => {
  const shop = await client.shop.findUnique({
    where: { id: shopId },
    select: { id: true, plan: true },
  });
  if (!shop) {
    throw new Error('Tienda no encontrada.');
  }

  let wallet = await ensureQuotaWallet(shop, client, new Date(), date);
  const dayKey = formatDateKey(date);
  const limits = resolvePlanLimits(shop.plan);

  const updateData: Prisma.QuotaWalletUpdateInput = {};
  let dailyLimit = wallet.reelDailyLimit;

  if (wallet.reelDailyDateKey !== dayKey) {
    dailyLimit = limits.reelDailyLimit;
    updateData.reelDailyDateKey = dayKey;
    updateData.reelDailyLimit = dailyLimit;
    updateData.reelDailyUsed = 0;
  }

  const { start, end } = getDayRange(date);
  const dailyCount = await client.reel.count({
    where: {
      shopId,
      createdAt: { gte: start, lte: end },
    },
  });

  const nextDailyUsed = Math.min(dailyCount, dailyLimit);
  if (wallet.reelDailyUsed !== nextDailyUsed) {
    updateData.reelDailyUsed = nextDailyUsed;
  }

  wallet = (await updateQuotaWallet(shopId, updateData, client)) || wallet;

  const baseRemaining = Math.max(0, dailyLimit - dailyCount);

  return {
    shop,
    wallet,
    dailyCount,
    dailyLimit,
    baseRemaining,
  };
};

export const reserveLiveQuota = async (
  shopId: string,
  scheduledAt: Date,
  client: PrismaClientLike = prisma
) => {
  const snapshot = await getLiveQuotaSnapshot(shopId, scheduledAt, client);
  const useBase = snapshot.baseRemaining > 0;
  if (!useBase && snapshot.wallet.liveExtraBalance <= 0) {
    throw new Error('No tienes cupos disponibles para agendar.');
  }

  const nextWeeklyUsed = Math.min(snapshot.baseLimit, snapshot.weekCount + (useBase ? 1 : 0));
  const nextExtraBalance = snapshot.wallet.liveExtraBalance - (useBase ? 0 : 1);
  const baseRemainingNext = Math.max(0, snapshot.baseLimit - (snapshot.weekCount + (useBase ? 1 : 0)));
  const nextStreamQuota = baseRemainingNext + nextExtraBalance;

  await client.quotaWallet.update({
    where: { shopId },
    data: {
      weeklyLiveUsed: nextWeeklyUsed,
      liveExtraBalance: nextExtraBalance,
    },
  });

  await client.shop.update({
    where: { id: shopId },
    data: { streamQuota: nextStreamQuota },
  });

  return { useBase };
};

export const reserveReelQuota = async (
  shopId: string,
  createdAt: Date,
  client: PrismaClientLike = prisma
) => {
  const snapshot = await getReelQuotaSnapshot(shopId, createdAt, client);
  const useBase = snapshot.baseRemaining > 0;
  if (!useBase && snapshot.wallet.reelExtraBalance <= 0) {
    throw new Error('No tienes cupos disponibles para reels.');
  }

  const nextDailyUsed = Math.min(snapshot.dailyLimit, snapshot.dailyCount + (useBase ? 1 : 0));
  const nextExtraBalance = snapshot.wallet.reelExtraBalance - (useBase ? 0 : 1);
  const baseRemainingNext = Math.max(0, snapshot.dailyLimit - (snapshot.dailyCount + (useBase ? 1 : 0)));
  const nextReelQuota = baseRemainingNext + nextExtraBalance;

  await client.quotaWallet.update({
    where: { shopId },
    data: {
      reelDailyUsed: nextDailyUsed,
      reelExtraBalance: nextExtraBalance,
    },
  });

  await client.shop.update({
    where: { id: shopId },
    data: { reelQuota: nextReelQuota },
  });

  return { useBase };
};

export const createQuotaTransaction = async (
  data: {
    shopId: string;
    resource: QuotaResource;
    direction: QuotaDirection;
    amount: number;
    reason: QuotaReason;
    refType?: QuotaRefType | null;
    refId?: string | null;
    actorType: QuotaActorType;
    actorId?: string | null;
  },
  client: PrismaClientLike = prisma
) => {
  return client.quotaTransaction.create({
    data: {
      shopId: data.shopId,
      resource: data.resource,
      direction: data.direction,
      amount: data.amount,
      reason: data.reason,
      refType: data.refType || null,
      refId: data.refId || null,
      actorType: data.actorType,
      actorId: data.actorId || null,
    },
  });
};

export const creditLiveExtra = async (
  shopId: string,
  amount: number,
  client: PrismaClientLike = prisma,
  opts?: { refType?: QuotaRefType; refId?: string | null; actorType?: QuotaActorType; actorId?: string | null }
) => {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Cantidad invalida.');
  }
  const snapshot = await getLiveQuotaSnapshot(shopId, new Date(), client);
  const nextExtraBalance = snapshot.wallet.liveExtraBalance + amount;
  const baseRemaining = Math.max(0, snapshot.baseLimit - snapshot.weekCount);
  const nextStreamQuota = baseRemaining + nextExtraBalance;

  await client.quotaWallet.update({
    where: { shopId },
    data: { liveExtraBalance: nextExtraBalance },
  });

  await client.shop.update({
    where: { id: shopId },
    data: { streamQuota: nextStreamQuota },
  });

  await createQuotaTransaction(
    {
      shopId,
      resource: QuotaResource.LIVE,
      direction: QuotaDirection.CREDIT,
      amount,
      reason: QuotaReason.PURCHASE,
      refType: opts?.refType,
      refId: opts?.refId,
      actorType: opts?.actorType || QuotaActorType.SHOP,
      actorId: opts?.actorId || shopId,
    },
    client
  );
};

export const creditReelExtra = async (
  shopId: string,
  amount: number,
  client: PrismaClientLike = prisma,
  opts?: { refType?: QuotaRefType; refId?: string | null; actorType?: QuotaActorType; actorId?: string | null }
) => {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Cantidad invalida.');
  }
  const snapshot = await getReelQuotaSnapshot(shopId, new Date(), client);
  const nextExtraBalance = snapshot.wallet.reelExtraBalance + amount;
  const baseRemaining = Math.max(0, snapshot.dailyLimit - snapshot.dailyCount);
  const nextReelQuota = baseRemaining + nextExtraBalance;

  await client.quotaWallet.update({
    where: { shopId },
    data: { reelExtraBalance: nextExtraBalance },
  });

  await client.shop.update({
    where: { id: shopId },
    data: { reelQuota: nextReelQuota },
  });

  await createQuotaTransaction(
    {
      shopId,
      resource: QuotaResource.REEL,
      direction: QuotaDirection.CREDIT,
      amount,
      reason: QuotaReason.PURCHASE,
      refType: opts?.refType,
      refId: opts?.refId,
      actorType: opts?.actorType || QuotaActorType.SHOP,
      actorId: opts?.actorId || shopId,
    },
    client
  );
};

export const computeAgendaSuspended = (shop: { status: ShopStatus; agendaSuspendedUntil: Date | null }) => {
  if (shop.status === ShopStatus.AGENDA_SUSPENDED) return true;
  if (shop.agendaSuspendedUntil && shop.agendaSuspendedUntil.getTime() > Date.now()) return true;
  return false;
};
