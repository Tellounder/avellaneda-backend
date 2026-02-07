import crypto from 'crypto';
import { AuthUserType, NotificationType, PurchaseStatus, PurchaseType, QuotaActorType, QuotaRefType } from '@prisma/client';
import prisma from './repo';
import { computeAgendaSuspended, creditLiveExtra, creditReelExtra, syncQuotaWalletToPlan } from '../../services/quota.service';
import { createNotification } from '../notifications/service';
import type { AuthContext } from '../auth/service';
import { isUpgradeAllowed, resolvePlanCode } from '../shops/plan';

type PreferencePayload = {
  shopId: string;
  type: PurchaseType;
  quantity: number;
  plan?: string;
  payerEmail?: string;
  returnUrl?: string;
};

type MercadoPagoPreferenceResponse = {
  id: string;
  init_point?: string;
  sandbox_init_point?: string;
};

const MP_BASE_URL = process.env.MP_BASE_URL || 'https://api.mercadopago.com';
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || process.env.MP_ACCES_TOKEN || '';
const MP_WEBHOOK_URL = process.env.MP_WEBHOOK_URL || '';

const MP_PRICE_LIVE = Number(process.env.MP_PRICE_LIVE || '');
const MP_PRICE_REEL = Number(process.env.MP_PRICE_REEL || '');
const MP_PRICE_PLAN_ALTA = Number(process.env.MP_PRICE_PLAN_ALTA || '');
const MP_PRICE_PLAN_MAXIMA = Number(process.env.MP_PRICE_PLAN_MAXIMA || process.env.MP_PRICE_PLAN_PRO || '');

const isTestAccessToken = () => MP_ACCESS_TOKEN.startsWith('TEST-');

const normalizeBaseUrl = (value?: string) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  const candidate = hasScheme ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.origin.replace(/\/+$/, '');
  } catch {
    return null;
  }
};

const getPreferenceReuseWindowMs = () => {
  const minutes = Number(process.env.MP_PREFERENCE_TTL_MINUTES || 5);
  return Math.max(minutes, 1) * 60 * 1000;
};

const findRecentPreference = async (
  shopId: string,
  type: PurchaseType,
  quantity: number,
  notes?: string | null
) => {
  const since = new Date(Date.now() - getPreferenceReuseWindowMs());
  return prisma.purchaseRequest.findFirst({
    where: {
      shopId,
      type,
      quantity,
      status: PurchaseStatus.PENDING,
      paymentProvider: 'MERCADOPAGO',
      createdAt: { gte: since },
      paymentPreferenceId: { not: null },
      ...(notes ? { notes } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
};

const getUnitPrice = (type: PurchaseType) => {
  if (type === PurchaseType.LIVE_PACK) return MP_PRICE_LIVE;
  if (type === PurchaseType.REEL_PACK) return MP_PRICE_REEL;
  return NaN;
};

const assertPricingConfigured = (type: PurchaseType) => {
  const price = getUnitPrice(type);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('Precio no configurado para esta compra.');
  }
  return price;
};

const getPlanUpgradePrice = (planCode: string) => {
  if (planCode === 'ALTA') return MP_PRICE_PLAN_ALTA;
  if (planCode === 'PRO') return MP_PRICE_PLAN_MAXIMA;
  return NaN;
};

const assertPlanUpgradeConfigured = (planCode: string) => {
  const price = getPlanUpgradePrice(planCode);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('Precio no configurado para este upgrade.');
  }
  return price;
};

const requireAccessToken = () => {
  if (!MP_ACCESS_TOKEN) {
    throw new Error('Mercado Pago no configurado.');
  }
};

const createPurchaseRequest = async (
  shopId: string,
  type: PurchaseType,
  quantity: number,
  meta?: { targetPlan?: string }
) => {
  const numericAmount = Number(quantity);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('Cantidad invalida.');
  }

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { status: true, agendaSuspendedUntil: true, plan: true },
  });

  if (!shop) {
    throw new Error('Tienda no encontrada.');
  }

  if (type === PurchaseType.LIVE_PACK) {
    if (computeAgendaSuspended({ status: shop.status, agendaSuspendedUntil: shop.agendaSuspendedUntil })) {
      throw new Error('Agenda suspendida: no puedes comprar cupos de vivos.');
    }
  }

  const notes = meta?.targetPlan ? `PLAN:${meta.targetPlan}` : undefined;
  if (type === PurchaseType.PLAN_UPGRADE) {
    const targetPlan = resolvePlanCode(meta?.targetPlan);
    if (!targetPlan) {
      throw new Error('Plan objetivo invalido.');
    }
    if (!isUpgradeAllowed(shop.plan, targetPlan)) {
      throw new Error('El plan solicitado no es un upgrade valido.');
    }
    return prisma.purchaseRequest.create({
      data: {
        shopId,
        type,
        quantity: 1,
        status: PurchaseStatus.PENDING,
        paymentProvider: 'MERCADOPAGO',
        paymentStatus: 'PENDING',
        notes: `PLAN:${targetPlan}`,
      },
    });
  }

  return prisma.purchaseRequest.create({
    data: {
      shopId,
      type,
      quantity: numericAmount,
      status: PurchaseStatus.PENDING,
      paymentProvider: 'MERCADOPAGO',
      paymentStatus: 'PENDING',
      ...(notes ? { notes } : {}),
    },
  });
};

