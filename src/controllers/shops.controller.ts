import { Request, Response } from 'express';
import * as ShopsService from '../services/shops.service';

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
  const limit = ShopsService.getWhatsappLimit(shop.plan);
  return { ...shop, whatsappLines: lines.slice(0, limit) };
};

const sanitizeShopPayload = (payload: any, req: Request) => {
  const sanitizeOne = (shop: any) => applyWhatsappPrivacy(stripShopPrivateFields(shop), req);
  if (Array.isArray(payload)) return payload.map(sanitizeOne);
  return sanitizeOne(payload);
};

export const getShops = async (req: Request, res: Response) => {
  try {
    const limit = Number(req.query?.limit);
    const offset = Number(req.query?.offset);
    const data = await ShopsService.getShops({ limit, offset });
    res.json(sanitizeShopPayload(data, req));
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener tiendas', error });
  }
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
  try {
    const data = await ShopsService.getShopsMapData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener mapa de tiendas', error });
  }
};

// --- NUEVA FUNCIÓN AGREGADA: El "Mozo" toma el pedido de crear tienda ---
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

export const updateShop = async (req: Request, res: Response) => {
  try {
    const data = await ShopsService.updateShop(req.params.id, req.body);
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
  try {
    const data = await ShopsService.togglePenalty(req.params.id);
    res.json(sanitizeShopPayload(data, req));
  } catch (error) {
    res.status(500).json({ message: 'Error al cambiar penalización', error });
  }
};

export const activateShop = async (req: Request, res: Response) => {
  try {
    const data = await ShopsService.activateShop(req.params.id, req.body?.reason);
    res.json(sanitizeShopPayload(data, req));
  } catch (error) {
    res.status(500).json({ message: 'Error al activar tienda', error });
  }
};

export const rejectShop = async (req: Request, res: Response) => {
  try {
    const data = await ShopsService.rejectShop(req.params.id, req.body?.reason);
    res.json(sanitizeShopPayload(data, req));
  } catch (error) {
    res.status(500).json({ message: 'Error al rechazar tienda', error });
  }
};

export const suspendAgenda = async (req: Request, res: Response) => {
  try {
    const days = Number(req.body?.days || 7);
    const data = await ShopsService.suspendAgenda(req.params.id, req.body?.reason, days);
    res.json(sanitizeShopPayload(data, req));
  } catch (error) {
    res.status(500).json({ message: 'Error al suspender agenda', error });
  }
};

export const liftAgendaSuspension = async (req: Request, res: Response) => {
  try {
    const data = await ShopsService.liftAgendaSuspension(req.params.id);
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
    res.status(400).json({ message: error.message || 'Error al asignar dueño', error });
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
