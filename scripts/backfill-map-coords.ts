import fs from 'fs';
import prisma from '../prisma/client';

type RawShop = Record<string, unknown>;

const getArgPath = () => {
  const raw = process.argv[2];
  return raw ? raw.trim() : '';
};

const normalizeText = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

const slugify = (value: string) =>
  normalizeText(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');

const getValue = (row: RawShop, keys: string[]) => {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      const value = row[key];
      if (value !== null && value !== undefined && String(value).trim() !== '') {
        return value;
      }
    }
  }
  return null;
};

const getString = (row: RawShop, keys: string[]) => {
  const value = getValue(row, keys);
  return value === null ? '' : String(value).trim();
};

const parseNumber = (value: unknown) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const maybeSet = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  force: boolean
) => {
  if (value === null || value === undefined || value === '') return false;
  if (!force && target[key] !== undefined && target[key] !== null && target[key] !== '') {
    return false;
  }
  target[key] = value;
  return true;
};

const run = async () => {
  const jsonPath = getArgPath();
  if (!jsonPath) {
    throw new Error('Usa: npm run backfill:mapcoords -- <ruta_json>');
  }
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`No se encontro el JSON: ${jsonPath}`);
  }
  const force = process.argv.includes('--force');

  await prisma.$connect();
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const parsed = JSON.parse(raw);
  const rows: RawShop[] = Array.isArray(parsed) ? parsed : [];

  const shops = await prisma.shop.findMany({
    select: {
      id: true,
      name: true,
      slug: true,
      email: true,
      logoUrl: true,
      coverUrl: true,
      website: true,
      minimumPurchase: true,
      address: true,
      addressDetails: true,
    },
  });

  const byEmail = new Map<string, typeof shops[number]>();
  const bySlug = new Map<string, typeof shops[number]>();
  const byName = new Map<string, typeof shops[number]>();
  const byLegacyUid = new Map<string, typeof shops[number]>();

  shops.forEach((shop) => {
    if (shop.email) byEmail.set(shop.email.toLowerCase(), shop);
    if (shop.slug) bySlug.set(shop.slug.toLowerCase(), shop);
    if (shop.name) byName.set(normalizeText(shop.name), shop);
    const details = (shop.addressDetails || {}) as Record<string, unknown>;
    const legacyUid = details.legacyUid ? String(details.legacyUid) : '';
    if (legacyUid) byLegacyUid.set(legacyUid, shop);
  });

  let matched = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const email = getString(row, ['Mail', 'mail', 'Email', 'email']).toLowerCase();
    const uid = getString(row, ['Uid', 'UID', 'uid']);
    const usuario = getString(row, ['Usuario', 'usuario']);
    const nombre = getString(row, ['Nombre completo', 'Nombre Completo', 'Nombre']);

    let shop =
      (email && byEmail.get(email)) ||
      (uid && byLegacyUid.get(uid)) ||
      (usuario && bySlug.get(slugify(usuario))) ||
      (nombre && byName.get(normalizeText(nombre))) ||
      null;

    if (!shop) {
      skipped += 1;
      continue;
    }

    matched += 1;

    const details = { ...((shop.addressDetails as Record<string, unknown>) || {}) };
    const changes: Record<string, unknown> = {};

    const lat = parseNumber(getValue(row, ['lat', 'Lat', 'LAT']));
    const lng = parseNumber(getValue(row, ['lng', 'Lng', 'LNG']));
    const street = getString(row, ['Calle', 'calle']);
    const zip = getString(row, ['Código postal', 'Codigo postal', 'CÓDIGO POSTAL']);
    const city = getString(row, ['Ciudad', 'ciudad']);
    const province = getString(row, ['Provincia', 'provincia']);
    const catalogUrl = getString(row, ['url_catalogo', 'URL_CATALOGO', 'url_catalogo']);
    const imageUrl = getString(row, ['url_imagen', 'URL_IMAGEN', 'url_imagen']);
    const storeImageUrl = getString(row, ['imagen_tienda_url', 'IMAGEN_TIENDA_URL']);
    const coverUrl = getString(row, ['imagen_destacada_url', 'imagen_destacada_url']);
    const logoUrl = getString(row, ['Logo_URL', 'logo_url', 'logourl']);
    const website = getString(row, ['url_tienda', 'URL_TIENDA', 'url_tienda']);
    const minPurchase = parseNumber(getValue(row, ['Mínimo de Compra', 'Minimo de Compra', 'MINIMO DE COMPRA']));
    const userType = getString(row, ['Tipo de Usuario', 'tipo de usuario']);

    let detailsChanged = false;
    detailsChanged = maybeSet(details, 'lat', lat, force) || detailsChanged;
    detailsChanged = maybeSet(details, 'lng', lng, force) || detailsChanged;
    detailsChanged = maybeSet(details, 'street', street, force) || detailsChanged;
    detailsChanged = maybeSet(details, 'zip', zip, force) || detailsChanged;
    detailsChanged = maybeSet(details, 'city', city, force) || detailsChanged;
    detailsChanged = maybeSet(details, 'province', province, force) || detailsChanged;
    detailsChanged = maybeSet(details, 'catalogUrl', catalogUrl, force) || detailsChanged;
    detailsChanged = maybeSet(details, 'imageUrl', imageUrl, force) || detailsChanged;
    detailsChanged = maybeSet(details, 'storeImageUrl', storeImageUrl, force) || detailsChanged;
    detailsChanged = maybeSet(details, 'legacyUid', uid, force) || detailsChanged;
    detailsChanged = maybeSet(details, 'legacyUser', usuario, force) || detailsChanged;
    detailsChanged = maybeSet(details, 'legacyUserType', userType, force) || detailsChanged;

    if (detailsChanged) {
      changes.addressDetails = details;
    }

    if (logoUrl && (force || !shop.logoUrl)) {
      changes.logoUrl = logoUrl;
    }
    if (coverUrl && (force || !shop.coverUrl)) {
      changes.coverUrl = coverUrl;
    }
    if (website && (force || !shop.website)) {
      changes.website = website;
    }
    if (minPurchase !== null && (force || !shop.minimumPurchase || shop.minimumPurchase === 0)) {
      changes.minimumPurchase = minPurchase;
    }

    if (!shop.address) {
      const parts = [street, city].filter(Boolean);
      if (parts.length > 0) {
        changes.address = parts.join(', ');
      }
    }

    if (Object.keys(changes).length === 0) {
      continue;
    }

    await prisma.shop.update({
      where: { id: shop.id },
      data: changes,
    });

    updated += 1;
  }

  console.log('Rows:', rows.length);
  console.log('Matched:', matched);
  console.log('Updated:', updated);
  console.log('Skipped:', skipped);
  console.log('Force mode:', force);
};

run()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