export const createMercadoPagoPreference = async ({
  shopId,
  type,
  quantity,
  plan,
  payerEmail,
  returnUrl,
}: PreferencePayload) => {
  requireAccessToken();
  const planCode = type === PurchaseType.PLAN_UPGRADE ? resolvePlanCode(plan) : null;
  if (type === PurchaseType.PLAN_UPGRADE && !planCode) {
    throw new Error('Plan objetivo invalido.');
  }
  const unitPrice =
    type === PurchaseType.PLAN_UPGRADE
      ? assertPlanUpgradeConfigured(planCode || '')
      : assertPricingConfigured(type);

  const requestReturnUrl = normalizeBaseUrl(returnUrl);
  const envReturnUrl = normalizeBaseUrl(
    process.env.MP_RETURN_URL ||
      process.env.FRONTEND_URL ||
      process.env.APP_BASE_URL
  );
  const baseReturnUrl = requestReturnUrl || envReturnUrl;
  if (!baseReturnUrl) {
    throw new Error('Return URL no configurada.');
  }

  const reuseNotes = type === PurchaseType.PLAN_UPGRADE && planCode ? `PLAN:${planCode}` : undefined;
  const reuseQuantity = type === PurchaseType.PLAN_UPGRADE ? 1 : Number(quantity);
  const reused = await findRecentPreference(shopId, type, reuseQuantity, reuseNotes);
  if (reused?.paymentPreferenceId) {
    return {
      purchaseId: reused.purchaseId,
      preferenceId: reused.paymentPreferenceId,
      initPoint: undefined,
      sandboxInitPoint: undefined,
    };
  }

  const purchase = await createPurchaseRequest(
    shopId,
    type,
    type === PurchaseType.PLAN_UPGRADE ? 1 : quantity,
    planCode ? { targetPlan: planCode } : undefined
  );

  const itemTitle =
    type === PurchaseType.LIVE_PACK
      ? 'Cupos de vivos'
      : type === PurchaseType.REEL_PACK
      ? 'Cupos de reels'
      : planCode === 'ALTA'
      ? 'Upgrade a Plan Alta Visibilidad'
      : 'Upgrade a Plan Maxima Visibilidad';

  const backUrls = {
    success: `${baseReturnUrl}/tienda?mp_result=success`,
    pending: `${baseReturnUrl}/tienda?mp_result=pending`,
    failure: `${baseReturnUrl}/tienda?mp_result=failure`,
  };

  const preferencePayload: Record<string, unknown> = {
    items: [
      {
        id: purchase.purchaseId,
        title: itemTitle,
        quantity: type === PurchaseType.PLAN_UPGRADE ? 1 : Number(quantity),
        unit_price: Number(unitPrice),
        currency_id: 'ARS',
      },
    ],
    external_reference: purchase.purchaseId,
    metadata: {
      purchaseId: purchase.purchaseId,
      shopId,
    },
    payer: payerEmail ? { email: payerEmail } : undefined,
    notification_url: MP_WEBHOOK_URL || undefined,
  };
  preferencePayload.back_urls = backUrls;
  preferencePayload.auto_return = 'approved';

  const response = await fetch(`${MP_BASE_URL}/checkout/preferences`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(preferencePayload),
  });

  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    await prisma.purchaseRequest.update({
      where: { purchaseId: purchase.purchaseId },
      data: {
        status: PurchaseStatus.REJECTED,
        paymentStatus: 'ERROR',
        notes: `Mercado Pago error: ${errorPayload?.message || response.status}`,
      },
    });
    throw new Error('Mercado Pago no pudo iniciar el pago.');
  }

  const preference = (await response.json()) as MercadoPagoPreferenceResponse;

  await prisma.purchaseRequest.update({
    where: { purchaseId: purchase.purchaseId },
    data: {
      paymentPreferenceId: preference.id,
      paymentStatus: 'PENDING',
    },
  });

  return {
    purchaseId: purchase.purchaseId,
    preferenceId: preference.id,
    initPoint: preference.init_point,
    sandboxInitPoint: preference.sandbox_init_point,
  };
};

