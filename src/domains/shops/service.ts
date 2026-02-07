import {
  AuthUserStatus,
  AuthUserType,
  NotificationType,
  PurchaseStatus,
  PurchaseType,
  QuotaActorType,
  QuotaRefType,
  SocialPlatform,
  ShopStatus,
  StreamStatus,
} from '@prisma/client';
import { createHash, randomBytes, randomUUID, scryptSync } from 'crypto';
import prisma from './repo';
import { getShopRatingsMap } from '../../services/ratings.service';
import { computeAgendaSuspended, createQuotaWalletFromLegacy, creditLiveExtra, creditReelExtra } from '../../services/quota.service';
import { notifyAdmins } from '../notifications/service';
import { firebaseAuth, firebaseReady } from '../../lib/firebaseAdmin';
import { resolvePlanTier } from './plan';

type SocialHandleInput = { platform?: string; handle?: string };
type WhatsappLineInput = { label?: string; number?: string };

const SOCIAL_PLATFORM_BY_KEY: Record<string, SocialPlatform> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  facebook: 'Facebook',
  youtube: 'YouTube',
};

const PLAN_WHATSAPP_LIMIT: Record<'estandar' | 'alta' | 'maxima', number> = {
  estandar: 1,
  alta: 2,
  maxima: 3,
};
const MAX_WHATSAPP_LINES = 3;

const TECH_EMAIL_DOMAIN = 'invalid.local';
const DM_CATALOG_HOSTS = ['distritomoda.com.ar', 'distritomoda.com'];

const normalizeUrlForCompare = (value: string) =>
  value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/g, '');

const isDmCatalogUrl = (value: string) => {
  const normalized = normalizeUrlForCompare(value);
  if (!normalized) return false;
  return DM_CATALOG_HOSTS.some((host) => normalized.includes(host));
};

const sanitizeWebsite = (value: unknown, catalogUrl?: unknown) => {
  if (value === undefined) return undefined;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const normalized = normalizeUrlForCompare(raw);
  if (!normalized) return null;
  if (isDmCatalogUrl(raw)) return null;
  if (typeof catalogUrl === 'string' && catalogUrl.trim()) {
    const catalogNormalized = normalizeUrlForCompare(catalogUrl);
    if (catalogNormalized && normalized === catalogNormalized) return null;
  }
  return raw;
};

const normalizeShopStatus = (value: unknown) => {
  if (value === 'PENDING_VERIFICATION') return ShopStatus.PENDING_VERIFICATION;
  if (value === 'ACTIVE') return ShopStatus.ACTIVE;
  if (value === 'AGENDA_SUSPENDED') return ShopStatus.AGENDA_SUSPENDED;
  if (value === 'HIDDEN') return ShopStatus.HIDDEN;
  if (value === 'BANNED') return ShopStatus.BANNED;
  return ShopStatus.PENDING_VERIFICATION;
};

const normalizeEmail = (value: unknown) => String(value || '').trim().toLowerCase();

const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const buildTechnicalEmail = (shopId: string) => `shop_${shopId}@${TECH_EMAIL_DOMAIN}`;

const ensureFirebaseUser = async (email: string) => {
  if (!firebaseReady || !firebaseAuth) {
    throw new Error('Firebase Admin no configurado.');
  }
  try {
    await firebaseAuth.getUserByEmail(email);
  } catch (error: any) {
    if (error?.code === 'auth/user-not-found') {
      await firebaseAuth.createUser({ email });
      return;
    }
    throw error;
  }
};

