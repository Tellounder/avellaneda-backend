import { Request, Response } from 'express';
import * as ShopsService from './service';
import { getOrSetCache } from '../../utils/publicCache';

const SHOPS_CACHE_MS = 30_000;
const SHOPS_MAP_CACHE_MS = 120_000;
const FEATURED_SHOPS_CACHE_MS = 60_000;
const LETTER_SHOPS_CACHE_MS = 120_000;

const sanitizeAddressDetails = (details: any) => {
  if (!details || typeof details !== 'object') return null;
  const {
    lat,
    lng,
    zip,
    city,
    number,
    street,
    province,
    mapsUrl,
    catalogUrl,
    imageUrl,
    storeImageUrl,
    contactName,
    reference,
    isGallery,
    galleryName,
    galleryLocal,
    galleryFloor,
  } = details;
  return {
    ...(lat !== undefined ? { lat } : {}),
    ...(lng !== undefined ? { lng } : {}),
    ...(zip ? { zip } : {}),
    ...(city ? { city } : {}),
    ...(number ? { number } : {}),
    ...(street ? { street } : {}),
    ...(province ? { province } : {}),
    ...(mapsUrl ? { mapsUrl } : {}),
    ...(catalogUrl ? { catalogUrl } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(storeImageUrl ? { storeImageUrl } : {}),
    ...(contactName ? { contactName } : {}),
    ...(reference ? { reference } : {}),
    ...(isGallery !== undefined ? { isGallery: Boolean(isGallery) } : {}),
    ...(galleryName ? { galleryName } : {}),
    ...(galleryLocal ? { galleryLocal } : {}),
    ...(galleryFloor ? { galleryFloor } : {}),
  };
};

const sanitizeSocialHandles = (handles: any) =>
  Array.isArray(handles)
    ? handles
        .map((handle) => ({
          platform: handle?.platform,
          handle: handle?.handle,
        }))
        .filter((handle) => handle.platform && handle.handle)
    : [];

const sanitizeWhatsappLines = (lines: any) =>
  Array.isArray(lines)
    ? lines
        .map((line) => ({
          label: line?.label,
          number: line?.number,
        }))
        .filter((line) => line.label && line.number)
    : [];

const sanitizeShopBase = (shop: any) => {
  if (!shop) return shop;
  return {
    id: shop.id,
    name: shop.name,
    slug: shop.slug,
    logoUrl: shop.logoUrl ?? null,
    coverUrl: shop.coverUrl ?? null,
    website: shop.website ?? null,
    address: shop.address ?? null,
    addressDetails: sanitizeAddressDetails(shop.addressDetails),
    minimumPurchase: shop.minimumPurchase ?? 0,
    paymentMethods: Array.isArray(shop.paymentMethods) ? shop.paymentMethods : [],
    plan: shop.plan,
    planTier: shop.planTier ?? null,
    status: shop.status,
    registrationSource: shop.registrationSource ?? null,
    visibilityState: shop.visibilityState ?? null,
    verificationState: shop.verificationState ?? null,
    contactsPublic: shop.contactsPublic !== false,
    isGallery: Boolean(shop.isGallery),
    galleryName: shop.galleryName ?? null,
    galleryLocal: shop.galleryLocal ?? null,
    galleryFloor: shop.galleryFloor ?? null,
    addressBase: shop.addressBase ?? null,
    addressDisplay: shop.addressDisplay ?? null,
    statusReason: shop.statusReason ?? null,
    statusChangedAt: shop.statusChangedAt ?? null,
    ownerAcceptedAt: shop.ownerAcceptedAt ?? null,
    agendaSuspendedUntil: shop.agendaSuspendedUntil ?? null,
    agendaSuspendedReason: shop.agendaSuspendedReason ?? null,
    streamQuota: shop.streamQuota ?? 0,
    reelQuota: shop.reelQuota ?? 0,
    active: Boolean(shop.active),
    createdAt: shop.createdAt,
    updatedAt: shop.updatedAt,
    ratingAverage: typeof shop.ratingAverage === 'number' ? shop.ratingAverage : 0,
    ratingCount: typeof shop.ratingCount === 'number' ? shop.ratingCount : 0,
    socialHandles: sanitizeSocialHandles(shop.socialHandles),
    whatsappLines: sanitizeWhatsappLines(shop.whatsappLines),
    ...(shop.authUserId ? { authUserId: shop.authUserId } : {}),
    ...(shop.email ? { email: shop.email } : {}),
    ...(shop.contactEmailPrivate ? { contactEmailPrivate: shop.contactEmailPrivate } : {}),
    ...(shop.contactWhatsappPrivate ? { contactWhatsappPrivate: shop.contactWhatsappPrivate } : {}),
    ...(shop.razonSocial ? { razonSocial: shop.razonSocial } : {}),
    ...(shop.cuit ? { cuit: shop.cuit } : {}),
  };
};

const applyVisibilityRules = (shop: any, req: Request) => {
  if (!shop) return shop;
  const base = sanitizeShopBase(shop);
  const hidePublicContacts =
    base.contactsPublic === false || base.visibilityState === 'DIMMED';
  if (!req.auth) {
    return {
      ...base,
      authUserId: undefined,
      email: hidePublicContacts ? undefined : base.email,
      contactEmailPrivate: undefined,
      contactWhatsappPrivate: undefined,
      razonSocial: undefined,
      cuit: undefined,
      whatsappLines: hidePublicContacts ? [] : base.whatsappLines,
      socialHandles: hidePublicContacts ? [] : base.socialHandles,
    };
  }
  if (req.auth.userType === 'ADMIN') {
    return base;
  }
  if (req.auth.userType === 'SHOP' && req.auth.shopId === shop.id) {
    return base;
  }
  return {
    ...base,
    email: hidePublicContacts ? undefined : base.email,
    authUserId: undefined,
    contactEmailPrivate: undefined,
    contactWhatsappPrivate: undefined,
    razonSocial: undefined,
    cuit: undefined,
    whatsappLines: hidePublicContacts ? [] : base.whatsappLines,
    socialHandles: hidePublicContacts ? [] : base.socialHandles,
  };
};

const sanitizeShopPayload = (payload: any, req: Request) => {
  const sanitizeOne = (shop: any) => applyVisibilityRules(shop, req);
  if (Array.isArray(payload)) return payload.map(sanitizeOne);
  return sanitizeOne(payload);
};

const buildModerationActor = (req: Request) => ({
  authUserId: req.auth?.authUserId || null,
  email: req.auth?.email || null,
  userType: req.auth?.userType || null,
});

export const getShops = async (req: Request, res: Response) => {
  const limit = Number(req.query?.limit);
  const offset = Number(req.query?.offset);
  const includePrivate =
    req.auth?.userType === 'ADMIN' || req.auth?.userType === 'SHOP';
  const cacheKey = `shops:list:${includePrivate ? 'private' : 'public'}:${Number.isFinite(limit) ? limit : 'all'}:${Number.isFinite(offset) ? offset : 0}`;
  const data = await getOrSetCache(cacheKey, SHOPS_CACHE_MS, () =>
    includePrivate ? ShopsService.getShops({ limit, offset }) : ShopsService.getPublicShops({ limit, offset })
  );
  res.json(sanitizeShopPayload(data, req));
};

export const getShopById = async (req: Request, res: Response) => {
  try {
    const data = await ShopsService.getShopById(req.params.id);
    if (!data) {
      return res.status(404).json({ message: 'Tienda no encontrada' });
    }
    res.json(sanitizeShopPayload(data, req));
  } catch (error) {
    res.status(500).json({ message: 'Error al buscar tienda', error });
  }
};

export const getShopsMapData = async (_req: Request, res: Response) => {
  const data = await getOrSetCache('shops:map-data', SHOPS_MAP_CACHE_MS, () => ShopsService.getShopsMapData());
  res.json(data);
};

export const getFeaturedShops = async (req: Request, res: Response) => {
  const limit = Number(req.query?.limit);
  const cacheKey = `shops:featured:${Number.isFinite(limit) ? limit : 'default'}`;
  const data = await getOrSetCache(cacheKey, FEATURED_SHOPS_CACHE_MS, () =>
    ShopsService.getFeaturedShops({ limit })
  );
  res.json(sanitizeShopPayload(data, req));
};

export const getShopsByLetter = async (req: Request, res: Response) => {
  const letter = String(req.query?.letter || '').trim().toUpperCase();
  const limit = Number(req.query?.limit);
  const offset = Number(req.query?.offset);
  const isAdmin = req.auth?.userType === 'ADMIN';
  const scope = isAdmin ? 'admin' : 'public';
  const cacheKey = `shops:letter:${scope}:${letter || 'none'}:${Number.isFinite(limit) ? limit : 'all'}:${Number.isFinite(offset) ? offset : 0}`;
  const data = await getOrSetCache(cacheKey, LETTER_SHOPS_CACHE_MS, () =>
    isAdmin
      ? ShopsService.getShopsByLetter({ letter, limit, offset })
      : ShopsService.getPublicShopsByLetter(letter, { limit, offset })
  );
  if (data && typeof data === 'object' && 'items' in (data as any)) {
    const payload = data as { items: any[]; hasMore: boolean };
    res.json({
      items: sanitizeShopPayload(payload.items, req),
      hasMore: payload.hasMore,
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    return;
  }
  res.json(sanitizeShopPayload(data, req));
};

// --- NUEVA FUNCIÃ“N AGREGADA: El "Mozo" toma el pedido de crear tienda ---
export const createShop = async (req: Request, res: Response) => {
  try {
    // Le pasamos los datos que vienen del formulario (req.body) al Servicio
    const data = await ShopsService.createShop(req.body);
    // Respondemos con exito (codigo 201 significa "Creado")
    res.status(201).json(sanitizeShopPayload(data, req));
  } catch (error) {
    console.error(error); // Para ver el error en la consola si falla
    res.status(500).json({ message: 'Error al crear la tienda', error });
  }
};
// -----------------------------------------------------------------------

export const selfRegisterShop = async (req: Request, res: Response) => {
  try {
    const rawUserAgent = req.headers['user-agent'];
    const userAgent = typeof rawUserAgent === 'string' ? rawUserAgent : null;
    const data = await ShopsService.createSelfRegisteredShop(req.body, {
      ip: req.ip,
      userAgent,
    });
    res.status(201).json(sanitizeShopPayload(data, req));
  } catch (error: any) {
    const status = Number(error?.status) || 500;
    res.status(status).json({
      message: error?.message || 'Error al registrar tienda.',
    });
  }
};

export const updateShop = async (req: Request, res: Response) => {
  try {
    const payload =
      req.auth?.userType === 'SHOP'
        ? (() => {
            const { name, razonSocial, ...rest } = req.body || {};
            return rest;
          })()
        : req.body;
    const data = await ShopsService.updateShop(req.params.id, payload);
    res.json(sanitizeShopPayload(data, req));
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar tienda', error });
  }
};

export const buyStreamQuota = async (req: Request, res: Response) => {
  try {
    const data = await ShopsService.buyStreamQuota(req.params.id, req.body.amount, req.auth || undefined);
    res.json({ shop: sanitizeShopPayload(data.shop, req), purchase: data.purchase });
  } catch (error: any) {
    res.status(400).json({ message: error.message || 'Error al comprar cupo de stream', error });
  }
};

export const buyReelQuota = async (req: Request, res: Response) => {
  try {
    const data = await ShopsService.buyReelQuota(req.params.id, req.body.amount, req.auth || undefined);
    res.json({ shop: sanitizeShopPayload(data.shop, req), purchase: data.purchase });
  } catch (error: any) {
    res.status(400).json({ message: error.message || 'Error al comprar cupo de reel', error });
  }
};

export const togglePenalty = async (req: Request, res: Response) => {
  res.status(410).json({
    message: 'Penalty legacy desactivado. Usar suspension de agenda y auditoria.',
  });
};

export const activateShop = async (req: Request, res: Response) => {
  try {
    const data = await ShopsService.activateShop(
      req.params.id,
      req.body?.reason,
      buildModerationActor(req)
    );
    res.json(sanitizeShopPayload(data, req));
  } catch (error) {
    res.status(500).json({ message: 'Error al activar tienda', error });
  }
};

export const rejectShop = async (req: Request, res: Response) => {
  try {
    const data = await ShopsService.rejectShop(
      req.params.id,
      req.body?.reason,
      buildModerationActor(req)
    );
    res.json(sanitizeShopPayload(data, req));
  } catch (error) {
    res.status(500).json({ message: 'Error al rechazar tienda', error });
  }
};

export const suspendAgenda = async (req: Request, res: Response) => {
  try {
    const days = Number(req.body?.days || 7);
    const data = await ShopsService.suspendAgenda(
      req.params.id,
      req.body?.reason,
      days,
      buildModerationActor(req)
    );
    res.json(sanitizeShopPayload(data, req));
  } catch (error) {
    res.status(500).json({ message: 'Error al suspender agenda', error });
  }
};

export const liftAgendaSuspension = async (req: Request, res: Response) => {
  try {
    const data = await ShopsService.liftAgendaSuspension(req.params.id, buildModerationActor(req));
    res.json(sanitizeShopPayload(data, req));
  } catch (error) {
    res.status(500).json({ message: 'Error al levantar sancion', error });
  }
};

export const resetShopPassword = async (req: Request, res: Response) => {
  try {
    const data = await ShopsService.resetShopPassword(req.params.id);
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: 'Error al resetear clave', error });
  }
};

export const sendShopInvite = async (req: Request, res: Response) => {
  try {
    const data = await ShopsService.sendShopInvite(req.params.id);
    res.json(data);
  } catch (error: any) {
    res.status(400).json({ message: error.message || 'Error al enviar invitacion', error });
  }
};

export const deleteShop = async (req: Request, res: Response) => {
  try {
    const data = await ShopsService.deleteShop(req.params.id);
    res.json(data);
  } catch (error: any) {
    res.status(400).json({ message: error.message || 'Error al eliminar tienda', error });
  }
};

export const acceptShop = async (req: Request, res: Response) => {
  try {
    const data = await ShopsService.acceptShop(req.params.id, req.auth?.authUserId || '');
    res.json(sanitizeShopPayload(data, req));
  } catch (error: any) {
    res.status(400).json({ message: error.message || 'Error al aceptar tienda', error });
  }
};

export const assignOwner = async (req: Request, res: Response) => {
  try {
    const data = await ShopsService.assignOwner(req.params.id, req.body);
    res.json(sanitizeShopPayload(data, req));
  } catch (error: any) {
    res.status(400).json({ message: error.message || 'Error al asignar dueÃ±o', error });
  }
};

export const checkShopEmail = async (req: Request, res: Response) => {
  try {
    const email = String(req.query.email || '').trim();
    if (!email) {
      return res.status(400).json({ message: 'Email requerido.' });
    }
    const exists = await ShopsService.isShopEmail(email);
    res.json({ exists });
  } catch (error) {
    res.status(500).json({ message: 'Error al validar email', error });
  }
};
