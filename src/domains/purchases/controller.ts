import { Request, Response } from 'express';
import * as PurchasesService from './service';

export const getPurchases = async (req: Request, res: Response) => {
  try {
    const status = req.query.status as any;
    const data = await PurchasesService.getPurchases(status);
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener compras', error });
  }
};

export const getPurchasesByShop = async (req: Request, res: Response) => {
  try {
    const status = req.query.status as any;
    const data = await PurchasesService.getPurchasesByShop(req.params.shopId, status);
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener compras de la tienda', error });
  }
};

export const approvePurchase = async (req: Request, res: Response) => {
  try {
    const data = await PurchasesService.approvePurchase(req.params.id, req.auth?.authUserId || '');
    res.json(data);
  } catch (error: any) {
    res.status(400).json({ message: error.message || 'Error al aprobar compra', error });
  }
};

export const rejectPurchase = async (req: Request, res: Response) => {
  try {
    const data = await PurchasesService.rejectPurchase(req.params.id, req.auth?.authUserId || '', req.body?.notes);
    res.json(data);
  } catch (error: any) {
    res.status(400).json({ message: error.message || 'Error al rechazar compra', error });
  }
};