const sendFirebasePasswordReset = async (email: string) => {
  const apiKey = process.env.FIREBASE_WEB_API_KEY || '';
  if (!apiKey) {
    throw new Error('FIREBASE_WEB_API_KEY no configurado.');
  }
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestType: 'PASSWORD_RESET', email }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Firebase sendOobCode error: ${res.status} ${body}`.trim());
  }
  return res.json().catch(() => ({}));
};

export const isShopEmail = async (email: string) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return false;
  const existing = await prisma.shop.findFirst({
    where: {
      email: {
        equals: normalizedEmail,
        mode: 'insensitive',
      },
    },
    select: { id: true },
  });
  return Boolean(existing);
};

const hashPassword = (value?: string | null) => {
  if (!value) return null;
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(value, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
};

const resolveAuthUserStatus = (status: ShopStatus | null | undefined, active?: boolean) => {
  if (status === ShopStatus.BANNED || status === ShopStatus.HIDDEN) return AuthUserStatus.SUSPENDED;
  if (active === false) return AuthUserStatus.SUSPENDED;
  return AuthUserStatus.ACTIVE;
};

const syncAuthUserStatus = async (
  authUserId: string | null | undefined,
  status: ShopStatus | null | undefined,
  active?: boolean,
  client = prisma
) => {
  if (!authUserId) return;
  const nextStatus = resolveAuthUserStatus(status, active);
  await client.authUser.update({
    where: { id: authUserId },
    data: { status: nextStatus },
  });
};

export const getWhatsappLimit = (plan: unknown) => {
  const tier = resolvePlanTier(plan);
  return PLAN_WHATSAPP_LIMIT[tier] || 1;
};

export const filterSocialHandlesByPlan = (
  plan: unknown,
  handles: { platform: SocialPlatform; handle: string }[]
) => {
  const tier = resolvePlanTier(plan);
  if (tier === 'estandar') return [];
  return handles;
};

const getDayRange = (date: Date) => {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

const buildSocialHandles = (input: unknown) => {
  if (!input) return [];

  if (Array.isArray(input)) {
    return (input as SocialHandleInput[])
      .map((item) => {
        const rawPlatform = String(item.platform || '').toLowerCase();
        const platform = SOCIAL_PLATFORM_BY_KEY[rawPlatform];
        const handle = String(item.handle || '').trim();
        if (!platform || !handle) return null;
        return { platform, handle };
      })
      .filter(Boolean) as { platform: SocialPlatform; handle: string }[];
  }

  if (typeof input === 'object') {
    return Object.entries(input as Record<string, unknown>)
      .map(([key, value]) => {
        const platform = SOCIAL_PLATFORM_BY_KEY[key.toLowerCase()];
        const handle = String(value || '').trim();
        if (!platform || !handle) return null;
        return { platform, handle };
      })
      .filter(Boolean) as { platform: SocialPlatform; handle: string }[];
  }

  return [];
};

const isValidWhatsappNumber = (value: string) => /^\+[1-9]\d{7,14}$/.test(value.trim());

const buildWhatsappLines = (input: unknown) => {
  if (!Array.isArray(input)) return [];
  let hasInvalid = false;
  const lines = (input as WhatsappLineInput[])
    .map((item) => {
      const label = String(item.label || '').trim();
      const number = String(item.number || '').trim();
      if (!label || !number) return null;
      if (!isValidWhatsappNumber(number)) {
        hasInvalid = true;
        return null;
      }
      return { label, number };
    })
    .filter(Boolean) as { label: string; number: string }[];
  if (hasInvalid) {
    throw new Error('WhatsApp invalido. Usa formato internacional. Ejemplo: +541122334455');
  }
  return lines;
};


const shopInclude = {
  socialHandles: true,
  whatsappLines: true,
  penalties: true,
  quotaWallet: true,
};

const shopPublicInclude = {
  socialHandles: true,
  whatsappLines: true,
};

const FEATURED_TIME_ZONE = 'America/Argentina/Buenos_Aires';
const FEATURED_DEFAULT_LIMIT = Number(process.env.FEATURED_DEFAULT_LIMIT || 40);
const FEATURED_MAX_LIMIT = Number(process.env.FEATURED_MAX_LIMIT || 60);
const LETTER_DEFAULT_LIMIT = 33;
const LETTER_MAX_LIMIT = Number(process.env.SHOPS_LETTER_MAX_LIMIT || 100);

const clampLimit = (value: number, fallback: number, max: number) => {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, max);
};

const getHourlySeed = (date: Date, timeZone = FEATURED_TIME_ZONE) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}-${get('hour')}`;
};

const hashToOffset = (seed: string, total: number) => {
  if (total <= 0) return 0;
  const hash = createHash('sha256').update(seed).digest('hex');
  const bucket = Number.parseInt(hash.slice(0, 8), 16);
  return bucket % total;
};

const toMapString = (value: unknown) => {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  return text;
};

const toMapNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const getAddressField = (details: Record<string, unknown>, key: string) =>
  toMapString(details[key] ?? '');

const getSocialUrl = (handles: { platform: SocialPlatform; handle: string }[], platform: SocialPlatform) => {
  const match = handles.find((item) => item.platform === platform);
  if (!match?.handle) return '';
  if (match.handle.startsWith('http')) return match.handle;
  if (platform === 'Instagram') return `https://instagram.com/${match.handle}`;
  if (platform === 'TikTok') return `https://tiktok.com/@${match.handle}`;
  if (platform === 'Facebook') return `https://facebook.com/${match.handle}`;
  if (platform === 'YouTube') return `https://youtube.com/${match.handle}`;
  return match.handle;
};

export const getShopsMapData = async () => {
  const shops = await prisma.shop.findMany({
    where: {
      active: true,
      status: ShopStatus.ACTIVE,
    },
    include: {
      socialHandles: true,
      whatsappLines: true,
    },
  });

  return shops.map((shop) => {
    const filteredHandles = filterSocialHandlesByPlan(shop.plan, shop.socialHandles || []);
    const details = (shop.addressDetails || {}) as Record<string, unknown>;
    const whatsapp = shop.whatsappLines?.[0]?.number || '';
    const legacyUid = toMapString(details.legacyUid || '');
    const legacyUser = toMapString(details.legacyUser || '');
    const legacyUserType = toMapString(details.legacyUserType || '');

    return {
      'Activo': shop.active ? 'Sí' : 'No',
      'Uid': legacyUid || shop.id,
      'Tipo de Usuario': legacyUserType || 'tienda',
      'Usuario': legacyUser || shop.slug || shop.name || '',
      'Nombre completo': shop.name || '',
      'Mail': toMapString(shop.email),
      'Celular': toMapString(whatsapp),
      'Mínimo de Compra': shop.minimumPurchase ?? 0,
      'Calle': getAddressField(details, 'street'),
      'Código postal': getAddressField(details, 'zip'),
      'Ciudad': getAddressField(details, 'city'),
      'Provincia': getAddressField(details, 'province'),
      'Plan de Suscripcion': toMapString(shop.plan),
      'Logo_URL': toMapString(shop.logoUrl),
      'imagen_destacada_url': toMapString(shop.coverUrl),
      'url_catalogo': toMapString(details.catalogUrl),
      'Instagram_URL': getSocialUrl(filteredHandles, 'Instagram'),
      'url_tienda': toMapString(shop.website),
      'url_imagen': toMapString(details.imageUrl),
      'imagen_tienda_url': toMapString(details.storeImageUrl),
      'lat': toMapNumber(details.lat),
      'lng': toMapNumber(details.lng),
    };
  });
};

