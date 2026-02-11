import { Request, Response } from 'express';
import { ReelStatus } from '@prisma/client';
import * as ReelsService from './service';
import { getOrSetCache } from '../../utils/publicCache';

const REELS_CACHE_MS = 15_000;

const sanitizeAddressDetails = (details: any) => {
  if (!details || typeof details !== 'object') return details;
  const {
    lat,
    lng,
    mapsUrl,
    catalogUrl,
  } = details;
  return {
    ...(lat !== undefined ? { lat } : {}),
    ...(lng !== undefined ? { lng } : {}),
    ...(mapsUrl ? { mapsUrl } : {}),
    ...(catalogUrl ? { catalogUrl } : {}),
  };
};

const sanitizeShopForReel = (shop: any) => {
  if (!shop) return shop;
  const {
    id,
    name,
    slug,
    logoUrl,
    coverUrl,
    website,
    addressDetails,
  } = shop;
  return {
    id,
    name,
    slug,
    logoUrl,
    coverUrl,
    website,
    addressDetails: sanitizeAddressDetails(addressDetails),
  };
};

const sanitizeReelPayload = (
  payload: any,
  options?: { stripEditorState?: boolean; stripProcessingFields?: boolean }
) => {
  if (!payload) return payload;
  const sanitizeOne = (reel: any) => {
    if (!reel) return reel;
    const next = { ...reel };
    if (reel.shop) {
      next.shop = sanitizeShopForReel(reel.shop);
    }
    if (options?.stripEditorState) {
      delete next.editorState;
    }
    if (options?.stripProcessingFields) {
      delete next.processingJobId;
    }
    return next;
  };
  if (Array.isArray(payload)) return payload.map(sanitizeOne);
  return sanitizeOne(payload);
};

const resolveReelAccess = async (req: Request, res: Response) => {
  if (!req.auth) {
    res.status(401).json({ message: 'Autenticacion requerida.' });
    return null;
  }
  const reel = await ReelsService.getReelById(req.params.id);
  if (!reel) {
    res.status(404).json({ message: 'Reel no encontrado.' });
    return null;
  }
  if (req.auth.userType === 'ADMIN') {
    return reel;
  }
  if (req.auth.userType === 'SHOP' && req.auth.shopId === reel.shopId) {
    return reel;
  }
  res.status(403).json({ message: 'Acceso denegado.' });
  return null;
};

export const getActiveReels = async (req: Request, res: Response) => {
  const limit = Math.min(
    120,
    Math.max(10, Number.parseInt(String(req.query.limit || '80'), 10) || 80)
  );
  const cacheKey = `reels:active:${limit}`;
  const data = await getOrSetCache(cacheKey, REELS_CACHE_MS, () =>
    ReelsService.getActiveReels(limit)
  );
  res.json(
    sanitizeReelPayload(data, {
      stripEditorState: true,
      stripProcessingFields: true,
    })
  );
};

export const getAllReelsAdmin = async (req: Request, res: Response) => {
  const data = await ReelsService.getAllReelsAdmin();
  res.json(sanitizeReelPayload(data));
};

export const getReelsByShop = async (req: Request, res: Response) => {
  const limit = Math.min(
    200,
    Math.max(10, Number.parseInt(String(req.query.limit || '120'), 10) || 120)
  );
  const data = await ReelsService.getReelsByShop(req.params.shopId, limit);
  res.json(
    sanitizeReelPayload(data, {
      stripEditorState: true,
      stripProcessingFields: true,
    })
  );
};

export const getReelById = async (req: Request, res: Response) => {
  const reel = await resolveReelAccess(req, res);
  if (!reel) return;
  res.json(sanitizeReelPayload(reel));
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
  const { shopId, type, videoUrl, photoUrls, thumbnailUrl, durationSeconds, platform, presetLabel, editorState } = req.body;
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
      presetLabel,
      editorState,
      durationSeconds,
      status: ReelStatus.PROCESSING,
      processingJobId: null,
    },
    { isAdminOverride }
  );
  res.json(sanitizeReelPayload(data));
};

export const hideReel = async (req: Request, res: Response) => {
  const reel = await resolveReelAccess(req, res);
  if (!reel) return;
  const data = await ReelsService.hideReel(reel.id);
  res.json(sanitizeReelPayload(data));
};

export const reactivateReel = async (req: Request, res: Response) => {
  const data = await ReelsService.reactivateReel(req.params.id);
  res.json(sanitizeReelPayload(data));
};

export const deleteReel = async (req: Request, res: Response) => {
  const reel = await resolveReelAccess(req, res);
  if (!reel) return;
  const data = await ReelsService.deleteReel(reel.id);
  res.json(sanitizeReelPayload(data));
};

export const registerView = async (req: Request, res: Response) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Autenticacion requerida.' });
  }
  const data = await ReelsService.registerView(req.params.id, req.auth.authUserId);
  res.json(data);
};



