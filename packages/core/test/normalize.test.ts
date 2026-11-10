import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  normalizeAvailability,
  normalizeCurrency,
  normalizeDate,
  normalizeGtin,
  normalizePrice,
  normalizeQuantity,
  normalizeSku,
  normalizeText,
  normalizeUrl,
  type PartnerLocale,
} from '../src/normalize/index.ts';

const US: PartnerLocale = { decimalSeparator: '.', dateOrder: 'MDY', defaultCurrency: 'USD' };
const DE: PartnerLocale = { decimalSeparator: ',', dateOrder: 'DMY', defaultCurrency: 'EUR' };

describe('normalizePrice', () => {
  it.each([
    ['19.99', US, 19.99],
    ['19,99', DE, 19.99],
    ['1,234.56', US, 1234.56],
    ['1.234,56', DE, 1234.56],
    ['1.234,56', US, 1234.56], // unambiguous regardless of locale
    ['1,234,567', US, 1234567],
    ['  12 ', US, 12],
    [12.5, US, 12.5],
    ['(5.00)', US, null], // accounting negative -> rejected below as negative
  ])('%j (%o) -> %s', (input, locale, expected) => {
    const r = normalizePrice(input, locale);
    if (expected === null) expect(r.issues[0]?.code).toBe('PRICE_NEGATIVE');
    else expect(r.value).toBe(expected);
  });

  it('extracts currency symbols and codes from the value', () => {
    expect(normalizePrice('€12,50', DE)).toMatchObject({ value: 12.5, detectedCurrency: 'EUR' });
    expect(normalizePrice('12.50 GBP', US)).toMatchObject({ value: 12.5, detectedCurrency: 'GBP' });
    expect(normalizePrice('$5', { ...US, defaultCurrency: 'CAD' })).toMatchObject({ value: 5, detectedCurrency: 'CAD' });
  });

  it('resolves "1.234" with the partner locale and says so', () => {
    expect(normalizePrice('1.234', US)).toMatchObject({ value: 1.234, issues: [{ code: 'PRICE_LOCALE_AMBIGUOUS' }] });
    expect(normalizePrice('1.234', DE)).toMatchObject({ value: 1234, issues: [{ code: 'PRICE_LOCALE_AMBIGUOUS' }] });
  });

  it.each(['abc', '12.34.56,7,8', 'call us'])('rejects %j', (input) => {
    expect(normalizePrice(input, US)).toMatchObject({ value: null, issues: [{ code: 'PRICE_UNPARSEABLE' }] });
  });

  it.each(['', 'N/A', null, undefined, '-'])('treats %j as missing, not invalid', (input) => {
    expect(normalizePrice(input, US)).toEqual({ value: null, issues: [] });
  });
});

describe('normalizeQuantity', () => {
  it.each([
    ['12', 12],
    [7, 7],
    ['1,000', 1000],
    ['1.000', 1000],
    ['1 000', 1000],
    ['12.0', 12],
  ])('%j -> %d', (input, expected) => {
    expect(normalizeQuantity(input, DE).value).toBe(expected);
  });
  it.each([
    ['12.5', 'QUANTITY_INVALID'],
    ['lots', 'QUANTITY_INVALID'],
    ['-3', 'QUANTITY_NEGATIVE'],
  ])('%j -> %s', (input, code) => {
    expect(normalizeQuantity(input, US).issues[0]?.code).toBe(code);
  });
});