export const getShops = async (options?: { limit?: number; offset?: number }) => {
  const rawLimit = Number(options?.limit);
  const rawOffset = Number(options?.offset);
  const maxLimit = Number(process.env.SHOPS_MAX_LIMIT || 40);
  const safeMax = Number.isFinite(maxLimit) && maxLimit > 0 ? maxLimit : 40;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, safeMax) : safeMax;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  const pagination = { take: limit, skip: offset };
  const shops = await prisma.shop.findMany({
    orderBy: { name: 'asc' },
    include: shopInclude,
    ...pagination,
  });
  const ratings = await getShopRatingsMap();
  return shops.map((shop) => {
    const rating = ratings.get(shop.id);
    return {
      ...shop,
      ratingAverage: rating?.avg ?? 0,
      ratingCount: rating?.count ?? 0,
    };
  });
};


export const getPublicShops = async (options?: { limit?: number; offset?: number }) => {
  const rawLimit = Number(options?.limit);
  const rawOffset = Number(options?.offset);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : undefined;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  const pagination = limit ? { take: limit, skip: offset } : {};
  const shops = await prisma.shop.findMany({
    where: {
      active: true,
      status: ShopStatus.ACTIVE,
    },
    orderBy: { name: 'asc' },
    include: shopPublicInclude,
    ...pagination,
  });
  const ratings = await getShopRatingsMap();
  return shops.map((shop) => {
    const rating = ratings.get(shop.id);
    return {
      ...shop,
      ratingAverage: rating?.avg ?? 0,
      ratingCount: rating?.count ?? 0,
    };
  });
};

const normalizeInitialLetter = (raw: string) => {
  const cleaned = raw.trim().toUpperCase();
  if (!cleaned) return '';
  const letter = cleaned[0];
  if (letter < 'A' || letter > 'Z') return '';
  return letter;
};

export const getPublicShopsByLetter = async (
  letter: string,
  options?: { limit?: number; offset?: number }
) => {
  const initial = normalizeInitialLetter(letter);
  if (!initial) return { items: [], hasMore: false };
  const safeLimit = clampLimit(Number(options?.limit), LETTER_DEFAULT_LIMIT, LETTER_MAX_LIMIT);
  const offset = Number.isFinite(Number(options?.offset)) && Number(options?.offset) > 0 ? Number(options?.offset) : 0;
  const shops = await prisma.shop.findMany({
    where: {
      active: true,
      status: ShopStatus.ACTIVE,
      name: {
        startsWith: initial,
        mode: 'insensitive',
      },
    },
    orderBy: { name: 'asc' },
    include: shopPublicInclude,
    skip: offset,
    take: safeLimit + 1,
  });
  const hasMore = shops.length > safeLimit;
  const items = shops.slice(0, safeLimit);
  const ratings = await getShopRatingsMap();
  const mapped = items.map((shop) => {
    const rating = ratings.get(shop.id);
    return {
      ...shop,
      ratingAverage: rating?.avg ?? 0,
      ratingCount: rating?.count ?? 0,
    };
  });
  return { items: mapped, hasMore };
};

export const getFeaturedShops = async (options?: { limit?: number; referenceDate?: Date }) => {
  const limit = clampLimit(Number(options?.limit), FEATURED_DEFAULT_LIMIT, FEATURED_MAX_LIMIT);
  const referenceDate = options?.referenceDate || new Date();
  const where = {
    active: true,
    status: ShopStatus.ACTIVE,
  };
  const total = await prisma.shop.count({ where });
  if (total === 0) return [];
  if (total <= limit) {
    const shops = await prisma.shop.findMany({
      where,
      orderBy: { name: 'asc' },
      include: shopPublicInclude,
    });
    const ratings = await getShopRatingsMap();
    return shops.map((shop) => {
      const rating = ratings.get(shop.id);
      return {
        ...shop,
        ratingAverage: rating?.avg ?? 0,
        ratingCount: rating?.count ?? 0,
      };
    });
  }

  const seed = getHourlySeed(referenceDate);
  const offset = hashToOffset(seed, total);
  const firstTake = Math.min(limit, total - offset);
  const firstBatch = await prisma.shop.findMany({
    where,
    orderBy: { name: 'asc' },
    skip: offset,
    take: firstTake,
    include: shopPublicInclude,
  });
  let featured = firstBatch;
  if (featured.length < limit) {
    const remaining = limit - featured.length;
    const secondBatch = await prisma.shop.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: 0,
      take: remaining,
      include: shopPublicInclude,
    });
    featured = featured.concat(secondBatch);
  }
  const ratings = await getShopRatingsMap();
  return featured.map((shop) => {
    const rating = ratings.get(shop.id);
    return {
      ...shop,
      ratingAverage: rating?.avg ?? 0,
      ratingCount: rating?.count ?? 0,
    };
  });
};

