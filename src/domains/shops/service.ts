import {
  AuthUserStatus,
  AuthUserType,
  NotificationType,
  Prisma,
  PrismaClient,
  PurchaseStatus,
  PurchaseType,
  QuotaActorType,
  QuotaRefType,
  SocialPlatform,
  ShopPlanTier,
  ShopRegistrationSource,
  ShopStatus,
  ShopVerificationState,
  ShopVisibilityState,
  StreamStatus,
} from '@prisma/client';
import { createHash, randomBytes, randomUUID, scryptSync } from 'crypto';
import prisma from './repo';
import { getShopRatingsMap } from '../../services/ratings.service';
import { computeAgendaSuspended, createQuotaWalletFromLegacy, creditLiveExtra, creditReelExtra, syncQuotaWalletToPlan } from '../../services/quota.service';
import { notifyAdmins } from '../notifications/service';
import { firebaseAuth, firebaseReady } from '../../lib/firebaseAdmin';
import { resolvePlanTier } from './plan';
import { resolveAppUrl, sendEmailTemplate } from '../../services/email.service';
import {
  buildSelfRegisterConfirmationEmailTemplate,
  buildShopInviteEmailTemplate,
  buildShopPasswordResetEmailTemplate,
} from '../../services/emailTemplates';
import { createSelfRegisterUploadToken } from '../../utils/selfRegisterUploadToken';

type SocialHandleInput = { platform?: string; handle?: string };
type WhatsappLineInput = { label?: string; number?: string };
type SelfRegisterAddressInput = {
  street?: string;
  number?: string;
  city?: string;
  province?: string;
  zip?: string;
  isGallery?: boolean;
  galleryName?: string;
  galleryLocal?: string;
  galleryFloor?: string;
  reference?: string;
};
type SelfRegisterInput = {
  storeName?: string;
  logoUrl?: string;
  email?: string;
  whatsapp?: string;
  address?: SelfRegisterAddressInput;
  consents?: {
    termsAccepted?: boolean;
    contactAccepted?: boolean;
  };
  intakeMeta?: Record<string, unknown>;
};
type AddressSuggestion = {
  label: string;
  details: {
    street: string;
    number: string;
    city: string;
    province: string;
    zip: string;
    lat?: string;
    lng?: string;
  };
};
type ModerationActor = {
  authUserId?: string | null;
  email?: string | null;
  userType?: AuthUserType | null;
};
type IntakeMetaAuditEntry = {
  action: string;
  at: string;
  reason?: string | null;
  actor?: {
    userType?: string | null;
    authUserId?: string | null;
    email?: string | null;
  };
  extra?: Record<string, unknown>;
};

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
const SELF_REGISTER_DEFAULT_COUNTRY = process.env.SELF_REGISTER_GEOCODE_COUNTRY || 'Argentina';
const SELF_REGISTER_DEFAULT_PROVINCE = process.env.SELF_REGISTER_GEOCODE_PROVINCE || 'Buenos Aires';
const SELF_REGISTER_DEFAULT_CITY = process.env.SELF_REGISTER_GEOCODE_CITY || 'Avellaneda';
const NOMINATIM_URL =
  process.env.SELF_REGISTER_GEOCODE_URL || 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_USER_AGENT =
  process.env.SELF_REGISTER_GEOCODE_USER_AGENT || 'avellaneda-backend/1.0 (shops-self-register)';

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
const normalizePhone = (value: unknown) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/-/g, '');
const normalizeText = (value: unknown) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
const normalizeForMatch = (value: unknown) =>
  normalizeText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
const toMetaObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
};

const buildAuditEntry = (
  action: string,
  actor?: ModerationActor,
  reason?: string | null,
  extra?: Record<string, unknown>
): IntakeMetaAuditEntry => ({
  action,
  at: new Date().toISOString(),
  reason: reason || null,
  actor: {
    userType: actor?.userType || null,
    authUserId: actor?.authUserId || null,
    email: actor?.email || null,
  },
  ...(extra ? { extra } : {}),
});

