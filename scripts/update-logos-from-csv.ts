import fs from 'fs';
import path from 'path';
import prisma from '../prisma/client';

type CsvRow = {
  name: string;
  url: string;
};

const DEFAULT_CSV_PATH = '/home/analia/Escritorio/logos_tiendas.csv';

const normalizeName = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

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

const run = async () => {
  const csvPath = process.argv[2] || DEFAULT_CSV_PATH;
  if (!fs.existsSync(csvPath)) {
    throw new Error(`No se encontró el archivo: ${csvPath}`);
  }

  await prisma.$connect();

  const csvRows = readCsv(csvPath);
  const shopRows = await prisma.shop.findMany({
    select: { id: true, name: true, razonSocial: true, logoUrl: true },
  });

  const shopIndex = new Map<string, typeof shopRows>();
  const addToIndex = (key: string, shop: (typeof shopRows)[number]) => {
    const list = shopIndex.get(key) || [];
    list.push(shop);
    shopIndex.set(key, list);
  };

  shopRows.forEach((shop) => {
    if (shop.name) addToIndex(normalizeName(shop.name), shop);
    if (shop.razonSocial) addToIndex(normalizeName(shop.razonSocial), shop);
  });

  const seenNames = new Map<string, string>();
  const reportRows: string[] = [
    [
      'row',
      'status',
      'csv_name',
      'normalized_name',
      'url',
      'shop_id',
      'shop_name',
      'note',
    ].join(','),
  ];

  let updated = 0;
  let unchanged = 0;
  let emptyUrl = 0;
  let notFound = 0;
  let ambiguous = 0;
  let duplicates = 0;

  const resolveShop = (key: string, fallbackKey: string) => {
    const exact = shopIndex.get(key) || [];
    if (exact.length === 1) return { shop: exact[0], note: 'exact' };
    if (exact.length > 1) return { shop: null, note: 'multiple_exact' };

    const candidates = shopRows.filter((shop) => {
      const normalized = normalizeName(shop.name || shop.razonSocial || '');
      return normalized.includes(fallbackKey) || fallbackKey.includes(normalized);
    });

    if (candidates.length === 1) {
      return { shop: candidates[0], note: 'fuzzy' };
    }
    if (candidates.length > 1) return { shop: null, note: 'multiple_fuzzy' };
    return { shop: null, note: 'not_found' };
  };

  for (let i = 0; i < csvRows.length; i += 1) {
    const row = csvRows[i];
    const rowIndex = i + 2;
    const normalized = normalizeName(row.name);

    if (!row.url) {
      emptyUrl += 1;
      reportRows.push(
        [rowIndex, 'empty_url', `"${row.name.replace(/"/g, '""')}"`, normalized, '', '', '', ''].join(',')
      );
      continue;
    }

    if (seenNames.has(normalized)) {
      if (seenNames.get(normalized) !== row.url) {
        duplicates += 1;
        reportRows.push(
          [
            rowIndex,
            'duplicate_name_different_url',
            `"${row.name.replace(/"/g, '""')}"`,
            normalized,
            row.url,
            '',
            '',
            'url conflict',
          ].join(',')
        );
      } else {
        reportRows.push(
          [
            rowIndex,
            'duplicate_same_url',
            `"${row.name.replace(/"/g, '""')}"`,
            normalized,
            row.url,
            '',
            '',
            'duplicado',
          ].join(',')
        );
      }
      continue;
    }
    seenNames.set(normalized, row.url);

    const { shop, note } = resolveShop(normalized, normalized);
    if (!shop) {
      if (note.includes('multiple')) {
        ambiguous += 1;
        reportRows.push(
          [rowIndex, 'ambiguous', `"${row.name.replace(/"/g, '""')}"`, normalized, row.url, '', '', note].join(',')
        );
      } else {
        notFound += 1;
        reportRows.push(
          [rowIndex, 'not_found', `"${row.name.replace(/"/g, '""')}"`, normalized, row.url, '', '', note].join(',')
        );
      }
      continue;
    }

    if (shop.logoUrl === row.url) {
      unchanged += 1;
      reportRows.push(
        [
          rowIndex,
          'unchanged',
          `"${row.name.replace(/"/g, '""')}"`,
          normalized,
          row.url,
          shop.id,
          `"${(shop.name || '').replace(/"/g, '""')}"`,
          note,
        ].join(',')
      );
      continue;
    }

    await prisma.shop.update({
      where: { id: shop.id },
      data: { logoUrl: row.url },
    });
    updated += 1;
    reportRows.push(
      [
        rowIndex,
        'updated',
        `"${row.name.replace(/"/g, '""')}"`,
        normalized,
        row.url,
        shop.id,
        `"${(shop.name || '').replace(/"/g, '""')}"`,
        note,
      ].join(',')
    );
  }

  const reportDir = path.join(process.cwd(), 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'logo-import-report.csv');
  fs.writeFileSync(reportPath, reportRows.join('\n'));

  const summary = {
    total: csvRows.length,
    updated,
    unchanged,
    empty_url: emptyUrl,
    not_found: notFound,
    ambiguous,
    duplicates,
  };

  const summaryPath = path.join(reportDir, 'logo-import-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log('Actualización de logos finalizada.');
  console.log(`- Reporte: ${reportPath}`);
  console.log(`- Resumen: ${summaryPath}`);
  console.log(summary);
};

run()
  .catch((error) => {
    console.error('Error actualizando logos:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
