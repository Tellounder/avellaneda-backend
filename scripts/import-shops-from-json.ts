import fs from 'fs';
import path from 'path';
import { ShopStatus, SocialPlatform } from '@prisma/client';
import prisma from '../prisma/client';
import { createQuotaWalletFromLegacy } from '../src/services/quota.service';

type RawShop = Record<string, unknown>;

const DEFAULT_JSON_PATH = '/home/analia/Escritorio/datos_convertidos.json';
const FALLBACK_JSON_PATH = '/home/analia/Escritorio/datos_convertidos .json';

const normalizeEmail = (value: unknown) => String(value || '').trim().toLowerCase();
const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const slugify = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 60);

const parseNumber = (value: unknown) => {
  const normalized = String(value ?? '').replace(/[^\d]/g, '');
  return normalized ? Number(normalized) : 0;
};

const parseActive = (value: unknown) => {
  const raw = String(value || '').trim().toLowerCase();
  return ['si', 'sí', 'yes', 'true', '1', 'activo'].includes(raw);
};

const resolveLogoUrl = (row: RawShop) => {
  const raw =
    row['Logo_URL'] ??
    row['logo_trans_url'] ??
    row['logo_url'] ??
    row['logo'] ??
    '';
  const value = String(raw || '').trim();
  return value || null;
};

const isImageUrl = (value: string) => {
  if (!value) return false;
  if (/\/sites\/default\/files\//i.test(value)) return true;
  return /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(value);
};

const resolveCoverUrl = (row: RawShop) => {
  const candidates = [
    row['imagen_tienda_url'],
    row['imagen_destacada_url'],
    row['Imagen destacada'],
    row['imagen_destacada'],
    row['url_imagen'],
    row['cover_url'],
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value && isImageUrl(value)) return value;
  }
  return null;
};

const resolveWebsiteUrl = (row: RawShop) => {
  const raw = row['url_tienda'] ?? row['url_catalogo'] ?? '';
  const value = String(raw || '').trim();
  if (!value) return null;
  if (isImageUrl(value)) return null;
  return value;
};