export const getShopsByLetter = async (options: { letter: string; limit?: number; offset?: number }) => {
  const letter = normalizeInitialLetter(options.letter || '');
  if (!letter) return { items: [], hasMore: false };
  const safeLimit = clampLimit(Number(options.limit), LETTER_DEFAULT_LIMIT, LETTER_MAX_LIMIT);
  const offset = Number.isFinite(Number(options.offset)) && Number(options.offset) > 0 ? Number(options.offset) : 0;

  const shops = await prisma.shop.findMany({
    where: {
      name: {
        startsWith: letter,
        mode: 'insensitive',
      },
    },
    orderBy: { name: 'asc' },
    skip: offset,
    take: safeLimit + 1,
    include: shopInclude,
  });
  const hasMore = shops.length > safeLimit;
  const slice = shops.slice(0, safeLimit);
  const ratings = await getShopRatingsMap();
  const items = slice.map((shop) => {
    const rating = ratings.get(shop.id);
    return {
      ...shop,
      ratingAverage: rating?.avg ?? 0,
      ratingCount: rating?.count ?? 0,
    };
  });
  return { items, hasMore };
};

export const getShopById = async (id: string) => {
  const shop = await prisma.shop.findUnique({
    where: { id },
    include: {
      streams: true,
      reels: true,
      ...shopInclude,
    },
  });
  if (!shop) {
    return shop;
  }
  const ratings = await getShopRatingsMap();
  const rating = ratings.get(shop.id);
  return {
    ...shop,
    ratingAverage: rating?.avg ?? 0,
    ratingCount: rating?.count ?? 0,
  };
};

export const createShop = async (data: any) => {
  const socialHandles = buildSocialHandles(data.socialHandles);
  const whatsappLines = buildWhatsappLines(data.whatsappLines);
  const status = normalizeShopStatus(data.status);
  const whatsappLimit = MAX_WHATSAPP_LINES;
  const active = data.active !== undefined ? Boolean(data.active) : true;
  const shopId = data.id || randomUUID();
  const normalizedEmail = normalizeEmail(data.email);
  const planTier = resolvePlanTier(data.plan || 'ESTANDAR');
  const planDefaults = planTier === 'maxima'
    ? { streamQuota: 3, reelQuota: 5 }
    : planTier === 'alta'
      ? { streamQuota: 1, reelQuota: 3 }
      : { streamQuota: 0, reelQuota: 1 };
  const parsedStreamQuota = Number(data.streamQuota);
  const parsedReelQuota = Number(data.reelQuota);
  const streamQuota = Number.isFinite(parsedStreamQuota) && parsedStreamQuota > 0
    ? parsedStreamQuota
    : planDefaults.streamQuota;
  const reelQuota = Number.isFinite(parsedReelQuota) && parsedReelQuota > 0
    ? parsedReelQuota
    : planDefaults.reelQuota;
  const coverUrl = String(data.coverUrl || '').trim();
  const catalogUrl =
    data?.addressDetails?.catalogUrl ?? data?.catalogUrl ?? data?.addressDetails?.url_catalogo;
  const website = sanitizeWebsite(data.website, catalogUrl);
  let authEmail = normalizedEmail;
  let requiresEmailFix = false;
  let reuseAuthUserId: string | null = null;

  if (normalizedEmail) {
    const existingShop = await prisma.shop.findFirst({
      where: {
        email: {
          equals: normalizedEmail,
          mode: 'insensitive',
        },
      },
    });
    if (existingShop) {
      throw new Error('Ya existe una tienda con ese email.');
    }
  }

  if (!isValidEmail(normalizedEmail)) {
    authEmail = buildTechnicalEmail(shopId);
    requiresEmailFix = true;
  } else {
    const existingAuthUser = await prisma.authUser.findUnique({
      where: { email: authEmail },
      include: { shop: { select: { id: true } } },
    });
    if (existingAuthUser) {
      const hasShop = Boolean(existingAuthUser.shop?.id);
      const isAdmin = existingAuthUser.userType === AuthUserType.ADMIN;
      if (!hasShop && !isAdmin) {
        reuseAuthUserId = existingAuthUser.id;
      } else {
        authEmail = buildTechnicalEmail(shopId);
        requiresEmailFix = true;
      }
    }
  }

  const passwordHash = hashPassword(data.password);

  const createdShop = await prisma.$transaction(
    async (tx) => {
    const authUser = reuseAuthUserId
      ? await tx.authUser.update({
          where: { id: reuseAuthUserId },
          data: {
            userType: AuthUserType.SHOP,
            status: resolveAuthUserStatus(status, active),
          },
        })
      : await tx.authUser.create({
          data: {
            email: authEmail,
            passwordHash,
            userType: AuthUserType.SHOP,
            status: resolveAuthUserStatus(status, active),
          },
        });

    const createdShop = await tx.shop.create({
      data: {
        id: shopId,
        authUserId: authUser.id,
        requiresEmailFix: reuseAuthUserId ? false : requiresEmailFix,
        name: data.name,
        slug: data.slug || data.name.toLowerCase().replace(/ /g, '-'),
        logoUrl: data.logoUrl || '',
        coverUrl: coverUrl || undefined,
        ...(website !== undefined ? { website } : {}),
        razonSocial: data.razonSocial,
        cuit: data.cuit,
        email: normalizedEmail || data.email,
        password: data.password,
        address: data.address,
        addressDetails: data.addressDetails || {},
        minimumPurchase: data.minimumPurchase || 0,
        paymentMethods: data.paymentMethods || [],
        plan: data.plan || 'ESTANDAR',
        status,
        statusChangedAt: new Date(),
        streamQuota,
        reelQuota,
        active,
        ...(socialHandles.length > 0 ? { socialHandles: { create: socialHandles } } : {}),
        ...(whatsappLines.length > 0 ? { whatsappLines: { create: whatsappLines.slice(0, whatsappLimit) } } : {}),
      },
      include: {
        socialHandles: true,
        whatsappLines: true,
        penalties: true,
      },
    });

    await createQuotaWalletFromLegacy(
      {
        id: createdShop.id,
        plan: createdShop.plan,
        streamQuota: createdShop.streamQuota,
        reelQuota: createdShop.reelQuota,
      },
      tx
    );

    return createdShop;
    },
    {
      maxWait: 20_000,
      timeout: 60_000,
    }
  );

  if (normalizedEmail && isValidEmail(normalizedEmail) && !requiresEmailFix && process.env.FIREBASE_WEB_API_KEY) {
    try {
      await ensureFirebaseUser(normalizedEmail);
      await sendFirebasePasswordReset(normalizedEmail);
    } catch (error) {
      console.error('Error enviando invitacion de tienda:', error);
    }
  }

  return createdShop;
};

