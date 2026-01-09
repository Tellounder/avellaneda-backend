import fs from 'fs';
import path from 'path';
import prisma from '../prisma/client';

type RawShop = Record<string, unknown>;

const DEFAULT_JSON_PATH = '/home/analia/Escritorio/datos_convertidos.json';

const normalizeEmail = (value: unknown) => String(value || '').trim().toLowerCase();
const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const resolveEmail = (row: RawShop) => {
  const raw = row['Mail'] ?? row['Email'] ?? row['Correo'] ?? '';
  return normalizeEmail(raw);
};

const resolveName = (row: RawShop) => {
  const name = String(row['Nombre completo'] || '').trim();
  if (name) return name;
  const alias = String(row['Usuario'] || '').trim();
  return alias || '';
};

const run = async () => {
  const jsonPath = process.argv[2] || DEFAULT_JSON_PATH;
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`No se encontró el archivo: ${jsonPath}`);
  }

  await prisma.$connect();

  const raw = fs.readFileSync(jsonPath, 'utf8');
  const parsed = JSON.parse(raw);
  const rows: RawShop[] = Array.isArray(parsed) ? parsed : [];

  const dbShops = await prisma.shop.findMany({
    select: { id: true, email: true, name: true },
  });

  const dbEmailMap = new Map(
    dbShops
      .filter((shop) => shop.email)
      .map((shop) => [normalizeEmail(shop.email), shop])
  );

  const seenEmails = new Set<string>();
  const duplicatesInJson = new Set<string>();

  const outputRows: string[] = [
    [
      'row',
      'status',
      'email_raw',
      'email_normalized',
      'nombre',
      'db_shop_id',
      'db_shop_name',
    ].join(','),
  ];

  let invalidCount = 0;
  let duplicateCount = 0;
  let existingCount = 0;
  let newCount = 0;

  rows.forEach((row, idx) => {
    const rowIndex = idx + 1;
    const rawEmail = String(row['Mail'] ?? row['Email'] ?? row['Correo'] ?? '').trim();
    const email = resolveEmail(row);
    const name = resolveName(row);

    if (!email || !isValidEmail(email)) {
      invalidCount += 1;
      outputRows.push(
        [
          rowIndex,
          'invalid_email',
          `"${rawEmail.replace(/"/g, '""')}"`,
          email,
          `"${name.replace(/"/g, '""')}"`,
          '',
          '',
        ].join(',')
      );
      return;
    }

    if (seenEmails.has(email)) {
      duplicatesInJson.add(email);
      duplicateCount += 1;
      outputRows.push(
        [
          rowIndex,
          'duplicate_in_json',
          `"${rawEmail.replace(/"/g, '""')}"`,
          email,
          `"${name.replace(/"/g, '""')}"`,
          '',
          '',
        ].join(',')
      );
      return;
    }

    seenEmails.add(email);
    const existing = dbEmailMap.get(email);
    if (existing) {
      existingCount += 1;
      outputRows.push(
        [
          rowIndex,
          'already_in_db',
          `"${rawEmail.replace(/"/g, '""')}"`,
          email,
          `"${name.replace(/"/g, '""')}"`,
          existing.id,
          `"${(existing.name || '').replace(/"/g, '""')}"`,
        ].join(',')
      );
      return;
    }

    newCount += 1;
    outputRows.push(
      [
        rowIndex,
        'would_create',
        `"${rawEmail.replace(/"/g, '""')}"`,
        email,
        `"${name.replace(/"/g, '""')}"`,
        '',
        '',
      ].join(',')
    );
  });

  const reportDir = path.join(process.cwd(), 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const csvPath = path.join(reportDir, 'import-report.csv');
  fs.writeFileSync(csvPath, outputRows.join('\n'));

  const summary = {
    total: rows.length,
    invalid: invalidCount,
    duplicate_in_json: duplicateCount,
    already_in_db: existingCount,
    would_create: newCount,
  };
  const summaryPath = path.join(reportDir, 'import-report-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log('Reporte generado:');
  console.log(`- ${csvPath}`);
  console.log(`- ${summaryPath}`);
  console.log(summary);
};

run()
  .catch((error) => {
    console.error('Error generando reporte:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
