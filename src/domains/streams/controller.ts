import { Request, Response } from 'express';
import * as StreamsService from './service';
import { getOrSetCache } from '../../utils/publicCache';

const STREAMS_CACHE_MS = 15_000;

const sanitizeAddressDetails = (details: any) => {
  if (!details || typeof details !== 'object') return null;
  const { lat, lng, mapsUrl, catalogUrl } = details;
  return {
    ...(lat !== undefined ? { lat } : {}),
    ...(lng !== undefined ? { lng } : {}),
    ...(mapsUrl ? { mapsUrl } : {}),
    ...(catalogUrl ? { catalogUrl } : {}),
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

const sanitizeStreamShop = (shop: any) => {
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
    status: shop.status,
    active: Boolean(shop.active),
    socialHandles: sanitizeSocialHandles(shop.socialHandles),
    whatsappLines: sanitizeWhatsappLines(shop.whatsappLines),
  };
};

const applyVisibilityRules = (shop: any, req: Request) => {
  if (!shop) return shop;
  const safeShop = sanitizeStreamShop(shop);
  if (!req.auth) {
    return { ...safeShop, whatsappLines: [], socialHandles: [] };
  }
  if (req.auth.userType === 'ADMIN') {
    return safeShop;
  }
  if (req.auth.userType === 'SHOP' && req.auth.shopId === shop.id) {
    return safeShop;
  }
  return safeShop;
};

const sanitizeStreamPayload = (payload: any, req: Request) => {
  if (!payload) return payload;
  const sanitizeOne = (stream: any) => {
    if (!stream) return stream;
    const next = { ...stream };
    if (stream.shop) {
      next.shop = applyVisibilityRules(stream.shop, req);
    }
    return next;
  };
  if (Array.isArray(payload)) return payload.map(sanitizeOne);
  return sanitizeOne(payload);
};

const formatICSDate = (date: Date) =>
  date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

const escapeICSValue = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n');

const ensureStreamAccess = async (req: Request, streamId: string) => {
  if (!req.auth) {
    throw { status: 401, message: 'Autenticacion requerida.' };
  }
  if (req.auth.userType === 'ADMIN') return;
  if (req.auth.userType !== 'SHOP') {
    throw { status: 403, message: 'Permisos insuficientes.' };
  }
  const stream = await StreamsService.getStreamById(streamId);
  if (!stream) {
    throw { status: 404, message: 'Vivo no encontrado.' };
  }
  if (stream.shopId !== req.auth.shopId) {
    throw { status: 403, message: 'Acceso denegado.' };
  }
};

export const getStreamCalendar = async (req: Request, res: Response) => {
  try {
    const stream = await StreamsService.getStreamById(req.params.id);
    if (!stream) {
      return res.status(404).send('Vivo no encontrado.');
    }
    if ((stream as any).hidden) {
      return res.status(404).send('Vivo no disponible.');
    }
    const start = new Date((stream as any).scheduledAt || Date.now());
    const end =
      (stream as any).scheduledEndPlanned
        ? new Date((stream as any).scheduledEndPlanned)
        : new Date(start.getTime() + 30 * 60 * 1000);
    const title = (stream as any).title || 'Vivo en Avellaneda en Vivo';
    const shopName = (stream as any).shop?.name || 'Distrito Moda';
    const location = (stream as any).shop?.address || 'Avellaneda en Vivo';
    const detailsParts = [`Tienda: ${shopName}`];
    if ((stream as any).url) {
      detailsParts.push(`Enlace: ${(stream as any).url}`);
    }

    const icsContent = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Distrito Moda//Avellaneda en Vivo//ES',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${(stream as any).id}@avellaneda-envivo`,
      `DTSTAMP:${formatICSDate(new Date())}`,
      `DTSTART:${formatICSDate(start)}`,
      `DTEND:${formatICSDate(end)}`,
      `SUMMARY:${escapeICSValue(title)}`,
      `DESCRIPTION:${escapeICSValue(detailsParts.join('\n'))}`,
      `LOCATION:${escapeICSValue(location)}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="avellaneda-en-vivo-${(stream as any).id}.ics"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(icsContent);
  } catch (error) {
    return res.status(500).send('Error al generar calendario.');
  }
};

export const getStreams = async (req: Request, res: Response) => {
  const data = await getOrSetCache('streams:all', STREAMS_CACHE_MS, () => StreamsService.getStreams());
  res.json(sanitizeStreamPayload(data, req));
};

export const getStreamById = async (req: Request, res: Response) => {
  try {
    const data = await StreamsService.getStreamById(req.params.id);
    res.json(sanitizeStreamPayload(data, req));
  } catch (error) {
    res.status(500).json({ message: 'Error al buscar vivo', error });
  }
};

export const createStream = async (req: Request, res: Response) => {
  try {
    if (!req.auth) {
      return res.status(401).json({ message: 'Autenticacion requerida.' });
    }
    if (req.auth.userType === 'SHOP') {
      const requestedShopId = req.body?.shopId || req.body?.shop?.id;
      if (!requestedShopId || requestedShopId !== req.auth.shopId) {
        return res.status(403).json({ message: 'Acceso denegado.' });
      }
    } else if (req.auth.userType !== 'ADMIN') {
      return res.status(403).json({ message: 'Permisos insuficientes.' });
    }
    const isAdminOverride =
      req.auth.userType === 'ADMIN' ? Boolean(req.body?.isAdminOverride) : false;
    const data = await StreamsService.createStream({
      ...req.body,
      isAdminOverride,
    });
    res.json(sanitizeStreamPayload(data, req));
  } catch (error: any) {
    res.status(400).json({ message: error.message || 'Error al crear vivo', error });
  }
};

export const updateStream = async (req: Request, res: Response) => {
  try {
    await ensureStreamAccess(req, req.params.id);
    const isAdminOverride =
      req.auth?.userType === 'ADMIN' ? Boolean(req.body?.isAdminOverride) : false;
    const data = await StreamsService.updateStream(req.params.id, {
      ...req.body,
      isAdminOverride,
    });
    res.json(sanitizeStreamPayload(data, req));
  } catch (error: any) {
    const status = error?.status || 400;
    res.status(status).json({ message: error.message || 'Error al actualizar vivo', error });
  }
};

export const deleteStream = async (req: Request, res: Response) => {
  try {
    await ensureStreamAccess(req, req.params.id);
    const data = await StreamsService.deleteStream(req.params.id);
    res.json(sanitizeStreamPayload(data, req));
  } catch (error) {
    const status = (error as any)?.status || 500;
    res.status(status).json({ message: 'Error al eliminar vivo', error });
  }
};

export const goLive = async (req: Request, res: Response) => {
  try {
    await ensureStreamAccess(req, req.params.id);
    const data = await StreamsService.goLive(req.params.id);
    res.json(sanitizeStreamPayload(data, req));
  } catch (error) {
    const status = (error as any)?.status || 500;
    res.status(status).json({ message: 'Error al iniciar vivo', error });
  }
};

export const continueLive = async (req: Request, res: Response) => {
  try {
    await ensureStreamAccess(req, req.params.id);
    const data = await StreamsService.continueLive(req.params.id);
    res.json(sanitizeStreamPayload(data, req));
  } catch (error) {
    const status = (error as any)?.status || 500;
    res.status(status).json({ message: 'Error al continuar vivo', error });
  }
};

export const finishStream = async (req: Request, res: Response) => {
  try {
    await ensureStreamAccess(req, req.params.id);
    const data = await StreamsService.finishStream(req.params.id);
    res.json(sanitizeStreamPayload(data, req));
  } catch (error) {
    const status = (error as any)?.status || 500;
    res.status(status).json({ message: 'Error al finalizar vivo', error });
  }
};

export const reportStream = async (req: Request, res: Response) => {
  try {
    if (!req.auth || req.auth.userType !== 'CLIENT') {
      return res.status(403).json({ message: 'Debes iniciar sesion como cliente.' });
    }
    const data = await StreamsService.reportStream(req.params.id, req.auth.authUserId, {
      reason: req.body?.reason,
    });
    res.json(data);
  } catch (error: any) {
    res.status(400).json({ message: error.message || 'Error al reportar vivo', error });
  }
};

export const rateStream = async (req: Request, res: Response) => {
  try {
    if (!req.auth || req.auth.userType !== 'CLIENT') {
      return res.status(403).json({ message: 'Debes iniciar sesion como cliente.' });
    }
    const data = await StreamsService.rateStream(req.params.id, req.body, req.auth.authUserId);
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: 'Error al calificar vivo', error });
  }
};

export const toggleLikeStream = async (req: Request, res: Response) => {
  try {
    if (!req.auth || req.auth.userType !== 'CLIENT') {
      return res.status(403).json({ message: 'Debes iniciar sesion como cliente.' });
    }
    const data = await StreamsService.toggleLikeStream(req.params.id, req.auth.authUserId);
    res.json(data);
  } catch (error: any) {
    res.status(400).json({ message: error.message || 'Error al marcar me gusta', error });
  }
};

export const hideStream = async (req: Request, res: Response) => {
  try {
    const data = await StreamsService.hideStream(req.params.id);
    res.json(sanitizeStreamPayload(data, req));
  } catch (error) {
    res.status(500).json({ message: 'Error al ocultar vivo', error });
  }
};

export const showStream = async (req: Request, res: Response) => {
  try {
    const data = await StreamsService.showStream(req.params.id);
    res.json(sanitizeStreamPayload(data, req));
  } catch (error) {
    res.status(500).json({ message: 'Error al mostrar vivo', error });
  }
};

export const registerStreamView = async (req: Request, res: Response) => {
  try {
    const forwardedFor = req.headers['x-forwarded-for'];
    const firstForwardedIp =
      Array.isArray(forwardedFor) ? forwardedFor[0] : String(forwardedFor || '').split(',')[0]?.trim();
    const ip = firstForwardedIp || req.ip || 'unknown-ip';
    const userAgent = String(req.headers['user-agent'] || 'unknown-ua').slice(0, 120);
    const viewerKey = `${ip}|${userAgent}`;
    const data = await StreamsService.registerStreamView(req.params.id, viewerKey);
    res.json(data);
  } catch (error: any) {
    res.status(400).json({ message: error.message || 'Error al registrar vista', error });
  }
};

export const cancelStream = async (req: Request, res: Response) => {
  try {
    await ensureStreamAccess(req, req.params.id);
    const data = await StreamsService.cancelStream(req.params.id, req.body?.reason);
    res.json(sanitizeStreamPayload(data, req));
  } catch (error: any) {
    const status = error?.status || 400;
    res.status(status).json({ message: error.message || 'Error al cancelar vivo', error });
  }
};

export const banStream = async (req: Request, res: Response) => {
  try {
    const data = await StreamsService.banStream(req.params.id, req.body?.reason);
    res.json(sanitizeStreamPayload(data, req));
  } catch (error: any) {
    res.status(400).json({ message: error.message || 'Error al bloquear vivo', error });
  }
};

export const runStreamLifecycle = async (_req: Request, res: Response) => {
  try {
    const data = await StreamsService.runStreamLifecycle();
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: 'Error al ejecutar ciclo de vivos', error });
  }
};