export const updateShop = async (id: string, data: any) => {
  const socialHandles = data.socialHandles !== undefined ? buildSocialHandles(data.socialHandles) : null;
  const whatsappLines = data.whatsappLines !== undefined ? buildWhatsappLines(data.whatsappLines) : null;
  const status = data.status !== undefined ? normalizeShopStatus(data.status) : undefined;
  const normalizedEmail = data.email !== undefined ? normalizeEmail(data.email) : undefined;
  const coverUrl =
    data.coverUrl !== undefined ? (String(data.coverUrl || '').trim() || null) : undefined;
  const catalogUrl =
    data?.addressDetails?.catalogUrl ?? data?.catalogUrl ?? data?.addressDetails?.url_catalogo;
  const website = sanitizeWebsite(data.website, catalogUrl);

  if (normalizedEmail) {
    const existingShop = await prisma.shop.findFirst({
      where: {
        id: { not: id },
        email: {
          equals: normalizedEmail,
          mode: 'insensitive',
        },
      },
    });
    if (existingShop) {
      throw new Error('Ya existe una tienda con ese email.');
    }
  }

  const updateData: any = {
    name: data.name,
    razonSocial: data.razonSocial,
    cuit: data.cuit,
    email: normalizedEmail,
    address: data.address,
    logoUrl: data.logoUrl,
    coverUrl,
    website,
    addressDetails: data.addressDetails,
    paymentMethods: data.paymentMethods,
    minimumPurchase: data.minimumPurchase,
    status,
    statusReason: data.statusReason,
    statusChangedAt: status ? new Date() : undefined,
    agendaSuspendedUntil: data.agendaSuspendedUntil,
    agendaSuspendedByAdminId: data.agendaSuspendedByAdminId,
    agendaSuspendedReason: data.agendaSuspendedReason,
  };

  Object.keys(updateData).forEach((key) => updateData[key] === undefined && delete updateData[key]);

  if (socialHandles !== null) {
    updateData.socialHandles = { deleteMany: {}, create: socialHandles };
  }

  if (whatsappLines !== null) {
    const shop = await prisma.shop.findUnique({ where: { id }, select: { plan: true } });
    updateData.whatsappLines = { deleteMany: {}, create: whatsappLines.slice(0, MAX_WHATSAPP_LINES) };
  }

  return prisma.$transaction(async (tx) => {
    const updatedShop = await tx.shop.update({
      where: { id },
      data: updateData,
      include: {
        socialHandles: true,
        whatsappLines: true,
        penalties: true,
      },
    });

    if (status !== undefined) {
      await syncAuthUserStatus(updatedShop.authUserId, updatedShop.status, updatedShop.active, tx);
    }

    return updatedShop;
  });
};

