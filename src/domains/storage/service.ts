import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const reelsBucket = process.env.SUPABASE_REELS_BUCKET || 'reels';
const reportsBucket = process.env.SUPABASE_REPORTS_BUCKET || reelsBucket;

const assertSupabaseConfigured = () => {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase no configurado. Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.');
  }
};

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

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
  assertSupabaseConfigured();
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
    const { data, error } = await supabase.storage
      .from(reelsBucket)
      .createSignedUploadUrl(path);

    if (error || !data) {
      throw new Error(error?.message || 'No se pudo generar URL de subida.');
    }

    const { data: publicData } = supabase.storage.from(reelsBucket).getPublicUrl(path);
    uploads.push({
      path,
      signedUrl: data.signedUrl,
      publicUrl: publicData.publicUrl,
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

const ensureStorageObjectExists = async (storagePath: string) => {
  const normalized = normalizeStoragePath(storagePath);
  const slashIndex = normalized.lastIndexOf('/');
  const folder = slashIndex >= 0 ? normalized.slice(0, slashIndex) : '';
  const fileName = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
  if (!fileName) {
    throw new Error('Ruta de archivo invalida.');
  }

  const { data, error } = await supabase.storage.from(reelsBucket).list(folder, {
    limit: 100,
    search: fileName,
  });
  if (error) {
    throw new Error(error.message || 'No se pudo validar el archivo subido.');
  }

  const match = (data || []).find((entry: any) => entry?.name === fileName);
  if (!match) {
    throw new Error(`Archivo no encontrado en storage: ${fileName}`);
  }

  const possibleSize = Number(
    (match as any)?.metadata?.size ??
      (match as any)?.metadata?.fileSize ??
      (match as any)?.size ??
      0
  );
  if (Number.isFinite(possibleSize) && possibleSize <= 0) {
    throw new Error(`Archivo vacio en storage: ${fileName}`);
  }
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
  assertSupabaseConfigured();
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
    await ensureStorageObjectExists(safePath);
    const { data } = supabase.storage.from(reelsBucket).getPublicUrl(safePath);
    uploads.push({ path: safePath, publicUrl: data.publicUrl });
  }

  return { bucket: reelsBucket, uploads };
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
  assertSupabaseConfigured();
  if (!shopId) {
    throw new Error('shopId requerido.');
  }
  if (!file) {
    throw new Error('Archivo requerido.');
  }

  const key = type === 'COVER' ? 'cover' : 'logo';
  const filePath = `shops/${shopId}/${key}`;
  const buffer = await fs.readFile(file.path);

  const { error } = await supabase.storage.from(reelsBucket).upload(filePath, buffer, {
    contentType: file.mimetype || 'image/jpeg',
    cacheControl: '3600',
    upsert: true,
  });

  if (error) {
    throw new Error(error.message || 'No se pudo subir la imagen.');
  }

  const { data } = supabase.storage.from(reelsBucket).getPublicUrl(filePath);
  return data.publicUrl;
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
  assertSupabaseConfigured();
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

  const { error } = await supabase.storage.from(reportsBucket).upload(filePath, buffer, {
    contentType: 'text/html; charset=utf-8',
    cacheControl: '300',
    upsert: true,
  });

  if (error) {
    throw new Error(error.message || 'No se pudo subir el reporte HTML.');
  }

  const { data } = supabase.storage.from(reportsBucket).getPublicUrl(filePath);
  return {
    bucket: reportsBucket,
    path: filePath,
    publicUrl: data.publicUrl,
  };
};
