import { Storage } from '@google-cloud/storage';
import fs from 'fs/promises';

const providerRaw = String(process.env.STORAGE_PROVIDER || '').trim().toLowerCase();

const gcsReelsBucket = String(process.env.GCS_BUCKET || '').trim();
const gcsChatBucket = String(process.env.GCS_CHAT_BUCKET || '').trim() || gcsReelsBucket;
const gcsReportsBucket = String(process.env.GCS_REPORTS_BUCKET || '').trim() || gcsReelsBucket;
const gcsPublicBaseUrl = String(process.env.GCS_PUBLIC_BASE_URL || '')
  .trim()
  .replace(/\/+$/g, '');
const gcsSignedUrlTtlMs = Math.max(
  60_000,
  Number(process.env.GCS_SIGNED_UPLOAD_EXPIRES_MS || 15 * 60 * 1000)
);

const reelsBucket = gcsReelsBucket;
const chatBucket = gcsChatBucket;
const reportsBucket = gcsReportsBucket;

const assertStorageConfigured = () => {
  if (providerRaw && providerRaw !== 'gcs') {
    throw new Error(
      'STORAGE_PROVIDER invalido. El runtime actual solo admite gcs para evitar regresion de stack.'
    );
  }
  if (!gcsReelsBucket) {
    throw new Error('GCS no configurado. Falta GCS_BUCKET.');
  }
};

let gcsClient: Storage | null = null;

const getGcsClient = () => {
  if (!gcsClient) {
    gcsClient = new Storage();
  }
  return gcsClient;
};

const encodeObjectPath = (path: string) =>
  path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

const buildPublicUrl = (bucket: string, storagePath: string) => {
  const encodedPath = encodeObjectPath(storagePath);
  if (gcsPublicBaseUrl && bucket === gcsReelsBucket) {
    return `${gcsPublicBaseUrl}/${encodedPath}`;
  }
  return `https://storage.googleapis.com/${bucket}/${encodedPath}`;
};

const createSignedUploadUrl = async (bucket: string, storagePath: string, contentType: string) => {
  const gcs = getGcsClient();
  const file = gcs.bucket(bucket).file(storagePath);
  const [signedUrl] = await file.getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: Date.now() + gcsSignedUrlTtlMs,
    contentType: contentType || 'application/octet-stream',
  });
  return signedUrl;
};

const ensureStorageObjectExists = async (bucketName: string, storagePath: string) => {
  const normalized = normalizeStoragePath(storagePath);
  const slashIndex = normalized.lastIndexOf('/');
  const fileName = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
  if (!fileName) {
    throw new Error('Ruta de archivo invalida.');
  }

  const gcs = getGcsClient();
  const file = gcs.bucket(bucketName).file(normalized);
  const [exists] = await file.exists();
  if (!exists) {
    throw new Error(`Archivo no encontrado en storage: ${fileName}`);
  }
  const [metadata] = await file.getMetadata();
  const size = Number(metadata?.size || 0);
  if (Number.isFinite(size) && size <= 0) {
    throw new Error(`Archivo vacio en storage: ${fileName}`);
  }
};

const uploadBuffer = async ({
  bucket,
  storagePath,
  buffer,
  contentType,
  cacheControl,
}: {
  bucket: string;
  storagePath: string;
  buffer: Buffer;
  contentType: string;
  cacheControl?: string;
}) => {
  const gcs = getGcsClient();
  const file = gcs.bucket(bucket).file(storagePath);
  await file.save(buffer, {
    resumable: false,
    metadata: {
      contentType,
      ...(cacheControl ? { cacheControl } : {}),
    },
  });
  return buildPublicUrl(bucket, storagePath);
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\-_.]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);

const buildDatePath = (date = new Date()) => {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
};

type UploadItemInput = {
  fileName: string;
  contentType: string;
};

export type SignedUploadResult = {
  path: string;
  signedUrl: string;
  publicUrl: string;
};

type ReelUploadType = 'VIDEO' | 'PHOTO_SET';