export const acceptShop = async (id: string, authUserId: string) => {
  const shop = await prisma.shop.findUnique({
    where: { id },
    include: {
      socialHandles: true,
      whatsappLines: true,
      penalties: true,
      quotaWallet: true,
    },
  });
  if (!shop) {
    throw new Error('Tienda no encontrada.');
  }
  if (shop.authUserId && shop.authUserId !== authUserId) {
    throw new Error('Acceso denegado.');
  }

  const details = (shop.addressDetails || {}) as Record<string, unknown>;
  const hasIdentity =
    String(shop.name || '').trim().length > 0 &&
    String(shop.razonSocial || '').trim().length > 0 &&
    String(shop.cuit || '').trim().length > 0;
  const hasAddress =
    String(details.street || '').trim().length > 0 &&
    String(details.number || '').trim().length > 0 &&
    String(details.city || '').trim().length > 0 &&
    String(details.province || '').trim().length > 0 &&
    String(details.zip || '').trim().length > 0;
  const hasSales =
    Number(shop.minimumPurchase ?? 0) > 0 &&
    Array.isArray(shop.paymentMethods) &&
    shop.paymentMethods.length > 0;
  const hasValidEmail = !shop.requiresEmailFix && isValidEmail(shop.email || '');
  const hasActivePenalty = (shop.penalties || []).some((penalty) => penalty.active);
  const canAutoApprove =
    shop.status === ShopStatus.PENDING_VERIFICATION &&
    shop.active !== false &&
    hasValidEmail &&
    hasIdentity &&
    hasAddress &&
    hasSales &&
    !hasActivePenalty;

  const updated = await prisma.$transaction(async (tx) => {
    const updatedShop = await tx.shop.update({
      where: { id },
      data: {
        ownerAcceptedAt: shop.ownerAcceptedAt || new Date(),
        ...(canAutoApprove
          ? {
              status: ShopStatus.ACTIVE,
              statusReason: null,
              statusChangedAt: new Date(),
              active: true,
              agendaSuspendedUntil: null,
              agendaSuspendedByAdminId: null,
              agendaSuspendedReason: null,
            }
          : {}),
      },
      include: {
        socialHandles: true,
        whatsappLines: true,
        penalties: true,
        quotaWallet: true,
      },
    });

    if (canAutoApprove) {
      await syncAuthUserStatus(updatedShop.authUserId, updatedShop.status, updatedShop.active, tx);
    }

    return updatedShop;
  });

  await notifyAdmins(
    canAutoApprove
      ? `La tienda ${updated.name} confirmo sus datos y fue autoaprobada.`
      : `La tienda ${updated.name} confirmo sus datos. Pendiente de revision.`,
    {
      type: NotificationType.SYSTEM,
      refId: updated.id,
    }
  );

  return updated;
};

export const buyStreamQuota = async (id: string, amount: number, actor?: { userType: AuthUserType; authUserId: string }) => {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('Cantidad invalida.');
  }
  const isAdmin = actor?.userType === AuthUserType.ADMIN;

  const shop = await prisma.shop.findUnique({
    where: { id },
    select: { status: true, agendaSuspendedUntil: true },
  });
  if (!shop) {
    throw new Error('Tienda no encontrada.');
  }
  if (computeAgendaSuspended({ status: shop.status, agendaSuspendedUntil: shop.agendaSuspendedUntil })) {
    throw new Error('Agenda suspendida: no puedes comprar cupos de vivos.');
  }

  const result = await prisma.$transaction(async (tx) => {
    const purchase = await tx.purchaseRequest.create({
      data: {
        shopId: id,
        type: PurchaseType.LIVE_PACK,
        quantity: numericAmount,
        status: isAdmin ? PurchaseStatus.APPROVED : PurchaseStatus.PENDING,
        approvedAt: isAdmin ? new Date() : null,
        approvedByAdminId: isAdmin ? actor?.authUserId : null,
      },
    });

    if (isAdmin) {
      await creditLiveExtra(id, numericAmount, tx, {
        refType: QuotaRefType.PURCHASE,
        refId: purchase.purchaseId,
        actorType: QuotaActorType.ADMIN,
        actorId: actor?.authUserId,
      });
    }

    const shop = await tx.shop.findUnique({
      where: { id },
      include: {
        socialHandles: true,
        whatsappLines: true,
        penalties: true,
        quotaWallet: true,
      },
    });

    return { shop, purchase };
  });

  if (!isAdmin) {
    await notifyAdmins(`Nueva solicitud de compra de vivos: ${result.shop?.name || 'Tienda'} (${numericAmount}).`, {
      type: NotificationType.PURCHASE,
      refId: result.purchase.purchaseId,
    });
  }

  return result;
};

