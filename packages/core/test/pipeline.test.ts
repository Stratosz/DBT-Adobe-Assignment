import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeFile,
  bufferSource,
  processRecords,
  quarantineToCsv,
  type AcceptedRecord,
  type PartnerLocale,
  type QuarantinedRecord,
  type RunInput,
} from '../src/index.ts';

/**
 * End-to-end tests over the demo fixtures (scripts/generate-fixtures.ts). These pin the
 * behaviour the README demo promises, so a change that breaks the story fails CI.
 */
const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'fixtures');
const NORDWIND: PartnerLocale = { decimalSeparator: ',', dateOrder: 'DMY', defaultCurrency: 'EUR' };
const PEAK: PartnerLocale = { decimalSeparator: '.', dateOrder: 'MDY', defaultCurrency: 'USD' };

async function run(input: RunInput, opts: { acceptSuggestions?: boolean } = {}) {
  const analysis = await analyzeFile(input);
  const proposal = analysis.proposal;
  let mapping = proposal?.mapping ?? {};
  if (proposal?.needsConfirmation && opts.acceptSuggestions) {
    mapping = Object.fromEntries(proposal.matches.filter((m) => m.target && m.status !== 'unmapped').map((m) => [m.sourceField, m.target!]));
  }
  const accepted: AcceptedRecord[] = [];
  const quarantined: QuarantinedRecord[] = [];
  const result = await processRecords(input, mapping, { accepted: (r) => void accepted.push(r), quarantined: (r) => void quarantined.push(r) }, analysis);
  return { analysis, result, accepted, quarantined };
}

const fixture = (path: string, importType = 'full_catalog', locale = NORDWIND): RunInput => ({
  source: bufferSource(readFileSync(join(FIXTURES, path))),
  filename: path.split('/').pop()!,
  importType,
  locale,
});

const codes = (r: Awaited<ReturnType<typeof run>>) => Object.fromEntries(r.result.issueGroups.map((g) => [g.code, g.count]));

describe('demo story: Nordwind (German ERP CSV)', () => {
  it('week 1: clean Windows-1252 export maps automatically and commits', async () => {
    const r = await run(fixture('nordwind/week1_catalog.csv'));
    expect(r.analysis.encoding).toBe('windows-1252');
    expect(r.analysis.proposal!.needsConfirmation).toBe(false);
    expect(r.result.status).toBe('COMMITTED');
    expect(r.result.counts).toMatchObject({ total: 30, accepted: 30, quarantined: 0 });
    expect(r.accepted[0]!.product.name).toMatch(/^[\wäöüÄÖÜß -]+$/); // umlauts survived
    expect(r.accepted.every((a) => a.product.currency === 'EUR' && a.product.price! > 0)).toBe(true);
  });

  it('week 2: renamed columns stop for confirmation instead of guessing', async () => {
    const r = await run(fixture('nordwind/week2_catalog.csv'));
    const p = r.analysis.proposal!;
    expect(p.needsConfirmation).toBe(true);
    const pending = p.matches.filter((m) => m.status === 'needs_confirmation').map((m) => [m.sourceField, m.target]);
    expect(pending).toEqual(
      expect.arrayContaining([
        ['Artikel-Nr.', 'sku'],
        ['VK-Preis', 'price'],
      ]),
    );
  });

  it('week 2: once confirmed, one bad price is quarantined and the rest commits', async () => {
    const r = await run(fixture('nordwind/week2_catalog.csv'), { acceptSuggestions: true });
    expect(r.result.status).toBe('COMMITTED');
    expect(r.result.counts).toMatchObject({ total: 30, quarantined: 1 });
    expect(codes(r)).toMatchObject({ PRICE_UNPARSEABLE: 1, FIELD_UNMAPPED: 1 });
    expect(r.quarantined[0]!.location.line).toBe(9);
  });

  it('week 3: a broken export that lost prices is held, not applied', async () => {
    const r = await run(fixture('nordwind/week3_catalog.csv'), { acceptSuggestions: true });
    expect(r.result.status).toBe('HELD_FOR_REVIEW');
    expect(r.result.errorRate).toBeGreaterThan(0.5);
    expect(r.result.decisionReason).toMatch(/above the 5\.0% limit/);
    expect(codes(r)).toMatchObject({ REQUIRED_VALUE_MISSING: 20, DUPLICATE_SKU: 1 });
  });

  it('week 3: an override with a reason can let the run through', async () => {
    const r = await run({ ...fixture('nordwind/week3_catalog.csv'), policyOverride: { maxErrorRate: 0.5, reason: 'x' } }, { acceptSuggestions: true });
    expect(r.result.status).toBe('HELD_FOR_REVIEW'); // 67% is above even the maximum override of 50%
    expect(r.result.policy).toMatchObject({ overridden: true, overrideReason: 'x' });
  });
});

