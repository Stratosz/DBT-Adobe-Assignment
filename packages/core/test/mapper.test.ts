import { describe, expect, it } from 'vitest';
import { applyDecisions, fingerprintFields, proposeMapping, type FieldProfile } from '../src/mapping/mapper.ts';
import { normalizeFieldName } from '../src/mapping/similarity.ts';
import { IMPORT_TYPES } from '../src/schema/importTypes.ts';
import type { PartnerLocale } from '../src/normalize/index.ts';

const DE: PartnerLocale = { decimalSeparator: ',', dateOrder: 'DMY', defaultCurrency: 'EUR' };
const full = IMPORT_TYPES.full_catalog;

const profiles = (fields: Record<string, unknown[]>): FieldProfile[] => Object.entries(fields).map(([name, samples]) => ({ name, samples }));

const byField = (p: ReturnType<typeof proposeMapping>) => Object.fromEntries(p.matches.map((m) => [m.sourceField, m]));

describe('normalizeFieldName', () => {
  it.each([
    ['Artikel-Nr.', 'artikel_nr'],
    ['ProductName', 'product_name'],
    [' Unit Price (EUR) ', 'unit_price_eur'],
    ['Größe', 'groesse'],
    ['Währung', 'waehrung'],
  ])('%j -> %s', (input, expected) => expect(normalizeFieldName(input)).toBe(expected));
});