const appendIntakeAudit = (currentMeta: unknown, entry: IntakeMetaAuditEntry) => {
  const meta = toMetaObject(currentMeta);
  const trail = Array.isArray(meta.auditTrail) ? meta.auditTrail : [];
  return {
    ...meta,
    auditTrail: [...trail, entry].slice(-120),
    lastAuditAt: entry.at,
  };
};
const toSlugBase = (value: string) =>
  normalizeForMatch(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

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

const sendShopAccessEmail = async (params: {
  email: string;
  shopName: string;
  resetUrl: string;
  mode: 'invite' | 'reset';
}) => {
  const appUrl = resolveAppUrl();
  const template =
    params.mode === 'invite'
      ? buildShopInviteEmailTemplate({
          shopName: params.shopName,
          resetUrl: params.resetUrl,
          appUrl,
        })
      : buildShopPasswordResetEmailTemplate({
          shopName: params.shopName,
          resetUrl: params.resetUrl,
          appUrl,
        });

  return sendEmailTemplate(params.email, template, { requireConfigured: true });
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
  client: Prisma.TransactionClient | PrismaClient = prisma
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

const resolveShopPlanTier = (plan: unknown) => {
  const tier = resolvePlanTier(plan);
  if (tier === 'maxima') return ShopPlanTier.MAXIMA;
  if (tier === 'alta') return ShopPlanTier.MEDIA;
  return ShopPlanTier.BASICO;
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

const buildAddressBase = (input: {
  street: string;
  number: string;
  city: string;
  province: string;
}) => `${input.street} ${input.number}, ${input.city}, ${input.province}, ${SELF_REGISTER_DEFAULT_COUNTRY}`;

const buildAddressDisplay = (input: {
  addressBase: string;
  isGallery: boolean;
  galleryName: string | null;
  galleryLocal: string | null;
  galleryFloor: string | null;
}) => {
  const parts = [input.addressBase];
  if (input.isGallery && input.galleryName) parts.push(`Galeria ${input.galleryName}`);
  if (input.isGallery && input.galleryLocal) parts.push(`Local ${input.galleryLocal}`);
  if (input.isGallery && input.galleryFloor) parts.push(`Piso ${input.galleryFloor}`);
  return parts.join(' · ');
};

const ensureUniqueSlug = async (
  name: string,
  client: Prisma.TransactionClient | PrismaClient = prisma
) => {
  const base = toSlugBase(name) || `tienda-${randomUUID().slice(0, 8)}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const existing = await client.shop.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }
  return `${base}-${Date.now()}`;
};

const geocodeAddressBase = async (addressBase: string) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const params = new URLSearchParams({
      q: addressBase,
      format: 'jsonv2',
      addressdetails: '1',
      limit: '1',
      countrycodes: 'ar',
    });
    const response = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': NOMINATIM_USER_AGENT,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw {
        status: 503,
        message: `No se pudo validar la direccion (HTTP ${response.status}).`,
      };
    }
    const payload = (await response.json().catch(() => [])) as Array<{
      lat?: string;
      lon?: string;
    }>;
    const first = payload[0];
    const lat = Number(first?.lat);
    const lng = Number(first?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw {
        status: 422,
        message: 'No se pudo geolocalizar la direccion. Revisa calle y altura.',
      };
    }
    return {
      lat,
      lng,
      mapsUrl: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
    };
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw { status: 503, message: 'Timeout al validar direccion en mapa.' };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const resolveNominatimStreet = (address: Record<string, unknown>) =>
  toMapString(
    address.road ||
      address.pedestrian ||
      address.footway ||
      address.path ||
      address.neighbourhood ||
      ''
  );

const resolveNominatimCity = (address: Record<string, unknown>) =>
  toMapString(
    address.city ||
      address.town ||
      address.village ||
      address.suburb ||
      address.county ||
      address.hamlet ||
      ''
  );

const resolveNominatimProvince = (address: Record<string, unknown>) =>
  toMapString(address.state || address.region || address.state_district || '');

const toAddressSuggestion = (item: any): AddressSuggestion | null => {
  if (!item || typeof item !== 'object' || !item.address) return null;
  const address = item.address as Record<string, unknown>;
  const label = toMapString(item.display_name || '');
  if (!label) return null;
  return {
    label,
    details: {
      street: resolveNominatimStreet(address),
      number: toMapString(address.house_number || ''),
      city: resolveNominatimCity(address),
      province: resolveNominatimProvince(address),
      zip: toMapString(address.postcode || ''),
      lat: toMapString(item.lat || ''),
      lng: toMapString(item.lon || ''),
    },
  };
};

const buildSelfRegisterAddress = (rawAddress: SelfRegisterAddressInput | undefined) => {
  const street = normalizeText(rawAddress?.street);
  const number = normalizeText(rawAddress?.number);
  const city = normalizeText(rawAddress?.city || SELF_REGISTER_DEFAULT_CITY);
  const province = normalizeText(rawAddress?.province || SELF_REGISTER_DEFAULT_PROVINCE);
  const zip = normalizeText(rawAddress?.zip);
  const reference = normalizeText(rawAddress?.reference);
  const isGallery = Boolean(rawAddress?.isGallery);
  const galleryName = normalizeText(rawAddress?.galleryName) || null;
  const galleryLocal = normalizeText(rawAddress?.galleryLocal || '').toUpperCase() || null;
  const galleryFloor = normalizeText(rawAddress?.galleryFloor) || null;

  if (!street || !number || !city || !province) {
    throw {
      status: 400,
      message: 'Direccion incompleta. Completa calle, altura, ciudad y provincia.',
    };
  }
  if (isGallery && !galleryLocal) {
    throw { status: 400, message: 'Si es galeria, debes indicar el numero de local.' };
  }

  const addressBase = buildAddressBase({ street, number, city, province });
  const addressDisplay = buildAddressDisplay({
    addressBase: `${street} ${number}, ${city}`,
    isGallery,
    galleryName,
    galleryLocal,
    galleryFloor,
  });

  return {
    street,
    number,
    city,
    province,
    zip: zip || null,
    reference: reference || null,
    isGallery,
    galleryName,
    galleryLocal,
    galleryFloor,
    addressBase,
    addressDisplay,
    normalizedAddressBase: normalizeForMatch(addressBase),
  };
};


const shopSelectBase = {
  id: true,
  name: true,
  slug: true,
  logoUrl: true,
  coverUrl: true,
  website: true,
  razonSocial: true,
  cuit: true,
  email: true,
  address: true,
  addressDetails: true,
  minimumPurchase: true,
  paymentMethods: true,
  plan: true,
  planTier: true,
  status: true,
  registrationSource: true,
  visibilityState: true,
  verificationState: true,
  contactsPublic: true,
  contactEmailPrivate: true,
  contactWhatsappPrivate: true,
  isGallery: true,
  galleryName: true,
  galleryLocal: true,
  galleryFloor: true,
  addressBase: true,
  addressDisplay: true,
  normalizedAddressBase: true,
  normalizedName: true,
  intakeMeta: true,
  statusReason: true,
  statusChangedAt: true,
  ownerAcceptedAt: true,
  agendaSuspendedUntil: true,
  agendaSuspendedByAdminId: true,
  agendaSuspendedReason: true,
  streamQuota: true,
  reelQuota: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} as const;

const shopPublicSelect = {
  ...shopSelectBase,
  socialHandles: {
    select: {
      platform: true,
      handle: true,
    },
  },
  whatsappLines: {
    select: {
      label: true,
      number: true,
    },
  },
} as const;

const shopPrivateSelect = {
  ...shopSelectBase,
  authUserId: true,
  requiresEmailFix: true,
  socialHandles: true,
  whatsappLines: true,
  penalties: true,
  quotaWallet: true,
} as const;

const FEATURED_TIME_ZONE = 'America/Argentina/Buenos_Aires';
const FEATURED_DEFAULT_LIMIT = Number(process.env.FEATURED_DEFAULT_LIMIT || 40);
const FEATURED_MAX_LIMIT = Number(process.env.FEATURED_MAX_LIMIT || 60);
const LETTER_DEFAULT_LIMIT = 33;
const LETTER_MAX_LIMIT = Number(process.env.SHOPS_LETTER_MAX_LIMIT || 100);

const clampLimit = (value: number, fallback: number, max: number) => {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, max);
};

const normalizeCountryCode = (value: unknown) =>
  String(value || 'ar')
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .slice(0, 2) || 'ar';

export const searchAddressSuggestions = async (
  query: string,
  options?: { limit?: number; countryCode?: string }
): Promise<AddressSuggestion[]> => {
  const normalizedQuery = normalizeText(query);
  if (normalizedQuery.length < 3) return [];

  const limit = clampLimit(Number(options?.limit), 6, 10);
  const countryCode = normalizeCountryCode(options?.countryCode || 'ar');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const params = new URLSearchParams({
      q: normalizedQuery,
      format: 'jsonv2',
      addressdetails: '1',
      limit: String(limit),
      countrycodes: countryCode,
    });
    const response = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'es',
        'User-Agent': NOMINATIM_USER_AGENT,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return [];
    }

    const payload = (await response.json().catch(() => [])) as any[];
    if (!Array.isArray(payload)) return [];
    return payload.map(toAddressSuggestion).filter(Boolean) as AddressSuggestion[];
  } catch (error: any) {
    if (error?.name !== 'AbortError') {
      console.error('[shops.address-search] error:', error);
    }
    return [];
  } finally {
    clearTimeout(timeout);
  }
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
      OR: [
        { status: ShopStatus.ACTIVE },
        { visibilityState: ShopVisibilityState.DIMMED },
      ],
    },
    include: {
      socialHandles: true,
      whatsappLines: true,
    },
  });

  return shops.map((shop) => {
    const filteredHandles = filterSocialHandlesByPlan(shop.plan, shop.socialHandles || []);
    const details = (shop.addressDetails || {}) as Record<string, unknown>;
    const publicContactsEnabled =
      shop.contactsPublic !== false && shop.visibilityState !== ShopVisibilityState.DIMMED;
    const effectiveHandles = publicContactsEnabled ? filteredHandles : [];
    const whatsapp = publicContactsEnabled ? shop.whatsappLines?.[0]?.number || '' : '';
    const legacyUid = toMapString(details.legacyUid || '');
    const legacyUser = toMapString(details.legacyUser || '');
    const legacyUserType = toMapString(details.legacyUserType || '');

    return {
      'Activo': shop.active ? 'Sí' : 'No',
      'Uid': legacyUid || shop.id,
      'Tipo de Usuario': legacyUserType || 'tienda',
      'Usuario': legacyUser || shop.slug || shop.name || '',
      'Nombre completo': shop.name || '',
      'Mail': publicContactsEnabled ? toMapString(shop.email) : '',
      'Celular': toMapString(whatsapp),
      'Mínimo de Compra': shop.minimumPurchase ?? 0,
      'Calle': getAddressField(details, 'street'),
      'Código postal': getAddressField(details, 'zip'),
      'Ciudad': getAddressField(details, 'city'),
      'Provincia': getAddressField(details, 'province'),
      'Plan de Suscripcion': toMapString(shop.plan),
      'Estado de visibilidad': toMapString(shop.visibilityState),
      'Logo_URL': toMapString(shop.logoUrl),
      'imagen_destacada_url': toMapString(shop.coverUrl),
      'url_catalogo': toMapString(details.catalogUrl),
      'Instagram_URL': getSocialUrl(effectiveHandles, 'Instagram'),
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
    select: shopPrivateSelect,
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
  const shops = await prisma.shop.findMany({
    where: {
      active: true,
      OR: [
        { status: ShopStatus.ACTIVE },
        { visibilityState: ShopVisibilityState.DIMMED },
      ],
    },
    orderBy: { name: 'asc' },
    select: shopPublicSelect,
    take: limit,
    skip: limit ? offset : undefined,
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
      OR: [
        { status: ShopStatus.ACTIVE },
        { visibilityState: ShopVisibilityState.DIMMED },
      ],
      name: {
        startsWith: initial,
        mode: 'insensitive',
      },
    },
    orderBy: { name: 'asc' },
    select: shopPublicSelect,
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
      select: shopPublicSelect,
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
    select: shopPublicSelect,
  });
  let featured = firstBatch;
  if (featured.length < limit) {
    const remaining = limit - featured.length;
    const secondBatch = await prisma.shop.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: 0,
      take: remaining,
      select: shopPublicSelect,
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
    select: shopPrivateSelect,
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
    select: shopPrivateSelect,
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

export const createSelfRegisteredShop = async (
  input: SelfRegisterInput,
  context?: { ip?: string | null; userAgent?: string | null }
) => {
  const storeName = normalizeText(input?.storeName);
  const normalizedName = normalizeForMatch(storeName);
  const logoUrl = normalizeText(input?.logoUrl) || null;
  const email = normalizeEmail(input?.email);
  const whatsapp = normalizePhone(input?.whatsapp);
  const termsAccepted = Boolean(input?.consents?.termsAccepted);
  const contactAccepted = Boolean(input?.consents?.contactAccepted);
  const address = buildSelfRegisterAddress(input?.address);

  if (!storeName || storeName.length < 2) {
    throw { status: 400, message: 'Nombre de tienda invalido.' };
  }
  if (!email || !isValidEmail(email)) {
    throw { status: 400, message: 'Email invalido.' };
  }
  if (!whatsapp || !isValidWhatsappNumber(whatsapp)) {
    throw { status: 400, message: 'WhatsApp invalido. Usa formato internacional (+549...).' };
  }
  if (!termsAccepted || !contactAccepted) {
    throw { status: 400, message: 'Debes aceptar terminos y contacto para continuar.' };
  }

  const duplicateByContact = await prisma.shop.findFirst({
    where: {
      OR: [
        { contactEmailPrivate: { equals: email, mode: 'insensitive' } },
        { contactWhatsappPrivate: { equals: whatsapp, mode: 'insensitive' } },
      ],
    },
    select: { id: true },
  });
  if (duplicateByContact) {
    throw {
      status: 409,
      message: 'Ya existe una tienda registrada con ese email o WhatsApp.',
    };
  }

  if (address.isGallery && address.galleryLocal) {
    const duplicateByAddressLocal = await prisma.shop.findFirst({
      where: {
        normalizedAddressBase: address.normalizedAddressBase,
        galleryLocal: address.galleryLocal,
      },
      select: { id: true, name: true },
    });
    if (duplicateByAddressLocal) {
      throw {
        status: 409,
        message: `Ya existe una tienda registrada en ese local (${address.galleryLocal}).`,
      };
    }
  }

  const duplicateByAddressAndName = await prisma.shop.findFirst({
    where: {
      normalizedAddressBase: address.normalizedAddressBase,
      normalizedName,
      OR: [{ galleryLocal: address.galleryLocal }, { galleryLocal: null }],
    },
    select: { id: true },
  });
  if (duplicateByAddressAndName) {
    throw {
      status: 409,
      message: 'Ya existe una tienda con ese nombre en esa direccion.',
    };
  }

  const geocode = await geocodeAddressBase(address.addressBase);
  const baseIntakeMeta = {
    ...(input?.intakeMeta && typeof input.intakeMeta === 'object' ? input.intakeMeta : {}),
    source: 'self_register',
    ip: context?.ip || null,
    userAgent: context?.userAgent || null,
    termsAcceptedAt: new Date().toISOString(),
  };

  const createdShop = await prisma.$transaction(async (tx) => {
    const slug = await ensureUniqueSlug(storeName, tx);
    return tx.shop.create({
      data: {
        name: storeName,
        slug,
        logoUrl,
        plan: 'MAP_ONLY',
        planTier: ShopPlanTier.NONE,
        status: ShopStatus.PENDING_VERIFICATION,
        registrationSource: ShopRegistrationSource.SELF_SERVICE,
        visibilityState: ShopVisibilityState.DIMMED,
        verificationState: ShopVerificationState.UNVERIFIED,
        contactsPublic: false,
        contactEmailPrivate: email,
        contactWhatsappPrivate: whatsapp,
        isGallery: address.isGallery,
        galleryName: address.galleryName,
        galleryLocal: address.galleryLocal,
        galleryFloor: address.galleryFloor,
        addressBase: address.addressBase,
        addressDisplay: address.addressDisplay,
        normalizedAddressBase: address.normalizedAddressBase,
        normalizedName,
        intakeMeta: appendIntakeAudit(
          baseIntakeMeta,
          buildAuditEntry('SELF_REGISTER_CREATED', undefined, null, {
            source: 'self_register',
          })
        ),
        address: address.addressDisplay,
        addressDetails: {
          street: address.street,
          number: address.number,
          city: address.city,
          province: address.province,
          zip: address.zip,
          reference: address.reference,
          isGallery: address.isGallery,
          galleryName: address.galleryName,
          galleryLocal: address.galleryLocal,
          galleryFloor: address.galleryFloor,
          lat: geocode.lat,
          lng: geocode.lng,
          mapsUrl: geocode.mapsUrl,
        },
        minimumPurchase: 0,
        paymentMethods: [],
        statusReason: 'Autoregistro pendiente de revision.',
        statusChangedAt: new Date(),
        streamQuota: 0,
        reelQuota: 0,
        active: true,
      },
      select: shopPrivateSelect,
    });
  });

  await notifyAdmins(`Nueva tienda auto-registrada: ${createdShop.name}.`, {
    type: NotificationType.SYSTEM,
    refId: createdShop.id,
  });

  try {
    const confirmationTemplate = buildSelfRegisterConfirmationEmailTemplate({
      shopName: createdShop.name,
      addressDisplay: createdShop.addressDisplay || createdShop.address || 'Direccion informada',
      appUrl: resolveAppUrl(),
    });
    await sendEmailTemplate(email, confirmationTemplate);
  } catch (error) {
    console.error(`[shops:self-register] No se pudo enviar confirmacion por email a ${email}:`, error);
  }

  return {
    shop: createdShop,
    logoUploadToken: createSelfRegisterUploadToken(createdShop.id),
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
        planTier: resolveShopPlanTier(data.plan || 'ESTANDAR'),
        status,
        registrationSource: ShopRegistrationSource.ADMIN,
        visibilityState: status === ShopStatus.ACTIVE ? ShopVisibilityState.LIT : ShopVisibilityState.HIDDEN,
        verificationState:
          status === ShopStatus.BANNED
            ? ShopVerificationState.REJECTED
            : status === ShopStatus.ACTIVE
              ? ShopVerificationState.VERIFIED
              : ShopVerificationState.UNVERIFIED,
        contactsPublic: true,
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

  if (normalizedEmail && isValidEmail(normalizedEmail) && !requiresEmailFix && firebaseAuth) {
    try {
      await ensureFirebaseUser(normalizedEmail);
      const resetLink = await firebaseAuth.generatePasswordResetLink(normalizedEmail);
      await sendShopAccessEmail({
        email: normalizedEmail,
        shopName: normalizeText(createdShop.name) || 'Tu tienda',
        resetUrl: resetLink,
        mode: 'invite',
      });
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
    plan: data.plan,
    planTier: data.plan !== undefined ? resolveShopPlanTier(data.plan) : undefined,
    registrationSource: data.registrationSource,
    visibilityState: data.visibilityState,
    verificationState: data.verificationState,
    contactsPublic: data.contactsPublic,
    contactEmailPrivate: data.contactEmailPrivate,
    contactWhatsappPrivate: data.contactWhatsappPrivate,
    isGallery: data.isGallery,
    galleryName: data.galleryName,
    galleryLocal: data.galleryLocal,
    galleryFloor: data.galleryFloor,
    addressBase: data.addressBase,
    addressDisplay: data.addressDisplay,
    normalizedAddressBase: data.normalizedAddressBase,
    normalizedName: data.normalizedName,
    intakeMeta: data.intakeMeta,
    streamQuota: data.streamQuota,
    reelQuota: data.reelQuota,
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
    const shouldSyncPlanQuota = data.plan !== undefined;
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

    if (shouldSyncPlanQuota) {
      await syncQuotaWalletToPlan(updatedShop.id, updatedShop.plan, tx);
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
  const canAutoApprove =
    shop.status === ShopStatus.PENDING_VERIFICATION &&
    shop.active !== false &&
    hasValidEmail &&
    hasIdentity &&
    hasAddress &&
    hasSales;

  const updated = await prisma.$transaction(async (tx) => {
    const updatedShop = await tx.shop.update({
      where: { id },
      data: {
        ownerAcceptedAt: shop.ownerAcceptedAt || new Date(),
        ...(canAutoApprove
          ? {
              status: ShopStatus.ACTIVE,
              visibilityState: ShopVisibilityState.LIT,
              verificationState: ShopVerificationState.VERIFIED,
              contactsPublic: true,
              planTier: resolveShopPlanTier(shop.plan),
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
  void id;
  throw new Error('Penalty legacy desactivado. Usar suspension de agenda y auditoria.');
};

export const activateShop = async (id: string, reason?: string, actor?: ModerationActor) => {
  return prisma.$transaction(async (tx) => {
    const currentShop = await tx.shop.findUnique({
      where: { id },
      select: { intakeMeta: true },
    });
    if (!currentShop) {
      throw new Error('Tienda no encontrada.');
    }

    const updatedShop = await tx.shop.update({
      where: { id },
      data: {
        status: ShopStatus.ACTIVE,
        visibilityState: ShopVisibilityState.LIT,
        verificationState: ShopVerificationState.VERIFIED,
        contactsPublic: true,
        statusReason: reason || null,
        statusChangedAt: new Date(),
        active: true,
        agendaSuspendedUntil: null,
        agendaSuspendedByAdminId: null,
        agendaSuspendedReason: null,
        intakeMeta: appendIntakeAudit(
          currentShop.intakeMeta,
          buildAuditEntry('SHOP_ACTIVATED', actor, reason || null, {
            status: ShopStatus.ACTIVE,
            visibilityState: ShopVisibilityState.LIT,
          })
        ),
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

export const suspendAgenda = async (
  id: string,
  reason?: string,
  days = 7,
  actor?: ModerationActor
) => {
  const suspendedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const currentShop = await prisma.shop.findUnique({
    where: { id },
    select: { intakeMeta: true },
  });
  if (!currentShop) {
    throw new Error('Tienda no encontrada.');
  }

  const updatedShop = await prisma.shop.update({
    where: { id },
    data: {
      status: ShopStatus.AGENDA_SUSPENDED,
      statusReason: reason || 'Agenda suspendida',
      statusChangedAt: new Date(),
      agendaSuspendedUntil: suspendedUntil,
      agendaSuspendedReason: reason || 'Agenda suspendida',
      intakeMeta: appendIntakeAudit(
        currentShop.intakeMeta,
        buildAuditEntry('AGENDA_SUSPENDED', actor, reason || null, {
          suspendedUntil: suspendedUntil.toISOString(),
          days,
        })
      ),
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

export const liftAgendaSuspension = async (id: string, actor?: ModerationActor) => {
  return prisma.$transaction(async (tx) => {
    const currentShop = await tx.shop.findUnique({
      where: { id },
      select: { intakeMeta: true },
    });
    if (!currentShop) {
      throw new Error('Tienda no encontrada.');
    }

    const updatedShop = await tx.shop.update({
      where: { id },
      data: {
        status: ShopStatus.ACTIVE,
        visibilityState: ShopVisibilityState.LIT,
        verificationState: ShopVerificationState.VERIFIED,
        statusReason: null,
        statusChangedAt: new Date(),
        agendaSuspendedUntil: null,
        agendaSuspendedReason: null,
        agendaSuspendedByAdminId: null,
        intakeMeta: appendIntakeAudit(
          currentShop.intakeMeta,
          buildAuditEntry('AGENDA_SUSPENSION_LIFTED', actor, null, {
            status: ShopStatus.ACTIVE,
          })
        ),
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

export const rejectShop = async (id: string, reason?: string, actor?: ModerationActor) => {
  return prisma.$transaction(async (tx) => {
    const currentShop = await tx.shop.findUnique({
      where: { id },
      select: { intakeMeta: true },
    });
    if (!currentShop) {
      throw new Error('Tienda no encontrada.');
    }

    const updatedShop = await tx.shop.update({
      where: { id },
      data: {
        status: ShopStatus.HIDDEN,
        visibilityState: ShopVisibilityState.HIDDEN,
        verificationState: ShopVerificationState.REJECTED,
        contactsPublic: false,
        statusReason: reason || 'Solicitud rechazada',
        statusChangedAt: new Date(),
        intakeMeta: appendIntakeAudit(
          currentShop.intakeMeta,
          buildAuditEntry('SHOP_REJECTED', actor, reason || null, {
            status: ShopStatus.HIDDEN,
            visibilityState: ShopVisibilityState.HIDDEN,
          })
        ),
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
    select: { id: true, name: true, email: true },
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
  const shopName = normalizeText(shop.name) || 'Tu tienda';
  let emailSent = false;
  try {
    await sendShopAccessEmail({
      email,
      shopName,
      resetUrl: resetLink,
      mode: 'reset',
    });
    emailSent = true;
  } catch (error) {
    console.error(`[shops:reset-password] No se pudo enviar email a ${email}:`, error);
  }

  return { resetLink, emailSent };
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
  if (!firebaseAuth) {
    throw new Error('Firebase Admin no configurado.');
  }
  const resetLink = await firebaseAuth.generatePasswordResetLink(email);
  await sendShopAccessEmail({
    email,
    shopName: normalizeText(shop.name) || 'Tu tienda',
    resetUrl: resetLink,
    mode: 'invite',
  });
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
