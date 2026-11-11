/**
 * Generates the demo fixtures deterministically (seeded), so the story is reproducible:
 *
 *  Nordwind Outdoor (German supplier, Excel/ERP CSV export, ";" + decimal comma, Windows-1252)
 *    week1_catalog.csv   clean export                                  -> COMMITTED
 *    week2_catalog.csv   columns renamed + new column + one bad price  -> needs mapping confirmation, then COMMITTED
 *    week3_catalog.csv   same columns, broken ERP export (prices gone)  -> HELD_FOR_REVIEW (saved mapping reused)
 *
 *  Peak Supply Co (US supplier, JSON API)
 *    catalog.json        nested JSON, a few bad values                 -> COMMITTED with warnings
 *    inventory.ndjson    stock levels, one corrupt line                -> COMMITTED (inventory_update)
 *
 * Run: npx tsx scripts/generate-fixtures.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;

function gtin13(prefix: string): string {
  let body = prefix;
  while (body.length < 12) body += Math.floor(rand() * 10);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return body + ((10 - (sum % 10)) % 10);
}
function upc12(): string {
  let body = '0';
  while (body.length < 11) body += Math.floor(rand() * 10);
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += Number(body[i]) * (i % 2 === 0 ? 3 : 1);
  return body + ((10 - (sum % 10)) % 10);
}

const NAMES = ['Wanderjacke', 'Regenhose', 'Trekkingschuh', 'Fleecepullover', 'Rucksack 30L', 'Schlafsack Daune', 'Stirnlampe', 'Trinkflasche', 'Zelt 2P', 'Wandersocken', 'Softshell-Weste', 'Gamaschen'];
const COLORS = ['Blau', 'Grün', 'Schwarz', 'Rot', 'Grau'];
const BRANDS = ['Nordwind', 'Fjellgut', 'Bergwerk', 'Höhenluft'];
const CATS = ['Bekleidung > Jacken', 'Bekleidung > Hosen', 'Schuhe > Trekking', 'Ausrüstung > Rucksäcke', 'Ausrüstung > Zelte'];
const deMoney = (n: number) => n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');

interface NwProduct { sku: string; name: string; brand: string; cat: string; price: number; qty: number; ean: string; color: string; changed: string }
const nordwind: NwProduct[] = Array.from({ length: 30 }, (_, i) => ({
  sku: `NW-${String(1000 + i)}`,
  name: `${pick(NAMES)} ${pick(COLORS)}`,
  brand: pick(BRANDS),
  cat: pick(CATS),
  price: Math.round((15 + rand() * 1400) * 100) / 100,
  qty: Math.floor(rand() * 60),
  ean: gtin13('400'),
  color: pick(COLORS),
  changed: `${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}.10.2026`,
}));

function toCp1252(text: string): Buffer {
  // Node has no cp1252 encoder; latin1 covers every character used here (umlauts, ß).
  return Buffer.from(text, 'latin1');
}

const root = join(import.meta.dirname, '..', 'fixtures');
mkdirSync(join(root, 'nordwind'), { recursive: true });
mkdirSync(join(root, 'peak'), { recursive: true });

// ---- Nordwind week 1: clean, Windows-1252, ";" separated -------------------------------------
{
  const header = 'Artikelnummer;Bezeichnung;Marke;Kategorie;Preis;Währung;Bestand;EAN;Verfügbarkeit;Geändert am';
  const rows = nordwind.map((p, i) => [
    p.sku, p.name, p.brand, p.cat, deMoney(p.price), 'EUR', p.qty, p.ean,
    p.qty > 0 ? 'Auf Lager' : 'Ausverkauft', p.changed,
  ].join(';'));
  writeFileSync(join(root, 'nordwind', 'week1_catalog.csv'), toCp1252(`${header}\r\n${rows.join('\r\n')}\r\n`));
}

// ---- Nordwind week 2: ERP upgrade renamed columns, added "Farbe", one price "auf Anfrage" -----
{
  const header = 'Artikel-Nr.;Bezeichnung;Marke;Kategorie;VK-Preis;Währung;Lagerbestand;EAN;Farbe;Geändert am';
  const rows = nordwind.map((p, i) => [
    p.sku, p.name, p.brand, p.cat, i === 7 ? 'auf Anfrage' : deMoney(p.price * 1.03), 'EUR', p.qty, p.ean, p.color, p.changed.replace('.10.', '.11.'),
  ].join(';'));
  writeFileSync(join(root, 'nordwind', 'week2_catalog.csv'), toCp1252(`${header}\r\n${rows.join('\r\n')}\r\n`));
}

// ---- Nordwind week 3: same layout as week 2, but the export lost most prices ------------------
{
  const header = 'Artikel-Nr.;Bezeichnung;Marke;Kategorie;VK-Preis;Währung;Lagerbestand;EAN;Farbe;Geändert am';
  const rows = nordwind.map((p, i) => [
    p.sku, p.name, p.brand, p.cat, i % 3 === 0 ? deMoney(p.price) : '', 'EUR', p.qty, p.ean, p.color, '09.11.2026',
  ].join(';'));
  rows.push(rows[3]!); // duplicate row from a bad join
  writeFileSync(join(root, 'nordwind', 'week3_catalog.csv'), toCp1252(`${header}\r\n${rows.join('\r\n')}\r\n`));
}

// ---- Peak Supply: nested JSON from their API -------------------------------------------------
const GEAR = ['Trail Runner', 'Rain Shell', 'Camp Stove', 'Dry Bag 20L', 'Trekking Poles', 'Bivy Sack', 'Water Filter', 'Base Layer', 'Insulated Mug', 'Map Case'];
const peak = Array.from({ length: 30 }, (_, i) => ({
  sku: `PK${String(5000 + i)}`,
  name: `${pick(GEAR)} ${pick(['Pro', 'Lite', 'XL', 'Classic'])}`,
  price: Math.round((9 + rand() * 300) * 100) / 100,
  qty: Math.floor(rand() * 200),
  upc: upc12(),
}));
{
  const products = peak.map((p, i) => ({
    productId: p.sku,
    title: p.name,
    brand: { name: 'Peak Supply Co' },
    category: { path: pick(['Camping > Cooking', 'Hiking > Footwear', 'Hiking > Apparel', 'Camping > Shelter']) },
    pricing: { amount: i === 11 ? 'TBD' : p.price, currency: 'USD' },
    inventory: { onHand: p.qty, status: p.qty > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock' },
    identifiers: { upc: i === 5 ? p.upc.slice(0, -1) + ((Number(p.upc.at(-1)) + 1) % 10) : p.upc },
    links: { product: `https://peak-supply.example/p/${p.sku.toLowerCase()}` },
    updatedAt: i % 4 === 0 ? `0${1 + (i % 9)}/04/2026` : `2026-11-0${1 + (i % 8)}T08:00:00Z`,
    tags: ['outdoor', i % 2 ? 'sale' : 'new'],
    images: [{ url: `https://img.peak-supply.example/${p.sku}.jpg`, alt: p.name }],
  }));
  const doc = { meta: { exportedAt: '2026-11-09T22:00:00Z', page: 1, warnings: [] }, data: { products } };
  writeFileSync(join(root, 'peak', 'catalog.json'), `${JSON.stringify(doc, null, 2)}\n`);
}

// ---- Peak Supply: NDJSON inventory feed --------------------------------------------------------
{
  const lines = peak.slice(0, 25).map((p, i) => {
    if (i === 9) return `{"productId":"${p.sku}","onHand":12,"updatedAt":"2026-11-10T06:00:00Z"`; // truncated line
    if (i === 17) return JSON.stringify({ productId: p.sku, onHand: -4, updatedAt: '2026-11-10T06:00:00Z' });
    return JSON.stringify({ productId: p.sku, onHand: Math.max(0, p.qty - Math.floor(rand() * 10)), updatedAt: '2026-11-10T06:00:00Z' });
  });
  writeFileSync(join(root, 'peak', 'inventory.ndjson'), `${lines.join('\n')}\n`);
}

// ---- Feedback round 1 fixtures ----------------------------------------------------------------
// #2 An older stock file that arrives after the newer one (SFTP retry): every record is older than
//    the catalog once inventory.ndjson (06:00) has been applied, so all are skipped as stale.
{
  const lines = peak.slice(0, 25).map((p) => JSON.stringify({ productId: p.sku, onHand: p.qty + 50, updatedAt: '2026-11-10T05:00:00Z' }));
  writeFileSync(join(root, 'peak', 'inventory_late.ndjson'), `${lines.join('\n')}\n`);
}
// #3 A price update where the supplier's export divided every price by 10 (all values valid).
{
  const header = 'productId,unitPrice,currency,updatedAt';
  const rows = peak.slice(0, 12).map((p) => `${p.sku},${(p.price / 10).toFixed(2)},USD,2026-11-11T07:00:00Z`);
  writeFileSync(join(root, 'peak', 'prices_bug.csv'), `${header}\n${rows.join('\n')}\n`);
}
// #4 A tiny price fix with one typo ("1O.99" with a letter O): 1 of 3 rows bad.
{
  const header = 'productId,unitPrice,currency,updatedAt';
  const rows = peak.slice(20, 23).map((p, i) => `${p.sku},${i === 1 ? '1O.99' : (p.price * 1.05).toFixed(2)},USD,2026-11-11T08:00:00Z`);
  writeFileSync(join(root, 'peak', 'prices_small_fix.csv'), `${header}\n${rows.join('\n')}\n`);
}

console.log('fixtures written to', root);
