import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeFile,
  bufferSource,
  csvCell,
  flatten,
  processRecords,
  proposeMapping,
  quarantineToCsv,
  IMPORT_TYPES,
  type AcceptedRecord,
  type CatalogEntry,
  type PartnerLocale,
  type QuarantinedRecord,
  type RunInput,
} from '../src/index.ts';
import { csvAdapter } from '../src/formats/csv.ts';
import { ndjsonAdapter } from '../src/formats/json.ts';
import { collect } from './helpers.ts';

/** Feedback round 1 (docs/feedback-round-1.md): security findings and new data-correctness rules. */
const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'fixtures');
const US: PartnerLocale = { decimalSeparator: '.', dateOrder: 'MDY', defaultCurrency: 'USD' };

async function run(input: RunInput) {
  const analysis = await analyzeFile(input);
  const proposal = analysis.proposal;
  const mapping = proposal
    ? Object.fromEntries(proposal.matches.filter((m) => m.target && m.status !== 'unmapped').map((m) => [m.sourceField, m.target!]))
    : {};
  const accepted: AcceptedRecord[] = [];
  const quarantined: QuarantinedRecord[] = [];
  const result = await processRecords(input, mapping, { accepted: (r) => void accepted.push(r), quarantined: (r) => void quarantined.push(r) }, analysis);
  return { analysis, result, accepted, quarantined };
}
const text = (s: string, importType = 'full_catalog', extra: Partial<RunInput> = {}): RunInput => ({
  source: bufferSource(Buffer.from(s)),
  filename: extra.filename ?? 'f.csv',
  importType,
  locale: US,
  ...extra,
});