describe('proposeMapping', () => {
  it('auto-maps a clean feed without asking anything', () => {
    const p = proposeMapping(
      profiles({ sku: ['A1'], name: ['Shirt'], price: ['12,50'], currency: ['EUR'], quantity: ['3'], ean: ['4006381333931'], updated_at: ['2025-01-01'] }),
      full,
      DE,
    );
    expect(p.needsConfirmation).toBe(false);
    expect(p.mapping).toEqual({ sku: 'sku', name: 'name', price: 'price', currency: 'currency', quantity: 'quantity', ean: 'gtin', updated_at: 'updated_at' });
  });

  it('maps a German ERP export through known aliases', () => {
    const p = proposeMapping(profiles({ Artikelnummer: ['A1'], Bezeichnung: ['Hemd'], Preis: ['12,50'], Währung: ['EUR'], Bestand: ['3'] }), full, DE);
    expect(p.needsConfirmation).toBe(false);
    expect(Object.values(p.mapping).sort()).toEqual(['currency', 'name', 'price', 'quantity', 'sku']);
  });

  it('maps nested JSON paths', () => {
    const p = proposeMapping(
      profiles({ id_sku: ['A'], 'details.title': ['x'], 'pricing.amount': [12.5], 'pricing.currency': ['EUR'], 'stock.on_hand': [4] }),
      full,
      DE,
    );
    const m = byField(p);
    expect(m['pricing.amount']).toMatchObject({ target: 'price', status: 'auto' });
    expect(m['stock.on_hand']).toMatchObject({ target: 'quantity', status: 'auto' });
    expect(m['details.title']).toMatchObject({ target: 'name', status: 'auto' });
  });

  it('never auto-maps a required field from a fuzzy name match, even with good values', () => {
    // "Prices" is very close to "price" and every value is a valid price: score lands in the auto band...
    const p = proposeMapping(profiles({ sku: ['A1', 'B2'], name: ['x'], Prices: ['12,50', '9,99'] }), full, DE);
    const m = byField(p);
    expect(m.Prices!.confidence).toBeGreaterThanOrEqual(0.9);
    // ...but price is required, so a human confirms it once.
    expect(m.Prices).toMatchObject({ target: 'price', method: 'fuzzy', status: 'needs_confirmation' });
    expect(m.Prices!.reason).toMatch(/never auto-mapped/);
    expect(p.needsConfirmation).toBe(true);
  });

  it('lets value evidence promote an optional fuzzy match to auto', () => {
    const p = proposeMapping(profiles({ sku: ['A'], name: ['x'], price: ['1'], lastChange: ['14.03.2025', '15.03.2025'] }), full, DE);
    expect(byField(p).lastChange).toMatchObject({ target: 'updated_at', method: 'fuzzy' });
  });

  it('demotes an alias whose values contradict it', () => {
    const p = proposeMapping(profiles({ sku: ['A'], name: ['x'], price: ['call us', 'see website', 'tbd'] }), full, DE);
    expect(byField(p).price).toMatchObject({ target: 'price', status: 'needs_confirmation' });
  });

  it('recognises self-identifying values when the header says nothing', () => {
    const p = proposeMapping(profiles({ sku: ['A'], name: ['x'], price: ['1'], col7: ['4006381333931', '036000291452'] }), full, DE);
    expect(byField(p).col7).toMatchObject({ target: 'gtin', method: 'values', status: 'needs_confirmation' });
  });

  it('does not map an array element URL (image) to the product URL automatically', () => {
    const p = proposeMapping(profiles({ sku: ['A'], name: ['x'], price: ['1'], 'images[0].url': ['https://img.example/1.jpg'] }), full, DE);
    expect(byField(p)['images[0].url']!.status).not.toBe('auto');
  });

  it('flags two columns competing for the same field as a conflict', () => {
    const p = proposeMapping(profiles({ sku: ['A'], name: ['x'], price: ['10'], sale_price: ['8'] }), full, DE);
    expect(p.conflicts).toEqual([{ target: 'price', sourceFields: ['price', 'sale_price'] }]);
    expect(p.needsConfirmation).toBe(true);
  });

  it('reports required fields with no source column', () => {
    const p = proposeMapping(profiles({ sku: ['A'], name: ['x'], colour: ['red'] }), full, DE);
    expect(p.missingRequired).toEqual(['price']);
    expect(p.needsConfirmation).toBe(true);
  });

  it('applies saved partner decisions first, including "ignore"', () => {
    const p = proposeMapping(profiles({ 'Item No': ['A'], name: ['x'], 'VK-Preis': ['1,00'], 'Interne Notiz': ['x'] }), full, DE, {
      'Item No': 'sku',
      'VK-Preis': 'price',
      'Interne Notiz': null,
    });
    const m = byField(p);
    expect(m['Item No']).toMatchObject({ target: 'sku', method: 'saved', status: 'auto' });
    expect(m['Interne Notiz']).toMatchObject({ status: 'ignored', target: null });
    expect(p.needsConfirmation).toBe(false);
  });

  it('only requires price, not name, for a price update', () => {
    const p = proposeMapping(profiles({ sku: ['A'], price: ['1'] }), IMPORT_TYPES.price_update, DE);
    expect(p.missingRequired).toEqual([]);
  });
});

describe('applyDecisions', () => {
  const proposal = proposeMapping(profiles({ 'Item No': ['A'], name: ['x'], 'VK-Preis': ['1,00'] }), full, DE);

  it('produces a usable mapping once every uncertain field is decided', () => {
    const r = applyDecisions(proposal, { 'Item No': 'sku', 'VK-Preis': 'price' }, full);
    expect(r.problems).toEqual([]);
    expect(r.mapping).toEqual({ 'Item No': 'sku', name: 'name', 'VK-Preis': 'price' });
  });

  it('explains what is still wrong', () => {
    const r = applyDecisions(proposal, { 'Item No': 'name' }, full);
    expect(r.problems).toEqual(
      expect.arrayContaining(['"name" and "Item No" are both mapped to "name"', 'Required field "sku" is not mapped', '"VK-Preis" still needs a decision']),
    );
  });
});

describe('fingerprintFields', () => {
  it('ignores order and cosmetic header differences', () => {
    expect(fingerprintFields(['SKU', 'Price'])).toBe(fingerprintFields(['price', 'sku']));
    expect(fingerprintFields(['sku', 'price'])).not.toBe(fingerprintFields(['sku', 'price', 'ean']));
  });
});
