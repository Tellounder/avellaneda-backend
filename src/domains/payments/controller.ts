import { Request, Response } from 'express';
import { PurchaseType } from '@prisma/client';
import * as PaymentsService from './service';

const parsePurchaseType = (value?: string) => {
  if (value === PurchaseType.LIVE_PACK) return PurchaseType.LIVE_PACK;
  if (value === PurchaseType.REEL_PACK) return PurchaseType.REEL_PACK;
  if (value === PurchaseType.PLAN_UPGRADE) return PurchaseType.PLAN_UPGRADE;
  return null;
};

const resolveReturnUrl = (req: Request) => {
  const origin = req.headers.origin;
  if (origin) return origin;
  const referer = req.headers.referer;
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return undefined;
    }
  }
  return undefined;
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
      plan: req.body?.plan,
      payerEmail: req.auth.email,
      returnUrl: resolveReturnUrl(req),
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
      const reason = 'message' in result ? result.message : undefined;
      return res.status(401).json({ message: reason || 'Firma invalida.' });
    }
    return res.json({ received: true });
  } catch (error: any) {
    return res.status(200).json({ received: true, error: error.message || 'Webhook error' });
  }
};

export const confirmMercadoPagoPayment = async (req: Request, res: Response) => {
  try {
    if (!req.auth) {
      return res.status(401).json({ message: 'Autenticacion requerida.' });
    }

    const paymentId = String(req.body?.paymentId || req.query?.paymentId || '').trim();
    const purchaseId = String(req.body?.purchaseId || req.query?.purchaseId || '').trim();
    if (!paymentId && !purchaseId) {
      return res.status(400).json({ message: 'paymentId o purchaseId requerido.' });
    }

    const result = await PaymentsService.confirmMercadoPagoPayment({ paymentId, purchaseId }, req.auth);
    return res.json(result);
  } catch (error: any) {
    return res.status(400).json({ message: error.message || 'Error al confirmar pago.' });
  }
};