type MercadoPagoWebhookPayload = {
  type?: string;
  topic?: string;
  data?: { id?: string | number };
  id?: string | number;
};

type MercadoPagoPayment = {
  id: number;
  status: string;
  external_reference?: string;
};

type MercadoPagoSearchResponse = {
  results?: Array<{ id?: number | string }>;
};

const signatureMatches = (signature: string, secret: string, payload: string) => {
  const normalized = signature.trim();
  if (!/^[0-9a-f]+$/i.test(normalized)) {
    return false;
  }
  const computed = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (normalized.length !== computed.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(normalized, 'hex'), Buffer.from(computed, 'hex'));
};

const parseSignatureHeader = (header?: string) => {
  if (!header) return { ts: '', v1: '' };
  const tokens = header.split(/[,;]/).map((part) => part.trim());
  const ts = tokens.find((part) => part.startsWith('ts='))?.replace('ts=', '') || '';
  const v1 = tokens.find((part) => part.startsWith('v1='))?.replace('v1=', '') || '';
  return { ts, v1 };
};

const verifyMercadoPagoSignature = (req: { rawBody?: string; headers: Record<string, string | string[] | undefined> }, dataId?: string) => {
  const secret = process.env.MP_WEBHOOK_SECRET || '';
  if (!secret) return true;
  const signatureHeader = Array.isArray(req.headers['x-signature'])
    ? req.headers['x-signature'][0]
    : req.headers['x-signature'];
  const requestIdHeader = Array.isArray(req.headers['x-request-id'])
    ? req.headers['x-request-id'][0]
    : req.headers['x-request-id'];

  if (!signatureHeader) return isTestAccessToken();
  const { ts, v1 } = parseSignatureHeader(signatureHeader);
  const rawBody = req.rawBody || '';

  if (v1 && ts && requestIdHeader && dataId) {
    const payload = `${ts}.${requestIdHeader}.${dataId}`;
    if (signatureMatches(v1, secret, payload)) return true;
  }

  if (rawBody && v1) {
    if (signatureMatches(v1, secret, rawBody)) return true;
  }

  return isTestAccessToken();
};

const fetchPayment = async (paymentId: string) => {
  requireAccessToken();
  const response = await fetch(`${MP_BASE_URL}/v1/payments/${paymentId}`, {
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error('No se pudo obtener el pago.');
  }
  return (await response.json()) as MercadoPagoPayment;
};

const fetchLatestPaymentByPurchaseId = async (purchaseId: string) => {
  requireAccessToken();
  const url =
    `${MP_BASE_URL}/v1/payments/search?` +
    `external_reference=${encodeURIComponent(purchaseId)}` +
    `&sort=date_created&criteria=desc&limit=1`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error('No se pudo buscar el pago.');
  }
  const payload = (await response.json()) as MercadoPagoSearchResponse;
  const latestId = payload?.results?.[0]?.id;
  if (!latestId) {
    throw new Error('No se encontro un pago para esta compra.');
  }
  return fetchPayment(String(latestId));
};

