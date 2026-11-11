/**
 * Generate a large synthetic feed for performance measurement.
 *   npm run gen:large -- 1000000 csv     -> fixtures/generated/large_1000000.csv
 *   npm run gen:large -- 200000 ndjson   -> one JSON object per line
 *   npm run gen:large -- 200000 json     -> one JSON document: {"products": [...]}
 * About 2% of rows carry a defect (bad price, empty SKU, bad GTIN) so the error path is exercised.
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const FORMATS = ['csv', 'ndjson', 'json'] as const;
const rows = Number(process.argv[2] ?? 100_000);
const format = (process.argv[3] ?? 'csv') as (typeof FORMATS)[number];
if (!Number.isInteger(rows) || rows < 1 || !FORMATS.includes(format)) {
  console.error(`usage: npm run gen:large -- <rows> [${FORMATS.join('|')}]`);
  process.exit(2);
}
const dir = join(import.meta.dirname, '..', 'fixtures', 'generated');
mkdirSync(dir, { recursive: true });
const path = join(dir, `large_${rows}.${format}`);
const out = createWriteStream(path);
const write = async (text: string) => {
  if (!out.write(text)) await new Promise((r) => out.once('drain', r));
};

let seed = 7;
const rand = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;

if (format === 'csv') await write('sku,name,price,currency,quantity,ean,updated_at\n');
if (format === 'json') await write('{"meta":{"generator":"generate-large-feed"},"products":[\n');
for (let i = 0; i < rows; i++) {
  const defect = rand() < 0.02 ? Math.floor(rand() * 3) : -1;
  const sku = defect === 1 ? '' : `SKU-${i}`;
  const price = defect === 0 ? 'n/a' : (rand() * 500).toFixed(2);
  const ean = defect === 2 ? '4006381333932' : '4006381333931';
  const qty = Math.floor(rand() * 100);
  if (format === 'csv') {
    await write(`${sku},Product ${i},${price},EUR,${qty},${ean},2026-11-10T08:00:00Z\n`);
  } else {
    const record = JSON.stringify({ sku, name: `Product ${i}`, price, currency: 'EUR', quantity: qty, ean, updated_at: '2026-11-10T08:00:00Z' });
    await write(format === 'json' ? `${i ? ',\n' : ''}${record}` : `${record}\n`);
  }
}
if (format === 'json') await write('\n]}\n');
out.end();
await new Promise((r) => out.once('finish', r));
console.log(`wrote ${rows} rows to ${path}`);
