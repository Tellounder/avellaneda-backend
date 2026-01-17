import { Request, Response } from 'express';
import * as ReelsService from '../services/reels.service';

const stripShopPrivateFields = (shop: any) => {
  if (!shop) return shop;
  const { authUserId, requiresEmailFix, ...rest } = shop;
  return rest;
};

const sanitizeReelPayload = (payload: any) => {
  if (!payload) return payload;
  const sanitizeOne = (reel: any) => {
    if (reel?.shop) {
      reel.shop = stripShopPrivateFields(reel.shop);
    }
    return reel;
  };
  if (Array.isArray(payload)) return payload.map(sanitizeOne);
  return sanitizeOne(payload);
};

export const getActiveReels = async (req: Request, res: Response) => {
  const data = await ReelsService.getActiveReels();
  res.json(sanitizeReelPayload(data));
};

export const getAllReelsAdmin = async (req: Request, res: Response) => {
  const data = await ReelsService.getAllReelsAdmin();
  res.json(sanitizeReelPayload(data));
};

export const getReelsByShop = async (req: Request, res: Response) => {
  const data = await ReelsService.getReelsByShop(req.params.shopId);
  res.json(sanitizeReelPayload(data));
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
  const { shopId, url, platform } = req.body;
  const isAdminOverride =
    req.auth.userType === 'ADMIN' ? Boolean(req.body?.isAdminOverride ?? true) : false;
  const data = await ReelsService.createReel(shopId, url, platform, {
    isAdminOverride,
  });
  res.json(sanitizeReelPayload(data));
};

export const hideReel = async (req: Request, res: Response) => {
  const data = await ReelsService.hideReel(req.params.id);
  res.json(sanitizeReelPayload(data));
};

export const reactivateReel = async (req: Request, res: Response) => {
  const data = await ReelsService.reactivateReel(req.params.id);
  res.json(sanitizeReelPayload(data));
};

export const registerView = async (req: Request, res: Response) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Autenticacion requerida.' });
  }
  const data = await ReelsService.registerView(req.params.id, req.auth.authUserId);
  res.json(data);
};
