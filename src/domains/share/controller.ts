import { Request, Response } from 'express';
import { ReelStatus, ReelType } from '@prisma/client';
import { getReelShareData } from './service';

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildOgDescription = (shopName: string, presetLabel?: string | null) => {
  const presetLine = presetLabel ? ` ${presetLabel}.` : '';
  return `${shopName} en Avellaneda en Vivo.${presetLine} Miralo antes de que expire. Nota: este reel estara activo por 24 hs.`;
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
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
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
  const imageMeta = params.imageUrl
    ? [
        `<meta property="og:image" content="${escapeHtml(params.imageUrl)}" />`,
        `<meta property="og:image:secure_url" content="${escapeHtml(params.imageUrl)}" />`,
        `<meta property="og:image:type" content="${guessImageType(params.imageUrl)}" />`,
        `<meta property="og:image:width" content="1080" />`,
        `<meta property="og:image:height" content="1920" />`,
        `<meta property="og:image:alt" content="${title}" />`,
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
  const redirectUrl = params.isExpired ? shareUrl : appUrl;
  const refreshSeconds = params.isExpired ? 0 : 0;

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <meta property="og:type" content="${params.videoUrl ? 'video.other' : 'website'}" />
    <meta property="og:site_name" content="Avellaneda en Vivo" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${shareUrl}" />
    ${imageMeta}
    ${videoMeta}
    <meta name="twitter:card" content="${params.videoUrl ? 'player' : 'summary_large_image'}" />
    <meta http-equiv="refresh" content="${refreshSeconds};url=${redirectUrl}" />
    <title>${title}</title>
  </head>
  <body>
    <script>
      if (${params.isExpired ? 'false' : 'true'}) {
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
  const shareUrl = `${requestBaseUrl}/share/reels/${reel.id}`;
  const appBaseUrl =
    process.env.APP_URL ||
    process.env.FRONTEND_URL ||
    process.env.PUBLIC_APP_URL ||
    requestBaseUrl;
  const appUrl = `${appBaseUrl}/?reelId=${reel.id}`;

  const shopName = reel.shop?.name || 'Tienda';
  const title = `${shopName} en Avellaneda en Vivo`;
  const description = buildOgDescription(shopName, reel.presetLabel);
  const photoUrl = Array.isArray(reel.photoUrls) ? reel.photoUrls[0] : null;
  const baseForAssets = appBaseUrl || requestBaseUrl;
  const imageUrl = normalizeOgUrl(
    reel.thumbnailUrl || photoUrl || reel.shop?.logoUrl || null,
    baseForAssets
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