export const createSignedUploadUrls = async (
  shopId: string,
  items: UploadItemInput[]
): Promise<{ bucket: string; uploads: SignedUploadResult[] }> => {
  assertStorageConfigured();
  if (!shopId) {
    throw new Error('shopId requerido.');
  }
  if (!items.length) {
    throw new Error('No se recibieron archivos para subir.');
  }

  const timestamp = Date.now();
  const uploads: SignedUploadResult[] = [];

  for (const [index, item] of items.entries()) {
    const safeName = slugify(item.fileName || `reel-${index}`);
    const path = `shops/${shopId}/${timestamp}-${index}-${safeName}`;
    const signedUrl = await createSignedUploadUrl(reelsBucket, path, item.contentType);
    uploads.push({
      path,
      signedUrl,
      publicUrl: buildPublicUrl(reelsBucket, path),
    });
  }

  return { bucket: reelsBucket, uploads };
};

const normalizeStoragePath = (value: string) => value.replace(/^\/+/, '').trim();

const ensureShopPath = (shopId: string, storagePath: string) => {
  const normalized = normalizeStoragePath(storagePath);
  if (!normalized.startsWith(`shops/${shopId}/`)) {
    throw new Error('Ruta de archivo invalida para la tienda.');
  }
  return normalized;
};

export const confirmReelUploadPaths = async ({
  shopId,
  type,
  paths,
}: {
  shopId: string;
  type: ReelUploadType;
  paths: string[];
}) => {
  assertStorageConfigured();
  if (!shopId) {
    throw new Error('shopId requerido.');
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('No se recibieron archivos para confirmar.');
  }

  const cleanedPaths = Array.from(
    new Set(paths.map((item) => String(item || '').trim()).filter(Boolean))
  );
  if (!cleanedPaths.length) {
    throw new Error('No se recibieron rutas validas para confirmar.');
  }

  if (type === 'VIDEO' && cleanedPaths.length !== 1) {
    throw new Error('Solo se permite un video por reel.');
  }
  if (type === 'PHOTO_SET' && cleanedPaths.length > 5) {
    throw new Error('Maximo 5 fotos por reel.');
  }

  const uploads: Array<{ path: string; publicUrl: string }> = [];
  for (const rawPath of cleanedPaths) {
    const safePath = ensureShopPath(shopId, rawPath);
    await ensureStorageObjectExists(reelsBucket, safePath);
    uploads.push({ path: safePath, publicUrl: buildPublicUrl(reelsBucket, safePath) });
  }

  return { bucket: reelsBucket, uploads };
};

const ensureChatPath = (prefix: string, storagePath: string) => {
  const normalized = normalizeStoragePath(storagePath);
  if (!normalized.startsWith(`${prefix}/`)) {
    throw new Error('Ruta de archivo invalida para este chat.');
  }
  return normalized;
};

export const createSignedChatUploadUrls = async ({
  conversationId,
  senderType,
  senderId,
  items,
}: {
  conversationId: string;
  senderType: 'CLIENT' | 'SHOP';
  senderId: string;
  items: UploadItemInput[];
}): Promise<{ bucket: string; uploads: SignedUploadResult[] }> => {
  assertStorageConfigured();
  if (!conversationId) {
    throw new Error('conversationId requerido.');
  }
  if (!senderId) {
    throw new Error('senderId requerido.');
  }
  if (!items.length) {
    throw new Error('No se recibieron archivos para subir.');
  }

  const timestamp = Date.now();
  const safeConversationId = slugify(conversationId) || 'conversation';
  const safeSenderType = senderType === 'SHOP' ? 'shop' : 'client';
  const safeSenderId = slugify(senderId) || 'sender';
  const prefix = `chat/${safeConversationId}/${safeSenderType}/${safeSenderId}`;
  const uploads: SignedUploadResult[] = [];

  for (const [index, item] of items.entries()) {
    const safeName = slugify(item.fileName || `chat-${index}`);
    const path = `${prefix}/${timestamp}-${index}-${safeName}`;
    const signedUrl = await createSignedUploadUrl(chatBucket, path, item.contentType);
    uploads.push({
      path,
      signedUrl,
      publicUrl: buildPublicUrl(chatBucket, path),
    });
  }

  return { bucket: chatBucket, uploads };
};