const resolveInstagramHandle = (row: RawShop) => {
  const raw = row['Instagram_URL'] ?? row['instagram_url'] ?? '';
  let value = String(raw || '').trim();
  if (!value) return null;

  const lower = value.toLowerCase();
  if (lower.includes('instagram.com')) {
    if (!/^https?:\/\//i.test(value)) {
      value = `https://${value}`;
    }
    try {
      const url = new URL(value);
      value = url.pathname.split('/').filter(Boolean)[0] || '';
    } catch {
      const parts = value.split('instagram.com/');
      value = parts[1] || value;
    }
  }

  value = value.replace(/^@/, '');
  value = value.split(/[?#/]/)[0].trim();
  return value || null;
};

const buildAddress = (row: RawShop) => {
  const rawStreet = String(row['Calle'] || '').trim();
  let street = rawStreet;
  let number = '';
  const match = rawStreet.match(/^(.*)\s+(\d+[a-zA-Z]?)$/);
  if (match) {
    street = match[1].trim();
    number = match[2].trim();
  }
  const postal = String(row['Código postal'] || '').trim();
  const city = String(row['Ciudad'] || '').trim();
  const province = String(row['Provincia'] || '').trim();
  const parts = [rawStreet, postal, city, province].filter(Boolean);
  return {
    address: parts.length > 0 ? parts.join(', ') : null,
    details: {
      street: street || undefined,
      number: number || undefined,
      city: city || undefined,
      province: province || undefined,
      zip: postal || undefined,
      legacyUid: row['Uid'] ?? row['UID'] ?? row['uid'] ?? undefined,
      legacySource: 'distritomoda',
    },
  };
};

const normalizeWhatsapp = (value: unknown) => {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return null;
  const withoutPrefix = digits.startsWith('54') ? digits.slice(2) : digits;
  const trimmed = withoutPrefix.replace(/^0+/, '');
  return trimmed ? `+54${trimmed}` : null;
};

const resolveName = (row: RawShop) => {
  const name = String(row['Nombre completo'] || '').trim();
  if (name) return name;
  const alias = String(row['Usuario'] || '').trim();
  return alias || 'Tienda';
};

const resolveEmail = (row: RawShop) => {
  const raw = row['Mail'] ?? row['Email'] ?? row['Correo'] ?? '';
  return normalizeEmail(raw);
};

const ensureUniqueSlug = (base: string, existing: Set<string>) => {
  if (!existing.has(base)) {
    existing.add(base);
    return base;
  }
  let counter = 1;
  let candidate = `${base}-${counter}`;
  while (existing.has(candidate)) {
    counter += 1;
    candidate = `${base}-${counter}`;
  }
  existing.add(candidate);
  return candidate;
};

const run = async () => {
  const jsonPath =
    process.argv[2] ||
    (fs.existsSync(DEFAULT_JSON_PATH) ? DEFAULT_JSON_PATH : FALLBACK_JSON_PATH);
  const skipExisting = process.argv.includes('--skip-existing');
  const skipWallet = process.argv.includes('--no-wallet');
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`No se encontró el archivo: ${jsonPath}`);
  }

  await prisma.$connect();

  const raw = fs.readFileSync(jsonPath, 'utf8');
  const parsed = JSON.parse(raw);
  const rows: RawShop[] = Array.isArray(parsed) ? parsed : [];

  const existingRecords = await prisma.shop.findMany({
    select: {
      id: true,
      email: true,
      slug: true,
      streamQuota: true,
      reelQuota: true,
      quotaWallet: { select: { shopId: true } },
    },
  });

  const existingByEmail = new Map(
    existingRecords
      .filter((item) => item.email)
      .map((item) => [normalizeEmail(item.email), item])
  );

  const existingSlugs = new Set(existingRecords.map((item) => item.slug));

  let created = 0;
  let updated = 0;
  let skipped = 0;

  console.log(`Iniciando importación (${rows.length} registros)...`);

  for (const row of rows) {
    const email = resolveEmail(row);
    if (!email || !isValidEmail(email)) {
      skipped += 1;
      continue;
    }

    const name = resolveName(row);
    const slugBase = slugify(name || email.split('@')[0] || 'tienda');
    const slug = ensureUniqueSlug(slugBase || `tienda-${Date.now()}`, existingSlugs);
    const whatsappRaw = row['Celular'] || row['Teléfono administrativo'];
    const whatsapp = normalizeWhatsapp(whatsappRaw);
    const { address, details } = buildAddress(row);
    const minimumPurchase = parseNumber(row['Mínimo de Compra']);
    const isActive = parseActive(row['Activo']);
    const status = isActive ? ShopStatus.ACTIVE : ShopStatus.HIDDEN;
    const logoUrl = resolveLogoUrl(row);
    const coverUrl = resolveCoverUrl(row);
    const websiteUrl = resolveWebsiteUrl(row);
    const instagramHandle = resolveInstagramHandle(row);

    const existing = existingByEmail.get(email);

    if (existing) {
      if (!skipExisting) {
        const socialHandlesUpdate = instagramHandle
          ? {
              deleteMany: { platform: SocialPlatform.Instagram },
              create: [{ platform: SocialPlatform.Instagram, handle: instagramHandle }],
            }
          : undefined;
        await prisma.shop.update({
          where: { id: existing.id },
          data: {
            name,
            razonSocial: name,
            email,
            ...(logoUrl ? { logoUrl } : {}),
            ...(coverUrl ? { coverUrl } : {}),
            ...(websiteUrl ? { website: websiteUrl } : {}),
            address: address || undefined,
            addressDetails: details,
            minimumPurchase,
            plan: 'BASIC',
            status,
            active: isActive,
            whatsappLines: whatsapp
              ? { deleteMany: {}, create: [{ label: 'Principal', number: whatsapp }] }
              : { deleteMany: {} },
            ...(socialHandlesUpdate ? { socialHandles: socialHandlesUpdate } : {}),
          },
        });

        if (!skipWallet && !existing.quotaWallet) {
          await createQuotaWalletFromLegacy(
            { id: existing.id, plan: 'BASIC', streamQuota: existing.streamQuota, reelQuota: existing.reelQuota },
            prisma
          );
        }

        updated += 1;
      } else {
        skipped += 1;
      }
      if ((updated + created + skipped) % 25 === 0) {
        console.log(`Procesadas ${updated + created + skipped}...`);
      }
      continue;
    }

    const createdShop = await prisma.shop.create({
      data: {
        name,
        razonSocial: name,
        slug,
        email,
        ...(logoUrl ? { logoUrl } : {}),
        ...(coverUrl ? { coverUrl } : {}),
        ...(websiteUrl ? { website: websiteUrl } : {}),
        address: address || undefined,
        addressDetails: details,
        minimumPurchase,
        paymentMethods: [],
        plan: 'BASIC',
        status,
        statusChangedAt: new Date(),
        active: isActive,
        ...(instagramHandle
          ? { socialHandles: { create: [{ platform: SocialPlatform.Instagram, handle: instagramHandle }] } }
          : {}),
        ...(whatsapp
          ? { whatsappLines: { create: [{ label: 'Principal', number: whatsapp }] } }
          : {}),
      },
    });

    if (!skipWallet) {
      await createQuotaWalletFromLegacy(
        { id: createdShop.id, plan: createdShop.plan, streamQuota: createdShop.streamQuota, reelQuota: createdShop.reelQuota },
        prisma
      );
    }

    created += 1;
    if ((updated + created + skipped) % 25 === 0) {
      console.log(`Procesadas ${updated + created + skipped}...`);
    }
  }

  console.log(`Importación completa: ${created} creadas, ${updated} actualizadas, ${skipped} omitidas.`);
};

run()
  .catch((error) => {
    console.error('Error en la importación:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