export const buyReelQuota = async (id: string, amount: number, actor?: { userType: AuthUserType; authUserId: string }) => {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('Cantidad invalida.');
  }
  const isAdmin = actor?.userType === AuthUserType.ADMIN;

  const shop = await prisma.shop.findUnique({
    where: { id },
    select: { status: true, agendaSuspendedUntil: true },
  });
  if (!shop) {
    throw new Error('Tienda no encontrada.');
  }

  const result = await prisma.$transaction(async (tx) => {
    const purchase = await tx.purchaseRequest.create({
      data: {
        shopId: id,
        type: PurchaseType.REEL_PACK,
        quantity: numericAmount,
        status: isAdmin ? PurchaseStatus.APPROVED : PurchaseStatus.PENDING,
        approvedAt: isAdmin ? new Date() : null,
        approvedByAdminId: isAdmin ? actor?.authUserId : null,
      },
    });

    if (isAdmin) {
      await creditReelExtra(id, numericAmount, tx, {
        refType: QuotaRefType.PURCHASE,
        refId: purchase.purchaseId,
        actorType: QuotaActorType.ADMIN,
        actorId: actor?.authUserId,
      });
    }

    const shop = await tx.shop.findUnique({
      where: { id },
      include: {
        socialHandles: true,
        whatsappLines: true,
        penalties: true,
        quotaWallet: true,
      },
    });

    return { shop, purchase };
  });

  if (!isAdmin) {
    await notifyAdmins(`Nueva solicitud de compra de historias: ${result.shop?.name || 'Tienda'} (${numericAmount}).`, {
      type: NotificationType.PURCHASE,
      refId: result.purchase.purchaseId,
    });
  }

  return result;
};

export const assignOwner = async (shopId: string, payload: { authUserId?: string; email?: string }) => {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) {
    throw new Error('Tienda no encontrada.');
  }

  const authUserId = payload?.authUserId?.trim();
  const email = normalizeEmail(payload?.email);
  let authUser = null;

  if (authUserId) {
    authUser = await prisma.authUser.findUnique({ where: { id: authUserId } });
  }

  if (!authUser && email) {
    authUser = await prisma.authUser.findUnique({ where: { email } });
  }

  if (!authUser) {
    throw new Error('Usuario no encontrado. Debe iniciar sesión al menos una vez.');
  }

  if (authUser.userType === AuthUserType.ADMIN) {
    throw new Error('No se puede asignar un admin como dueño de tienda.');
  }

  return prisma.$transaction(async (tx) => {
    await tx.authUser.update({
      where: { id: authUser.id },
      data: { userType: AuthUserType.SHOP },
    });

    const updatedShop = await tx.shop.update({
      where: { id: shopId },
      data: { authUserId: authUser.id },
      include: {
        socialHandles: true,
        whatsappLines: true,
        penalties: true,
      },
    });

    await syncAuthUserStatus(authUser.id, updatedShop.status, updatedShop.active, tx);
    return updatedShop;
  });
};

export const togglePenalty = async (id: string) => {
  const shop = await prisma.shop.findUnique({ where: { id } });
  if (!shop) return null;
  return shop;
};

export const activateShop = async (id: string, reason?: string) => {
  return prisma.$transaction(async (tx) => {
    const updatedShop = await tx.shop.update({
      where: { id },
      data: {
        status: ShopStatus.ACTIVE,
        statusReason: reason || null,
        statusChangedAt: new Date(),
        active: true,
        agendaSuspendedUntil: null,
        agendaSuspendedByAdminId: null,
        agendaSuspendedReason: null,
      },
      include: {
        socialHandles: true,
        whatsappLines: true,
        penalties: true,
      },
    });

    await syncAuthUserStatus(updatedShop.authUserId, updatedShop.status, updatedShop.active, tx);
    return updatedShop;
  });
};

export const suspendAgenda = async (id: string, reason?: string, days = 7) => {
  const suspendedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const updatedShop = await prisma.shop.update({
    where: { id },
    data: {
      status: ShopStatus.AGENDA_SUSPENDED,
      statusReason: reason || 'Agenda suspendida',
      statusChangedAt: new Date(),
      agendaSuspendedUntil: suspendedUntil,
      agendaSuspendedReason: reason || 'Agenda suspendida',
    },
    include: {
      socialHandles: true,
      whatsappLines: true,
      penalties: true,
    },
  });

  const batchId = randomUUID();
  const upcomingStreams = await prisma.stream.findMany({
    where: {
      shopId: id,
      status: StreamStatus.UPCOMING,
      scheduledAt: { gte: new Date(), lte: suspendedUntil },
    },
  });

  for (const stream of upcomingStreams) {
    const newDate = new Date(stream.scheduledAt);
    newDate.setDate(newDate.getDate() + 7);
    const { start, end } = getDayRange(newDate);

    const conflict = await prisma.stream.findFirst({
      where: {
        shopId: id,
        id: { not: stream.id },
        status: { in: [StreamStatus.UPCOMING, StreamStatus.LIVE] },
        scheduledAt: { gte: start, lte: end },
      },
    });

    if (conflict) {
      await prisma.stream.update({
        where: { id: stream.id },
        data: {
          status: StreamStatus.PENDING_REPROGRAMMATION,
          pendingReprogramNote: 'Conflicto de agenda por sancion',
          reprogramReason: 'Sancion de agenda',
          reprogramBatchId: batchId,
        },
      });
    } else {
      await prisma.stream.update({
        where: { id: stream.id },
        data: {
          scheduledAt: newDate,
          originalScheduledAt: stream.originalScheduledAt || stream.scheduledAt,
          reprogramReason: 'Sancion de agenda',
          reprogramBatchId: batchId,
        },
      });
    }
  }

  return updatedShop;
};