describe('security: prototype pollution', () => {
  it('treats __proto__ and constructor as ordinary column names', async () => {
    const events = await collect(csvAdapter, 'sku,__proto__,constructor\nA,{"polluted":true},x\n');
    const fields = events[0]!.type === 'record' ? events[0]!.record.fields : {};
    expect(Object.keys(fields)).toEqual(['sku', '__proto__', 'constructor']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('flattens JSON with a __proto__ key without touching any prototype', () => {
    const value = JSON.parse('{"sku":"A","__proto__":{"polluted":true},"nested":{"__proto__":{"x":1}}}');
    const flat = flatten(value);
    expect(flat['__proto__.polluted']).toBe(true);
    expect(Object.getPrototypeOf(flat)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not read inherited properties as saved mappings', () => {
    const p = proposeMapping(
      [
        { name: 'constructor', samples: ['x'] },
        { name: 'sku', samples: ['A'] },
      ],
      IMPORT_TYPES.full_catalog,
      US,
      {},
    );
    expect(p.matches.find((m) => m.sourceField === 'constructor')!.method).not.toBe('saved');
  });
});

describe('security: CSV formula injection in quarantine exports', () => {
  it.each([
    ['=HYPERLINK("http://evil.example","click")', `"'=HYPERLINK(""http://evil.example"",""click"")"`],
    ['+cmd|/c calc', "'+cmd|/c calc"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['normal text', 'normal text'],
  ])('neutralizes %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('applies to supplier values in the downloaded file', async () => {
    const r = await run(text('sku,name,price\nA,=1+1,not-a-price\n'));
    expect(quarantineToCsv(r.quarantined)).toContain("'=1+1");
  });
});

describe('security: size limits', () => {
  it('quarantines a record with too many fields instead of processing it', async () => {
    const header = Array.from({ length: 600 }, (_, i) => `c${i}`).join(',');
    const row = Array.from({ length: 600 }, () => 'x').join(',');
    const r = await run(text(`sku,name,price\nA,ok,1\n`.replace('\n', `,${header}\n`).replace('1\n', `1,${row}\n`)));
    expect(r.result.issueGroups.map((g) => g.code)).toContain('RECORD_TOO_LARGE');
  });

  it('quarantines an NDJSON line over 1 MB without buffering the whole file', async () => {
    const huge = `{"sku":"B","name":"${'x'.repeat(1_100_000)}"}`;
    const events = await collect(ndjsonAdapter, `{"sku":"A"}\n${huge}\n{"sku":"C"}\n`, undefined, 64 * 1024);
    expect(events.map((e) => (e.type === 'record' ? e.record.fields.sku : e.issue.code))).toEqual(['A', 'RECORD_TOO_LARGE', 'C']);
  });

  it('quarantines over-long values', async () => {
    const r = await run(text(`sku,name,price\nA,${'y'.repeat(10_001)},1\nB,ok,2\n`));
    expect(r.result.counts).toMatchObject({ quarantined: 1, accepted: 1 });
  });
});

describe('#4 minimum count before holding', () => {
  it('commits a 3-row price fix with one typo, and says why it was not held', async () => {
    const input = {
      source: bufferSource(readFileSync(join(FIXTURES, 'peak/prices_small_fix.csv'))),
      filename: 'prices_small_fix.csv',
      importType: 'price_update',
      locale: US,
    };
    const r = await run(input);
    expect(r.result.status).toBe('COMMITTED');
    expect(r.result.counts).toMatchObject({ total: 3, quarantined: 1, accepted: 2 });
    expect(r.result.decisionReason).toMatch(/above the 2\.0% limit, but only 1/);
  });

  it('still holds once the minimum count is reached', async () => {
    const r = await run(text('sku,price\nA,1\nB,x\nC,y\n', 'price_update'));
    expect(r.result.status).toBe('HELD_FOR_REVIEW');
  });
});

describe('catalog guards', () => {
  const catalog = new Map<string, CatalogEntry>([
    ['A', { price: 100, currency: 'USD', updated_at: '2026-11-10T06:00:00.000Z' }],
    ['B', { price: 100, currency: 'USD', updated_at: '2026-11-10T06:00:00.000Z' }],
    ['C', { price: 100, currency: 'EUR', updated_at: null }],
  ]);
  const lookup = (sku: string) => catalog.get(sku) ?? null;

  it('#2 skips records older than the catalog and applies newer ones', async () => {
    const r = await run(
      text('sku,quantity,updated_at\nA,5,2026-11-10T05:00:00Z\nB,7,2026-11-10T07:00:00Z\nZ,1,2026-01-01T00:00:00Z\n', 'inventory_update', { catalog: lookup }),
    );
    expect(r.result.counts).toMatchObject({ skippedStale: 1, accepted: 2, quarantined: 0 });
    expect(r.accepted.map((a) => a.product.sku)).toEqual(['B', 'Z']);
    expect(r.result.status).toBe('COMMITTED');
  });

  it('#3 holds the run when prices swing more than the limit, but keeps the records', async () => {
    const r = await run(text('sku,price,currency\nA,10,USD\nB,120,USD\n', 'price_update', { catalog: lookup }));
    expect(r.result.status).toBe('HELD_FOR_REVIEW');
    expect(r.result.counts).toMatchObject({ flaggedForReview: 1, accepted: 2, quarantined: 0 });
    expect(r.result.holdReasons).toEqual(['1 price changed by more than 50% against the catalog.']);
    expect(r.result.issueGroups.find((g) => g.code === 'PRICE_SWING')!.samples).toEqual(['100 -> 10 (-90%)']);
  });

  it('#3 does not compare prices across currencies', async () => {
    const r = await run(text('sku,price,currency\nC,10,USD\n', 'price_update', { catalog: lookup }));
    expect(r.result.counts.flaggedForReview).toBe(0);
  });

  it('#3 the price bug fixture is held with a clear reason', async () => {
    const peak = new Map<string, CatalogEntry>();
    // seed the catalog from the Peak catalog fixture
    const cat = await run({
      source: bufferSource(readFileSync(join(FIXTURES, 'peak/catalog.json'))),
      filename: 'catalog.json',
      importType: 'full_catalog',
      locale: US,
    });
    for (const a of cat.accepted) peak.set(a.product.sku, { price: a.product.price, currency: a.product.currency, updated_at: a.product.updated_at });
    const r = await run({
      source: bufferSource(readFileSync(join(FIXTURES, 'peak/prices_bug.csv'))),
      filename: 'prices_bug.csv',
      importType: 'price_update',
      locale: US,
      catalog: (s) => peak.get(s) ?? null,
    });
    expect(r.result.status).toBe('HELD_FOR_REVIEW');
    expect(r.result.counts.flaggedForReview).toBeGreaterThanOrEqual(10);
    expect(r.result.decisionReason).toMatch(/changed by more than 50%/);
  });
});

describe('truncated export fixture', () => {
  it('fails clearly before anything is processed', async () => {
    const r = await run({
      source: bufferSource(readFileSync(join(FIXTURES, 'peak/catalog_broken.json'))),
      filename: 'catalog_broken.json',
      importType: 'full_catalog',
      locale: US,
    });
    expect(r.result.status).toBe('FAILED');
    expect(r.result.fatal).toMatchObject({ code: 'FILE_UNPARSEABLE', hint: expect.stringMatching(/resend/) });
  });
});