describe('normalizeDate', () => {
  it.each([
    ['2025-03-14T10:00:00Z', '2025-03-14T10:00:00.000Z'],
    ['2025-03-14T12:00:00+02:00', '2025-03-14T10:00:00.000Z'],
    ['2025-03-14', '2025-03-14T00:00:00.000Z'],
    ['2025-03-14 08:30', '2025-03-14T08:30:00.000Z'],
    ['14.03.2025', '2025-03-14T00:00:00.000Z'],
    ['25/12/2025', '2025-12-25T00:00:00.000Z'], // unambiguous: 25 can only be a day
    ['12/25/2025', '2025-12-25T00:00:00.000Z'],
    [1741946400, '2025-03-14T10:00:00.000Z'],
    ['1741946400000', '2025-03-14T10:00:00.000Z'],
  ])('%j -> %s', (input, expected) => {
    expect(normalizeDate(input, US)).toEqual({ value: expected, issues: [] });
  });

  it('resolves 03/04/2025 by partner locale and reports it', () => {
    expect(normalizeDate('03/04/2025', US)).toMatchObject({ value: '2025-03-04T00:00:00.000Z', issues: [{ code: 'DATE_AMBIGUOUS' }] });
    expect(normalizeDate('03/04/2025', DE)).toMatchObject({ value: '2025-04-03T00:00:00.000Z', issues: [{ code: 'DATE_AMBIGUOUS' }] });
  });

  it.each(['2025-02-30', '31/31/2025', 'last tuesday', '2025-13-01'])('rejects %j', (input) => {
    expect(normalizeDate(input, DE).issues[0]?.code).toBe('DATE_UNPARSEABLE');
  });
});

describe('normalizeGtin', () => {
  it.each([
    ['4006381333931', '4006381333931'], // EAN-13
    ['036000291452', '036000291452'], // UPC-A
    ['36000291452', '036000291452'], // UPC-A that lost its leading zero in Excel
    ['4006-3813-3393-1', '4006381333931'],
    [4006381333931, '4006381333931'],
    ['96385074', '96385074'], // EAN-8
  ])('%j -> %s', (input, expected) => {
    expect(normalizeGtin(input).value).toBe(expected);
  });
  it.each(['4006381333932', '4.00638E+12', 'ABC123', '123'])('rejects %j', (input) => {
    expect(normalizeGtin(input).issues[0]?.code).toBe('GTIN_INVALID');
  });
});

describe('normalizeAvailability', () => {
  it.each([
    ['In Stock', 'in_stock'],
    ['https://schema.org/InStock', 'in_stock'],
    ['OOS', 'out_of_stock'],
    ['Ausverkauft', 'out_of_stock'],
    ['Verfügbar', 'in_stock'],
    [true, 'in_stock'],
    ['pre-order', 'preorder'],
    ['EOL', 'discontinued'],
  ])('%j -> %s', (input, expected) => {
    expect(normalizeAvailability(input).value).toBe(expected);
  });
  it('rejects unknown vocabulary', () => {
    expect(normalizeAvailability('maybe').issues[0]?.code).toBe('AVAILABILITY_UNKNOWN');
  });
});

describe('text, sku, currency, url', () => {
  it('cleans text', () => {
    expect(normalizeText('  Shirt &amp; Tie\n blue ').value).toBe('Shirt & Tie blue');
    expect(normalizeText('x'.repeat(600)).issues[0]?.code).toBe('TEXT_TRUNCATED');
  });
  it("strips Excel's text-forcing apostrophe from SKUs and stringifies numbers", () => {
    expect(normalizeSku("'00123").value).toBe('00123');
    expect(normalizeSku(4711).value).toBe('4711');
  });
  it('normalizes currencies', () => {
    expect(normalizeCurrency('eur').value).toBe('EUR');
    expect(normalizeCurrency('€').value).toBe('EUR');
    expect(normalizeCurrency('EURO').issues[0]?.code).toBe('CURRENCY_INVALID');
  });
  it('normalizes URLs', () => {
    expect(normalizeUrl('www.shop.example/p/1').value).toBe('https://www.shop.example/p/1');
    expect(normalizeUrl('javascript:alert(1)').issues[0]?.code).toBe('URL_INVALID');
  });
  it('default locale is defined', () => {
    expect(DEFAULT_LOCALE.defaultCurrency).toMatch(/^[A-Z]{3}$/);
  });
});