export const liftAgendaSuspension = async (id: string) => {
  return prisma.$transaction(async (tx) => {
    const updatedShop = await tx.shop.update({
      where: { id },
      data: {
        status: ShopStatus.ACTIVE,
        statusReason: null,
        statusChangedAt: new Date(),
        agendaSuspendedUntil: null,
        agendaSuspendedReason: null,
        agendaSuspendedByAdminId: null,
      },
      include: {
        socialHandles: true,
        whatsappLines: true,
        penalties: true,
      },
    });

    await syncAuthUserStatus(updatedShop.authUserId, updatedShop.status, updatedShop.active, tx);
    return updatedShop;
  });
};

export const rejectShop = async (id: string, reason?: string) => {
  return prisma.$transaction(async (tx) => {
    const updatedShop = await tx.shop.update({
      where: { id },
      data: {
        status: ShopStatus.HIDDEN,
        statusReason: reason || 'Solicitud rechazada',
        statusChangedAt: new Date(),
      },
      include: {
        socialHandles: true,
        whatsappLines: true,
        penalties: true,
      },
    });

    await syncAuthUserStatus(updatedShop.authUserId, updatedShop.status, updatedShop.active, tx);
    return updatedShop;
  });
};

export const resetShopPassword = async (id: string) => {
  if (!firebaseAuth) {
    throw new Error('Firebase Admin no configurado.');
  }
  const shop = await prisma.shop.findUnique({
    where: { id },
    select: { email: true },
  });
  if (!shop?.email) {
    throw new Error('La tienda no tiene email configurado.');
  }
  const email = normalizeEmail(shop.email);
  try {
    await firebaseAuth.getUserByEmail(email);
  } catch (error: any) {
    if (error?.code === 'auth/user-not-found') {
      const tempPassword = randomBytes(10).toString('hex');
      await firebaseAuth.createUser({ email, password: tempPassword });
    } else {
      throw error;
    }
  }

  const resetLink = await firebaseAuth.generatePasswordResetLink(email);
  return { resetLink };
};

export const sendShopInvite = async (id: string) => {
  const shop = await prisma.shop.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, requiresEmailFix: true },
  });
  if (!shop) {
    throw new Error('Tienda no encontrada.');
  }
  const email = normalizeEmail(shop.email);
  if (!email || !isValidEmail(email)) {
    throw new Error('Email invalido para enviar invitacion.');
  }
  await ensureFirebaseUser(email);
  await sendFirebasePasswordReset(email);
  await prisma.shop.update({
    where: { id: shop.id },
    data: { requiresEmailFix: false },
  });
  return { sent: true };
};

export const deleteShop = async (id: string) => {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.shop.findUnique({ where: { id }, select: { id: true } });
    if (!existing) {
      throw new Error('Tienda no encontrada.');
    }

    const streams = await tx.stream.findMany({
      where: { shopId: id },
      select: { id: true },
    });
    const streamIds = streams.map((stream) => stream.id);
    if (streamIds.length > 0) {
      await tx.agenda.deleteMany({ where: { streamId: { in: streamIds } } });
      await tx.review.deleteMany({ where: { streamId: { in: streamIds } } });
      await tx.report.deleteMany({ where: { streamId: { in: streamIds } } });
      await tx.streamLike.deleteMany({ where: { streamId: { in: streamIds } } });
      await tx.liveScheduleEvent.deleteMany({ where: { liveId: { in: streamIds } } });
      await tx.stream.deleteMany({ where: { id: { in: streamIds } } });
    }

    const reels = await tx.reel.findMany({
      where: { shopId: id },
      select: { id: true },
    });
    const reelIds = reels.map((reel) => reel.id);
    if (reelIds.length > 0) {
      await tx.reelView.deleteMany({ where: { reelId: { in: reelIds } } });
      await tx.reel.deleteMany({ where: { id: { in: reelIds } } });
    }

    await tx.favorite.deleteMany({ where: { shopId: id } });
    await tx.penalty.deleteMany({ where: { shopId: id } });
    await tx.shopSocialHandle.deleteMany({ where: { shopId: id } });
    await tx.shopWhatsappLine.deleteMany({ where: { shopId: id } });
    await tx.quotaTransaction.deleteMany({ where: { shopId: id } });
    await tx.purchaseRequest.deleteMany({ where: { shopId: id } });
    await tx.agendaSuspension.deleteMany({ where: { shopId: id } });
    await tx.liveScheduleEvent.deleteMany({ where: { shopId: id } });
    await tx.quotaWallet.deleteMany({ where: { shopId: id } });

    return tx.shop.delete({ where: { id } });
  });
};
