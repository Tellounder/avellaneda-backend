import { Request, Response } from 'express';
import { ReelStatus, ReelType } from '@prisma/client';
import { getReelShareData, getStreamShareData } from './service';

const BRAND_NAME = 'Avvivo - by Distrito Moda';
const BRAND_SITE_NAME = 'Avvivo - by Distrito Moda';
const DEFAULT_SHARE_LOGO_PATH = '/img/avvivo-logo.png';

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildOgDescription = (shopName: string, presetLabel?: string | null) => {
  const presetLine = presetLabel ? ` Estilo: ${presetLabel}.` : '';
  return `${shopName} en ${BRAND_NAME}.${presetLine} Miralo en Avellaneda en Vivo.`;
};

const buildStreamOgDescription = (shopName: string, title?: string | null) => {
  const titleLine = title ? ` ${title}.` : '';
  return `Vivo de ${shopName} en ${BRAND_NAME}.${titleLine} Sumate ahora.`;
};

const normalizeOgUrl = (value?: string | null, baseUrl?: string | null) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/') && baseUrl) return `${baseUrl}${trimmed}`;
  return trimmed;
};

const guessImageType = (value?: string | null) => {
  const lower = (value || '').toLowerCase();
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
};

const looksLikeSvgByUrl = (value?: string | null) => {
  if (!value) return false;
  return /\.svg(?:[?#].*)?$/i.test(value);
};

const looksLikeRasterByUrl = (value?: string | null) => {
  if (!value) return false;
  return /\.(png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(value);
};

const hasLogoPathHint = (value?: string | null) => {
  if (!value) return false;
  return /\/logo(?:[/?#]|$)/i.test(value);
};

const fetchContentType = async (url: string): Promise<string | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type');
    return contentType ? contentType.toLowerCase() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

const resolveShareImageUrl = async (
  candidates: Array<string | null | undefined>,
  fallback: string | null
): Promise<string | null> => {
  for (const rawCandidate of candidates) {
    if (!rawCandidate) continue;
    const candidate = rawCandidate.trim();
    if (!candidate) continue;

    if (looksLikeSvgByUrl(candidate)) {
      continue;
    }

    if (looksLikeRasterByUrl(candidate)) {
      return candidate;
    }

    if (hasLogoPathHint(candidate)) {
      const contentType = await fetchContentType(candidate);
      if (contentType?.includes('image/svg+xml')) {
        continue;
      }
      if (contentType?.startsWith('image/')) {
        return candidate;
      }
      continue;
    }

    return candidate;
  }

  return fallback;
};

const buildShareHtml = (params: {
  title: string;
  description: string;
  shareUrl: string;
  appUrl: string;
  imageUrl?: string | null;
  videoUrl?: string | null;
  isExpired?: boolean;
}) => {
  const title = escapeHtml(params.title);
  const description = escapeHtml(params.description);
  const shareUrl = escapeHtml(params.shareUrl);
  const appUrl = escapeHtml(params.appUrl);
  const autoRedirect = !params.isExpired;

  const imageMeta = params.imageUrl
    ? [
        `<meta property="og:image" content="${escapeHtml(params.imageUrl)}" />`,
        `<meta property="og:image:secure_url" content="${escapeHtml(params.imageUrl)}" />`,
        `<meta property="og:image:type" content="${guessImageType(params.imageUrl)}" />`,
        `<meta property="og:image:alt" content="${title}" />`,
        `<meta name="twitter:image" content="${escapeHtml(params.imageUrl)}" />`,
      ].join('\n')
    : '';

  const videoMeta = params.videoUrl
    ? [
        `<meta property="og:video" content="${escapeHtml(params.videoUrl)}" />`,
        `<meta property="og:video:secure_url" content="${escapeHtml(params.videoUrl)}" />`,
        `<meta property="og:video:type" content="video/mp4" />`,
        `<meta property="og:video:width" content="720" />`,
        `<meta property="og:video:height" content="1280" />`,
      ].join('\n')
    : '';

  const refreshMeta = autoRedirect
    ? `<meta http-equiv="refresh" content="0;url=${appUrl}" />`
    : '';

  const ctaTitle = params.isExpired ? 'Contenido no disponible' : 'Abriendo Avvivo';
  const ctaMessage = params.isExpired
    ? 'Este contenido ya no esta disponible. Podes seguir viendo tiendas, reels y vivos en Avvivo.'
    : 'Si no redirige automaticamente, toca el boton para abrir Avvivo.';
  const ctaButton = params.isExpired ? 'Ir a Avvivo' : 'Abrir Avvivo';

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <link rel="canonical" href="${shareUrl}" />
    <meta property="og:type" content="${params.videoUrl ? 'video.other' : 'website'}" />
    <meta property="og:site_name" content="${escapeHtml(BRAND_SITE_NAME)}" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${shareUrl}" />
    ${imageMeta}
    ${videoMeta}
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    <meta name="twitter:url" content="${shareUrl}" />
    ${refreshMeta}
    <title>${title}</title>
    <style>
      :root {
        color-scheme: light;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: radial-gradient(circle at top, #ffebf4 0%, #f4f5f8 55%, #eceef3 100%);
        font-family: Manrope, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #111827;
      }
      .card {
        width: min(92vw, 520px);
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 20px;
        box-shadow: 0 18px 50px rgba(17, 24, 39, 0.12);
        padding: 28px;
      }
      h1 {
        margin: 0 0 8px 0;
        font-size: 28px;
        line-height: 1.15;
      }
      p {
        margin: 0;
        color: #4b5563;
      }
      .row {
        margin-top: 22px;
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .button {
        display: inline-block;
        text-decoration: none;
        border-radius: 999px;
        background: #ff006f;
        color: #ffffff;
        font-weight: 700;
        letter-spacing: 0.02em;
        padding: 12px 18px;
      }
      .meta {
        margin-top: 10px;
        font-size: 12px;
        color: #6b7280;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>${escapeHtml(ctaTitle)}</h1>
      <p>${escapeHtml(ctaMessage)}</p>
      <div class="row">
        <a class="button" href="${appUrl}">${escapeHtml(ctaButton)}</a>
      </div>
      <p class="meta">${escapeHtml(BRAND_NAME)}</p>
    </main>
    <script>
      if (${autoRedirect ? 'true' : 'false'}) {
        window.location.replace("${appUrl}");
      }
    </script>
  </body>
</html>`;
};

export const getReelSharePage = async (req: Request, res: Response) => {
  const { id } = req.params;
  const reel = await getReelShareData(id);
  if (!reel) {
    res.status(404).send('Reel no encontrado');
    return;
  }

  const now = new Date();
  const isExpired =
    reel.hidden ||
    reel.status !== ReelStatus.ACTIVE ||
    reel.expiresAt.getTime() < now.getTime();

  const requestBaseUrl = `${req.protocol}://${req.get('host')}`;
  const shareBaseUrl = process.env.PUBLIC_SHARE_URL || requestBaseUrl;
  const shareUrl = `${shareBaseUrl}/share/reels/${reel.id}`;
  const appBaseUrl =
    process.env.APP_URL ||
    process.env.FRONTEND_URL ||
    process.env.PUBLIC_APP_URL ||
    requestBaseUrl;
  const appUrl = `${appBaseUrl}/?reelId=${reel.id}`;

  const shopName = reel.shop?.name || 'Tienda';
  const title = `${shopName} | ${BRAND_NAME}`;
  const description = buildOgDescription(shopName, reel.presetLabel);
  const photoUrl = Array.isArray(reel.photoUrls) ? reel.photoUrls[0] : null;
  const baseForAssets = appBaseUrl || requestBaseUrl;
  const defaultLogoUrl = normalizeOgUrl(DEFAULT_SHARE_LOGO_PATH, baseForAssets);
  const imageUrl = await resolveShareImageUrl(
    [
      normalizeOgUrl(reel.thumbnailUrl || null, baseForAssets),
      normalizeOgUrl(photoUrl || null, baseForAssets),
      normalizeOgUrl(reel.shop?.logoUrl || null, baseForAssets),
    ],
    defaultLogoUrl
  );
  const videoUrl =
    reel.type === ReelType.VIDEO && reel.videoUrl && !isExpired
      ? normalizeOgUrl(reel.videoUrl, baseForAssets)
      : null;

  const html = buildShareHtml({
    title,
    description,
    shareUrl,
    appUrl,
    imageUrl,
    videoUrl,
    isExpired,
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
};

export const getStreamSharePage = async (req: Request, res: Response) => {
  const { id } = req.params;
  const stream = await getStreamShareData(id);
  if (!stream) {
    res.status(404).send('Vivo no encontrado');
    return;
  }

  const requestBaseUrl = `${req.protocol}://${req.get('host')}`;
  const shareBaseUrl = process.env.PUBLIC_SHARE_URL || requestBaseUrl;
  const shareUrl = `${shareBaseUrl}/share/streams/${stream.id}`;
  const appBaseUrl =
    process.env.APP_URL ||
    process.env.FRONTEND_URL ||
    process.env.PUBLIC_APP_URL ||
    requestBaseUrl;
  const appUrl = `${appBaseUrl}/en-vivo/${stream.id}`;

  const shopName = stream.shop?.name || 'Tienda';
  const title = stream.title ? `${stream.title} | ${BRAND_NAME}` : `${shopName} en vivo | ${BRAND_NAME}`;
  const description = buildStreamOgDescription(shopName, stream.title);
  const baseForAssets = appBaseUrl || requestBaseUrl;
  const defaultLogoUrl = normalizeOgUrl(DEFAULT_SHARE_LOGO_PATH, baseForAssets);
  const imageUrl = await resolveShareImageUrl(
    [
      normalizeOgUrl(stream.shop?.coverUrl || null, baseForAssets),
      normalizeOgUrl(stream.shop?.logoUrl || null, baseForAssets),
    ],
    defaultLogoUrl
  );

  const html = buildShareHtml({
    title,
    description,
    shareUrl,
    appUrl,
    imageUrl,
    isExpired: false,
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
};