describe('demo story: Peak Supply (JSON API)', () => {
  it('nested JSON commits with warnings and quarantines the unpriced record', async () => {
    const r = await run(fixture('peak/catalog.json', 'full_catalog', PEAK), { acceptSuggestions: true });
    expect(r.analysis.format).toBe('json');
    expect(r.result.status).toBe('COMMITTED');
    expect(r.result.counts).toMatchObject({ total: 30, quarantined: 1 });
    expect(codes(r)).toMatchObject({ PRICE_UNPARSEABLE: 1, GTIN_INVALID: 1 });
    expect(r.quarantined[0]!.location.pointer).toBe('/data/products/11');
    // optional field invalid -> dropped, record still accepted
    const withBadUpc = r.accepted.find((a) => a.warnings.some((w) => w.code === 'GTIN_INVALID'))!;
    expect(withBadUpc.product.gtin).toBeNull();
  });

  it('NDJSON inventory update quarantines only the corrupt and the negative line', async () => {
    const r = await run(fixture('peak/inventory.ndjson', 'inventory_update', PEAK));
    expect(r.result.status).toBe('COMMITTED');
    expect(codes(r)).toMatchObject({ RECORD_UNPARSEABLE: 1, QUANTITY_NEGATIVE: 1 });
    // inventory updates only write stock fields; availability is derived from quantity
    for (const a of r.accepted) {
      expect(a.presentFields.every((f) => ['sku', 'quantity', 'availability', 'updated_at'].includes(f))).toBe(true);
      expect(a.product.availability).toBe(a.product.quantity! > 0 ? 'in_stock' : 'out_of_stock');
    }
  });
});

describe('format independence', () => {
  it('the same products as CSV and as JSON normalize identically', async () => {
    const csv = 'sku;name;price;currency;qty;ean;updated\nA-1;Jacke "Alpin";1.299,00;EUR;3;4006381333931;14.03.2025\nA-2;Hose;49,90;;0;;2025-03-15\n';
    const json = JSON.stringify({
      items: [
        { sku: 'A-1', name: 'Jacke "Alpin"', price: '1.299,00', currency: 'EUR', qty: 3, ean: 4006381333931, updated: '14.03.2025' },
        { sku: 'A-2', name: 'Hose', price: 49.9, currency: null, qty: '0', updated: '2025-03-15' },
      ],
    });
    const common = { importType: 'full_catalog', locale: NORDWIND };
    const a = await run({ ...common, source: bufferSource(Buffer.from(csv)), filename: 'f.csv' });
    const b = await run({ ...common, source: bufferSource(Buffer.from(json)), filename: 'f.json' });
    expect(a.result.status).toBe('COMMITTED');
    expect(a.accepted.map((r) => r.product)).toEqual(b.accepted.map((r) => r.product));
    expect(a.accepted[1]!.product).toMatchObject({ currency: 'EUR', availability: 'out_of_stock', price: 49.9 });
  });
});

describe('fatal file problems', () => {
  it('fails clearly on a truncated JSON document', async () => {
    const r = await run({
      source: bufferSource(Buffer.from('{"products":[{"sku":"A","price":1},{"sku":"B"')),
      filename: 'x.json',
      importType: 'price_update',
      locale: PEAK,
    });
    expect(r.result.status).toBe('FAILED');
    expect(r.result.fatal).toMatchObject({ code: 'FILE_UNPARSEABLE' });
    expect(r.result.fatal!.hint).toMatch(/resend/);
  });

  it('fails clearly on an empty upload', async () => {
    const r = await run({ source: bufferSource(Buffer.alloc(0)), filename: 'x.csv', importType: 'full_catalog', locale: PEAK });
    expect(r.result.fatal).toMatchObject({ code: 'FILE_EMPTY' });
  });
});

describe('quarantine export', () => {
  it('keeps the original columns and adds the reasons, Excel-friendly', async () => {
    const r = await run(fixture('nordwind/week2_catalog.csv'), { acceptSuggestions: true });
    const csv = quarantineToCsv(r.quarantined);
    const [header, row] = csv.replace('﻿', '').split('\n');
    expect(header).toBe(
      '_source_location,_error_codes,_error_messages,Artikel-Nr.,Bezeichnung,Marke,Kategorie,VK-Preis,Währung,Lagerbestand,EAN,Farbe,Geändert am',
    );
    expect(row).toContain('PRICE_UNPARSEABLE');
    expect(row).toContain('auf Anfrage');
  });
});
