import fs from 'fs';
import path from 'path';
import prisma from '../prisma/client';

type RawShop = Record<string, unknown>;
type CsvRow = { name: string; url: string };

const DEFAULT_JSON_PATH = '/home/analia/Escritorio/datos_convertidos.json';
const DEFAULT_CSV_PATH = '/home/analia/Escritorio/logos_tiendas.csv';

const normalizeName = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const normalizeEmail = (value: unknown) => String(value || '').trim().toLowerCase();
const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const parseCsvLine = (line: string) => {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  result.push(current.trim());
  return result.map((value) => value.replace(/^"|"$/g, '').trim());
};

const readCsv = (csvPath: string): CsvRow[] => {
  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= 1) return [];

  const headerCells = parseCsvLine(lines[0]).map((cell) => cell.toLowerCase().trim());
  const nameIndex = headerCells.findIndex((cell) =>
    ['tienda', 'shop', 'nombre', 'nombre completo'].includes(cell)
  );
  const urlIndex = headerCells.findIndex((cell) => cell.includes('logo'));

  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    const name = nameIndex >= 0 ? cells[nameIndex] : cells.find((cell) => /[a-zA-Z]/.test(cell)) || '';
    const url = urlIndex >= 0 ? cells[urlIndex] : cells.find((cell) => /^https?:\/\//.test(cell)) || '';
    if (!name) continue;
    rows.push({ name, url: url || '' });
  }
  return rows;
};

const resolveEmail = (row: RawShop) => {
  const raw = row['Mail'] ?? row['Email'] ?? row['Correo'] ?? '';
  return normalizeEmail(raw);
};

const resolveNames = (row: RawShop) => {
  const candidates = [row['Nombre completo'], row['Usuario']]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return Array.from(new Set(candidates));
};

const buildLogoIndex = (rows: CsvRow[]) => {
  const map = new Map<string, Set<string>>();
  rows.forEach((row) => {
    if (!row.url) return;
    const key = normalizeName(row.name);
    if (!key) return;
    const urls = map.get(key) || new Set<string>();
    urls.add(row.url);
    map.set(key, urls);
  });
  return map;
};

const run = async () => {
  const jsonPath = process.argv[2] || DEFAULT_JSON_PATH;
  const csvPath = process.argv[3] || DEFAULT_CSV_PATH;
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`No se encontró el JSON: ${jsonPath}`);
  }
  if (!fs.existsSync(csvPath)) {
    throw new Error(`No se encontró el CSV: ${csvPath}`);
  }

  await prisma.$connect();

  const jsonRows: RawShop[] = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const csvRows = readCsv(csvPath);
  const logoIndex = buildLogoIndex(csvRows);

  const reportRows: string[] = [
    [
      'row',
      'status',
      'email',
      'shop_name',
      'logo_name',
      'url',
      'note',
    ].join(','),
  ];

  let updated = 0;
  let unchanged = 0;
  let noLogo = 0;
  let ambiguous = 0;
  let invalidEmail = 0;
  let notFound = 0;

  for (let i = 0; i < jsonRows.length; i += 1) {
    const rowIndex = i + 1;
    const email = resolveEmail(jsonRows[i]);
    if (!email || !isValidEmail(email)) {
      invalidEmail += 1;
      reportRows.push([rowIndex, 'invalid_email', email, '', '', '', ''].join(','));
      continue;
    }

    const shop = await prisma.shop.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, name: true, logoUrl: true },
    });

    if (!shop) {
      notFound += 1;
      reportRows.push([rowIndex, 'email_not_found', email, '', '', '', ''].join(','));
      continue;
    }

    const candidates = resolveNames(jsonRows[i]);
    let matchedUrl = '';
    let matchedName = '';
    let matchType = '';

    for (const candidate of candidates) {
      const key = normalizeName(candidate);
      if (!key) continue;
      const urls = logoIndex.get(key);
      if (!urls || urls.size === 0) continue;
      if (urls.size > 1) {
        ambiguous += 1;
        reportRows.push(
          [rowIndex, 'ambiguous_logo', email, shop.name || '', candidate, '', 'multiple urls'].join(',')
        );
        matchedUrl = '';
        matchType = 'ambiguous';
        break;
      }
      matchedUrl = Array.from(urls)[0];
      matchedName = candidate;
      matchType = 'exact';
      break;
    }

    if (!matchedUrl && matchType !== 'ambiguous') {
      noLogo += 1;
      reportRows.push([rowIndex, 'logo_not_found', email, shop.name || '', '', '', ''].join(','));
      continue;
    }

    if (!matchedUrl) {
      continue;
    }

    if (shop.logoUrl === matchedUrl) {
      unchanged += 1;
      reportRows.push(
        [rowIndex, 'unchanged', email, shop.name || '', matchedName, matchedUrl, matchType].join(',')
      );
      continue;
    }

    await prisma.shop.update({
      where: { id: shop.id },
      data: { logoUrl: matchedUrl },
    });
    updated += 1;
    reportRows.push([rowIndex, 'updated', email, shop.name || '', matchedName, matchedUrl, matchType].join(','));
  }

  const reportDir = path.join(process.cwd(), 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'logo-import-by-email.csv');
  fs.writeFileSync(reportPath, reportRows.join('\n'));

  const summary = {
    total: jsonRows.length,
    updated,
    unchanged,
    no_logo_match: noLogo,
    ambiguous,
    invalid_email: invalidEmail,
    email_not_found: notFound,
  };

  const summaryPath = path.join(reportDir, 'logo-import-by-email-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log('Importación por email finalizada.');
  console.log(`- Reporte: ${reportPath}`);
  console.log(`- Resumen: ${summaryPath}`);
  console.log(summary);
};

run()
  .catch((error) => {
    console.error('Error en importación por email:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
