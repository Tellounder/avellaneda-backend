import { Request, Response } from 'express';
import * as ReelsService from '../services/reels.service';
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

const sanitizeReelPayload = (payload: any, req: Request) => {
  if (!payload) return payload;
  const sanitizeOne = (reel: any) => {
    if (reel?.shop) {
      reel.shop = applyWhatsappPrivacy(stripShopPrivateFields(reel.shop), req);
    }
    return reel;
  };
  if (Array.isArray(payload)) return payload.map(sanitizeOne);
  return sanitizeOne(payload);
};

export const getActiveReels = async (req: Request, res: Response) => {
  const data = await ReelsService.getActiveReels();
  res.json(sanitizeReelPayload(data, req));
};

export const getAllReelsAdmin = async (req: Request, res: Response) => {
  const data = await ReelsService.getAllReelsAdmin();
  res.json(sanitizeReelPayload(data, req));
};

export const getReelsByShop = async (req: Request, res: Response) => {
  const data = await ReelsService.getReelsByShop(req.params.shopId);
  res.json(sanitizeReelPayload(data, req));
};

export const createReel = async (req: Request, res: Response) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Autenticacion requerida.' });
  }
  if (req.auth.userType === 'SHOP' && req.auth.shopId !== req.body?.shopId) {
    return res.status(403).json({ message: 'Acceso denegado.' });
  }
  if (req.auth.userType !== 'SHOP' && req.auth.userType !== 'ADMIN') {
    return res.status(403).json({ message: 'Permisos insuficientes.' });
  }
  const { shopId, type, videoUrl, photoUrls, thumbnailUrl, durationSeconds, platform, status, processingJobId } = req.body;
  const isAdminOverride =
    req.auth.userType === 'ADMIN' ? Boolean(req.body?.isAdminOverride ?? true) : false;
  const data = await ReelsService.createReel(
    {
      shopId,
      type,
      platform,
      videoUrl,
      photoUrls,
      thumbnailUrl,
      durationSeconds,
      status,
      processingJobId,
    },
    { isAdminOverride }
  );
  res.json(sanitizeReelPayload(data, req));
};

export const hideReel = async (req: Request, res: Response) => {
  const data = await ReelsService.hideReel(req.params.id);
  res.json(sanitizeReelPayload(data, req));
};

export const reactivateReel = async (req: Request, res: Response) => {
  const data = await ReelsService.reactivateReel(req.params.id);
  res.json(sanitizeReelPayload(data, req));
};

export const registerView = async (req: Request, res: Response) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Autenticacion requerida.' });
  }
  const data = await ReelsService.registerView(req.params.id, req.auth.authUserId);
  res.json(data);
};
