import { Request, Response } from 'express';
import * as StreamsService from '../services/streams.service';
import { getWhatsappLimit } from '../services/shops.service';

const stripShopPrivateFields = (shop: any) => {
  if (!shop) return shop;
  const { authUserId, requiresEmailFix, ...rest } = shop;
  return rest;
};

const applyWhatsappPrivacy = (shop: any, req: Request) => {
  if (!shop) return shop;
  const lines = Array.isArray(shop.whatsappLines) ? shop.whatsappLines : [];
  if (!req.auth) {
    return { ...shop, whatsappLines: [] };
  }
  if (req.auth.userType === 'ADMIN') {
    return shop;
  }
  if (req.auth.userType === 'SHOP' && req.auth.shopId === shop.id) {
    return shop;
  }
  const limit = getWhatsappLimit(shop.plan);
  return { ...shop, whatsappLines: lines.slice(0, limit) };
};

const sanitizeStreamPayload = (payload: any, req: Request) => {
  if (!payload) return payload;
  const sanitizeOne = (stream: any) => {
    if (stream?.shop) {
      stream.shop = applyWhatsappPrivacy(stripShopPrivateFields(stream.shop), req);
    }
    return stream;
  };
  if (Array.isArray(payload)) return payload.map(sanitizeOne);
  return sanitizeOne(payload);
};

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

export const getStreams = async (req: Request, res: Response) => {
  try {
    const data = await StreamsService.getStreams();
    res.json(sanitizeStreamPayload(data, req));
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener vivos', error });
  }
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
    const data = await StreamsService.createStream(req.body);
    res.json(sanitizeStreamPayload(data, req));
  } catch (error: any) {
    res.status(400).json({ message: error.message || 'Error al crear vivo', error });
  }
};

export const updateStream = async (req: Request, res: Response) => {
  try {
    await ensureStreamAccess(req, req.params.id);
    const data = await StreamsService.updateStream(req.params.id, req.body);
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