export const confirmChatUploadPaths = async ({
  conversationId,
  senderType,
  senderId,
  paths,
}: {
  conversationId: string;
  senderType: 'CLIENT' | 'SHOP';
  senderId: string;
  paths: string[];
}) => {
  assertStorageConfigured();
  if (!conversationId) {
    throw new Error('conversationId requerido.');
  }
  if (!senderId) {
    throw new Error('senderId requerido.');
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('No se recibieron archivos para confirmar.');
  }

  const safeConversationId = slugify(conversationId) || 'conversation';
  const safeSenderType = senderType === 'SHOP' ? 'shop' : 'client';
  const safeSenderId = slugify(senderId) || 'sender';
  const prefix = `chat/${safeConversationId}/${safeSenderType}/${safeSenderId}`;

  const cleanedPaths = Array.from(
    new Set(paths.map((item) => String(item || '').trim()).filter(Boolean))
  );
  if (!cleanedPaths.length) {
    throw new Error('No se recibieron rutas validas para confirmar.');
  }
  if (cleanedPaths.length > 4) {
    throw new Error('Maximo 4 adjuntos por mensaje.');
  }

  const uploads: Array<{ path: string; publicUrl: string }> = [];
  for (const rawPath of cleanedPaths) {
    const safePath = ensureChatPath(prefix, rawPath);
    await ensureStorageObjectExists(chatBucket, safePath);
    uploads.push({ path: safePath, publicUrl: buildPublicUrl(chatBucket, safePath) });
  }

  return { bucket: chatBucket, uploads };
};

export const uploadShopImage = async ({
  shopId,
  type,
  file,
}: {
  shopId: string;
  type: 'LOGO' | 'COVER';
  file: Express.Multer.File;
}) => {
  assertStorageConfigured();
  if (!shopId) {
    throw new Error('shopId requerido.');
  }
  if (!file) {
    throw new Error('Archivo requerido.');
  }

  const key = type === 'COVER' ? 'cover' : 'logo';
  const filePath = `shops/${shopId}/${key}`;
  const buffer = await fs.readFile(file.path);
  return uploadBuffer({
    bucket: reelsBucket,
    storagePath: filePath,
    buffer,
    contentType: file.mimetype || 'image/jpeg',
    cacheControl: '3600',
  });
};

export const uploadQaReportHtml = async ({
  file,
  role,
  testerName,
}: {
  file: Express.Multer.File;
  role?: string;
  testerName?: string;
}) => {
  assertStorageConfigured();
  if (!file?.path) {
    throw new Error('Archivo HTML requerido.');
  }

  const roleSlug = slugify(role || 'general') || 'general';
  const testerSlug = slugify(testerName || 'tester') || 'tester';
  const original = slugify(file.originalname || 'reporte') || 'reporte';
  const timestamp = Date.now();
  const datePath = buildDatePath();
  const filePath = `reports/${datePath}/${roleSlug}/${timestamp}-${testerSlug}-${original.replace(/\.html?$/i, '')}.html`;

  const buffer = await fs.readFile(file.path);
  const publicUrl = await uploadBuffer({
    bucket: reportsBucket,
    storagePath: filePath,
    buffer,
    contentType: 'text/html; charset=utf-8',
    cacheControl: '300',
  });
  return {
    bucket: reportsBucket,
    path: filePath,
    publicUrl,
  };
};

export const downloadQaReportHtml = async (path: string) => {
  assertStorageConfigured();
  if (!path) {
    throw new Error('Path requerido.');
  }

  const normalized = String(path).trim();
  const invalidPath =
    normalized.includes('..') ||
    !normalized.startsWith('reports/') ||
    !normalized.toLowerCase().endsWith('.html');
  if (invalidPath) {
    throw new Error('Path de reporte invalido.');
  }
  const gcs = getGcsClient();
  const file = gcs.bucket(reportsBucket).file(normalized);
  const [exists] = await file.exists();
  if (!exists) {
    throw new Error('No se pudo descargar el reporte HTML.');
  }
  const [buffer] = await file.download();
  const html = buffer.toString('utf8');
  return {
    html,
    bucket: reportsBucket,
    path: normalized,
  };
};
