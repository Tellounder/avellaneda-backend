import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const reelsBucket = process.env.SUPABASE_REELS_BUCKET || 'reels';

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

type UploadItemInput = {
  fileName: string;
  contentType: string;
};

export type SignedUploadResult = {
  path: string;
  signedUrl: string;
  publicUrl: string;
};

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
