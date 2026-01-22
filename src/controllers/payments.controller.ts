import { Request, Response } from 'express';
import { PurchaseType } from '@prisma/client';
import * as PaymentsService from '../services/payments.service';

const parsePurchaseType = (value?: string) => {
  if (value === PurchaseType.LIVE_PACK) return PurchaseType.LIVE_PACK;
  if (value === PurchaseType.REEL_PACK) return PurchaseType.REEL_PACK;
  return null;
};

export const createMercadoPagoPreference = async (req: Request, res: Response) => {
  try {
    if (!req.auth) {
      return res.status(401).json({ message: 'Autenticacion requerida.' });
    }
    if (req.auth.userType === 'CLIENT') {
      return res.status(403).json({ message: 'Solo tiendas pueden comprar.' });
    }

    const type = parsePurchaseType(req.body?.type);
    if (!type) {
      return res.status(400).json({ message: 'Tipo de compra invalido.' });
    }

    const quantity = Number(req.body?.quantity || 0);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ message: 'Cantidad invalida.' });
    }

    const shopId = req.auth.userType === 'SHOP' ? req.auth.shopId : req.body?.shopId;
    if (!shopId) {
      return res.status(400).json({ message: 'ShopId requerido.' });
    }

    const data = await PaymentsService.createMercadoPagoPreference({
      shopId,
      type,
      quantity,
      payerEmail: req.auth.email,
    });

    return res.json(data);
  } catch (error: any) {
    return res.status(400).json({ message: error.message || 'Error al iniciar el pago.' });
  }
};

export const mercadoPagoWebhook = async (req: Request, res: Response) => {
  try {
    const payload = req.body || {};
    const result = await PaymentsService.handleMercadoPagoWebhook(payload, {
      rawBody: req.rawBody,
      headers: req.headers as Record<string, string | string[] | undefined>,
    });
    if (!result.ok) {
      return res.status(401).json({ message: result.message || 'Firma invalida.' });
    }
    return res.json({ received: true });
  } catch (error: any) {
    return res.status(200).json({ received: true, error: error.message || 'Webhook error' });
  }
};
