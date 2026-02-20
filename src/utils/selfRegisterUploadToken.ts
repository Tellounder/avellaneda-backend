import { createHmac, timingSafeEqual } from 'crypto';

type SelfRegisterUploadPayload = {
  kind: 'SELF_REGISTER_LOGO_UPLOAD';
  shopId: string;
  exp: number;
};

type VerifyResult =
  | { ok: true; payload: SelfRegisterUploadPayload }
  | { ok: false; reason: string };

const TOKEN_TTL_MS = Number(process.env.SELF_REGISTER_UPLOAD_TOKEN_TTL_MS || 20 * 60 * 1000);

const resolveSecret = () =>
  (process.env.SELF_REGISTER_UPLOAD_SECRET || process.env.JWT_SECRET || 'self-register-upload-secret')
    .trim();

const toBase64Url = (value: string) =>
  Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

const fromBase64Url = (value: string) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  const padded = pad ? normalized + '='.repeat(4 - pad) : normalized;
  return Buffer.from(padded, 'base64').toString('utf8');
};

const sign = (rawPayload: string, secret: string) =>
  createHmac('sha256', secret).update(rawPayload).digest('base64url');

export const createSelfRegisterUploadToken = (shopId: string) => {
  const payload: SelfRegisterUploadPayload = {
    kind: 'SELF_REGISTER_LOGO_UPLOAD',
    shopId,
    exp: Date.now() + Math.max(60_000, TOKEN_TTL_MS),
  };
  const rawPayload = toBase64Url(JSON.stringify(payload));
  const signature = sign(rawPayload, resolveSecret());
  return `${rawPayload}.${signature}`;
};

export const verifySelfRegisterUploadToken = (token: string, expectedShopId: string): VerifyResult => {
  const rawToken = String(token || '').trim();
  if (!rawToken) return { ok: false, reason: 'Token requerido.' };

  const [rawPayload, rawSignature] = rawToken.split('.');
  if (!rawPayload || !rawSignature) {
    return { ok: false, reason: 'Token invalido.' };
  }

  const expectedSignature = sign(rawPayload, resolveSecret());
  const provided = Buffer.from(rawSignature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'Firma de token invalida.' };
  }

  try {
    const parsed = JSON.parse(fromBase64Url(rawPayload)) as SelfRegisterUploadPayload;
    if (parsed.kind !== 'SELF_REGISTER_LOGO_UPLOAD') {
      return { ok: false, reason: 'Tipo de token no permitido.' };
    }
    if (!parsed.shopId || parsed.shopId !== expectedShopId) {
      return { ok: false, reason: 'Token no corresponde a la tienda.' };
    }
    if (!Number.isFinite(parsed.exp) || parsed.exp < Date.now()) {
      return { ok: false, reason: 'Token expirado.' };
    }
    return { ok: true, payload: parsed };
  } catch {
    return { ok: false, reason: 'Token invalido.' };
  }
};
