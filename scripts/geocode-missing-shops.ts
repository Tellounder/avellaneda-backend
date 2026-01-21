import prisma from '../prisma/client';

type AddressDetails = Record<string, unknown>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const toNumber = (value: unknown) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim();
const isPlaceholder = (value: string) => /seleccione/i.test(value);

const sanitizeAddress = (value: string) =>
  normalizeText(value)
    .replace(/,?\s*seleccione primero una provincia/gi, '')
    .replace(/,?\s*seleccione primero una ciudad/gi, '')
    .replace(/\s+,/g, ',')
    .replace(/,+/g, ',')
    .replace(/,\s*$/g, '')
    .trim();

const normalizeCity = (value: string) => {
  const raw = normalizeText(value);
  if (!raw || isPlaceholder(raw)) return '';
  if (raw.toLowerCase().includes('comuna')) return 'Ciudad de Buenos Aires';
  return raw;
};

const normalizeProvince = (value: string, city: string) => {
  const raw = normalizeText(value);
  if (raw && !isPlaceholder(raw)) return raw;
  if (city === 'Ciudad de Buenos Aires') return 'Ciudad de Buenos Aires';
  return '';
};

const buildQueries = (details: AddressDetails, address?: string | null, name?: string | null) => {
  const street = normalizeText(String(details.street || ''));
  const number = normalizeText(String(details.number || ''));
  const zip = normalizeText(String(details.zip || ''));
  const city = normalizeCity(String(details.city || ''));
  const province = normalizeProvince(String(details.province || ''), city);
  const addr = sanitizeAddress(String(address || ''));

  const hasNumberInStreet = Boolean(number) && street.includes(number);
  const streetPart = street;
  const numberPart = hasNumberInStreet ? '' : number;

  const candidates = new Set<string>();

  if (addr) {
    candidates.add(`${addr}, Argentina`);
  }

  const parts = [
    streetPart,
    numberPart,
    zip,
    city,
    province,
    'Argentina',
  ]
    .map((value) => normalizeText(String(value || '')))
    .filter(Boolean);

  if (parts.length > 0) {
    candidates.add(parts.join(', '));
  }

  if (city || province) {
    candidates.add([city, province, 'Argentina'].filter(Boolean).join(', '));
  }

  if (name) {
    candidates.add(`${normalizeText(String(name))}, ${city || province || 'Argentina'}`);
  }

  return Array.from(candidates).filter(Boolean);
};

const CABA_VIEWBOX = '-58.5313,-34.5266,-58.3470,-34.7058';

const geocode = async (query: string) => {
  if (!query) return null;
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ar&bounded=1&viewbox=${encodeURIComponent(CABA_VIEWBOX)}&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'avellaneda-en-vivo/1.0 (contact: admin@distritomoda.com)',
      'Accept-Language': 'es-AR,es;q=0.9',
    },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as Array<{ lat?: string; lon?: string }>;
  if (!Array.isArray(data) || data.length === 0) return null;
  const lat = toNumber(data[0].lat);
  const lng = toNumber(data[0].lon);
  if (lat === null || lng === null) return null;
  return { lat, lng };
};

const run = async () => {
  const force = process.argv.includes('--force');
  const delayArg = process.argv.find((arg) => arg.startsWith('--delay='));
  const delayMs = delayArg ? Number(delayArg.split('=')[1]) : 1100;

  await prisma.$connect();

  const shops = await prisma.shop.findMany({
    select: {
      id: true,
      name: true,
      address: true,
      addressDetails: true,
    },
  });

  let processed = 0;
  let updated = 0;
  let skipped = 0;

  for (const shop of shops) {
    const details = (shop.addressDetails || {}) as AddressDetails;
    const currentLat = toNumber(details.lat);
    const currentLng = toNumber(details.lng);
    if (!force && currentLat !== null && currentLng !== null) {
      skipped += 1;
      continue;
    }

    const queries = buildQueries(details, shop.address, shop.name);
    if (queries.length === 0) {
      skipped += 1;
      continue;
    }

    let result: { lat: number; lng: number } | null = null;
    for (const query of queries) {
      result = await geocode(query);
      processed += 1;
      if (result) break;
      await sleep(300);
    }
    if (!result) {
      continue;
    }

    const nextDetails = { ...details, lat: result.lat, lng: result.lng };
    await prisma.shop.update({
      where: { id: shop.id },
      data: { addressDetails: nextDetails },
    });
    updated += 1;

    await sleep(delayMs);
  }

  console.log('Processed:', processed);
  console.log('Updated:', updated);
  console.log('Skipped:', skipped);
};

run()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