const applyPaymentToPurchase = async (purchaseId: string, payment: MercadoPagoPayment) => {
  const purchase = await prisma.purchaseRequest.findUnique({ where: { purchaseId } });
  if (!purchase) {
    return { ok: true, approved: false, ignored: true };
  }

  if (payment.status === 'approved') {
    await prisma.$transaction(async (tx) => {
      if (purchase.status === PurchaseStatus.APPROVED) {
        await tx.purchaseRequest.update({
          where: { purchaseId },
          data: {
            paymentRef: String(payment.id),
            paymentStatus: payment.status,
          },
        });
        return;
      }

      if (purchase.type === PurchaseType.LIVE_PACK) {
        await creditLiveExtra(purchase.shopId, purchase.quantity, tx, {
          refType: QuotaRefType.PURCHASE,
          refId: purchase.purchaseId,
          actorType: QuotaActorType.SYSTEM,
          actorId: null,
        });
      } else if (purchase.type === PurchaseType.REEL_PACK) {
        await creditReelExtra(purchase.shopId, purchase.quantity, tx, {
          refType: QuotaRefType.PURCHASE,
          refId: purchase.purchaseId,
          actorType: QuotaActorType.SYSTEM,
          actorId: null,
        });
      } else if (purchase.type === PurchaseType.PLAN_UPGRADE) {
        const targetPlan = purchase.notes?.startsWith('PLAN:')
          ? resolvePlanCode(purchase.notes.split(':').slice(1).join(':').trim())
          : resolvePlanCode(purchase.notes);
        if (!targetPlan) {
          throw new Error('Plan objetivo no especificado.');
        }
        const shop = await tx.shop.findUnique({ where: { id: purchase.shopId }, select: { plan: true } });
        if (!shop || !isUpgradeAllowed(shop.plan, targetPlan)) {
          throw new Error('Plan upgrade invalido.');
        }
        await tx.shop.update({ where: { id: purchase.shopId }, data: { plan: targetPlan } });
        await syncQuotaWalletToPlan(purchase.shopId, targetPlan, tx);
      }

      await tx.purchaseRequest.update({
        where: { purchaseId },
        data: {
          status: PurchaseStatus.APPROVED,
          approvedAt: new Date(),
          approvedByAdminId: null,
          paymentRef: String(payment.id),
          paymentStatus: payment.status,
        },
      });
    });

    const shop = await prisma.shop.findUnique({
      where: { id: purchase.shopId },
      select: { authUserId: true },
    });
    if (shop?.authUserId) {
      const message =
        purchase.type === PurchaseType.PLAN_UPGRADE
          ? 'Pago aprobado: tu plan fue actualizado.'
          : `Pago aprobado: ${purchase.quantity} cupos acreditados.`;
      await createNotification(shop.authUserId, message, {
        type: NotificationType.PURCHASE,
        refId: purchase.purchaseId,
      });
    }

    return { ok: true, approved: true };
  }

  await prisma.purchaseRequest.update({
    where: { purchaseId },
    data: {
      paymentRef: String(payment.id),
      paymentStatus: payment.status,
    },
  });

  return { ok: true, approved: false };
};

export const handleMercadoPagoWebhook = async (
  payload: MercadoPagoWebhookPayload,
  reqMeta: { rawBody?: string; headers: Record<string, string | string[] | undefined> }
) => {
  const eventType = payload.type || payload.topic || '';
  const dataId = payload.data?.id || payload.id;
  if (!dataId) {
    return { ok: true, ignored: true };
  }

  if (!verifyMercadoPagoSignature(reqMeta, String(dataId)) && !isTestAccessToken()) {
    return { ok: false, message: 'Firma invalida.' };
  }

  if (eventType !== 'payment') {
    return { ok: true, ignored: true };
  }

  const payment = await fetchPayment(String(dataId));
  const purchaseId = payment.external_reference;
  if (!purchaseId) {
    return { ok: true, ignored: true };
  }
  return applyPaymentToPurchase(purchaseId, payment);
};

export const confirmMercadoPagoPayment = async (
  params: { paymentId?: string; purchaseId?: string },
  auth?: AuthContext
) => {
  const payment = params.paymentId
    ? await fetchPayment(params.paymentId)
    : params.purchaseId
      ? await fetchLatestPaymentByPurchaseId(params.purchaseId)
      : (() => {
          throw new Error('paymentId o purchaseId requerido.');
        })();

  const purchaseId = payment.external_reference || params.purchaseId;
  if (!purchaseId) {
    throw new Error('Pago sin referencia de compra.');
  }

  if (auth?.userType === AuthUserType.SHOP && auth.shopId) {
    const purchase = await prisma.purchaseRequest.findUnique({ where: { purchaseId } });
    if (!purchase || purchase.shopId !== auth.shopId) {
      throw new Error('Compra no encontrada para esta tienda.');
    }
  }

  return applyPaymentToPurchase(purchaseId, payment);
};


