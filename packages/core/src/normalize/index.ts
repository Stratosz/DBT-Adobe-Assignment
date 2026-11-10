import type { Availability, FieldType } from '../schema/canonical.ts';
import type { IssueCode } from '../errors.ts';

/**
 * Value normalizers.
 *
 * Each takes `unknown` (CSV gives strings, JSON gives numbers/booleans/strings) and returns
 * a normalized value or null, plus field-level issues. They never throw and never decide
 * whether a record is quarantined; the pipeline does that, based on whether the field is
 * required for the import type.
 */
export interface PartnerLocale {
  /** Which character is the decimal separator when a value is ambiguous (e.g. "1.234"). */
  decimalSeparator: '.' | ',';
  /** Day/month order when a date is ambiguous (e.g. 03/04/2025). */
  dateOrder: 'DMY' | 'MDY';
  /** Applied when a record has a price but no currency. */
  defaultCurrency: string;
}

export const DEFAULT_LOCALE: PartnerLocale = { decimalSeparator: '.', dateOrder: 'DMY', defaultCurrency: 'EUR' };

export interface FieldIssue {
  code: IssueCode;
  message: string;
}

export interface Normalized<T> {
  value: T | null;
  issues: FieldIssue[];
  /** Price only: a currency found inside the price text ("€12,50", "12.50 USD"). */
  detectedCurrency?: string;
}

const none = (): Normalized<never> => ({ value: null, issues: [] });
const ok = <T>(value: T | null, issues: FieldIssue[] = []): Normalized<T> => ({ value, issues });
const bad = <T>(code: IssueCode, message: string): Normalized<T> => ({ value: null, issues: [{ code, message }] });

const NULL_TOKENS = new Set(['', 'null', 'nil', 'none', 'n/a', 'na', '#n/a', '-', '--', 'undefined', '(blank)']);

export function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return NULL_TOKENS.has(v.trim().toLowerCase());
  return false;
}

// ---------------------------------------------------------------------------------- text

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
export const MAX_TEXT_LENGTH = 500;

export function normalizeText(v: unknown): Normalized<string> {
  if (isBlank(v)) return none();
  let text = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
  text = text
    .normalize('NFC')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return none();
  if (text.length > MAX_TEXT_LENGTH) {
    return ok(text.slice(0, MAX_TEXT_LENGTH), [{ code: 'TEXT_TRUNCATED', message: `Truncated from ${text.length} to ${MAX_TEXT_LENGTH} characters` }]);
  }
  return ok(text);
}

/** SKUs: text rules plus Excel's leading apostrophe (used to force "text" cells). */
export function normalizeSku(v: unknown): Normalized<string> {
  const r = normalizeText(v);
  if (r.value?.startsWith("'")) r.value = r.value.slice(1).trim() || null;
  return r;
}

// ---------------------------------------------------------------------------------- numbers

const CURRENCY_SYMBOLS: Record<string, string> = { '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₽': 'RUB', 'zł': 'PLN', lei: 'RON', kr: 'SEK', 'CHF': 'CHF', '$': 'USD' };
const DOLLAR_CURRENCIES = new Set(['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'MXN']);

/**
 * Parse a localized decimal string.
 *  - both "," and "." present: the last one is the decimal separator ("1.234,56", "1,234.56")
 *  - one separator repeated: thousands ("1,234,567")
 *  - one separator followed by exactly 3 digits ("1,234" / "1.234"): genuinely ambiguous,
 *    resolved with the partner locale and reported
 *  - otherwise the single separator is the decimal ("12,5", "12.50")
 */
export function parseDecimal(input: string, locale: PartnerLocale): { value: number | null; ambiguous: boolean } {
  let s = input.replace(/[\s  ']/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return { value: null, ambiguous: false };

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let decimalSep: ',' | '.' | null = null;
  let ambiguous = false;

  if (lastComma >= 0 && lastDot >= 0) {
    decimalSep = lastComma > lastDot ? ',' : '.';
  } else {
    const sep = lastComma >= 0 ? ',' : lastDot >= 0 ? '.' : null;
    if (sep) {
      const occurrences = s.split(sep).length - 1;
      const digitsAfter = s.length - s.lastIndexOf(sep) - 1;
      if (occurrences > 1) decimalSep = sep === ',' ? '.' : ','; // repeated -> thousands; decimal is "the other one"
      else if (digitsAfter === 3) {
        ambiguous = true;
        decimalSep = locale.decimalSeparator;
      } else decimalSep = sep;
    }
  }

  const thousandsSep = decimalSep === ',' ? '.' : ',';
  const [intPart, fracPart, ...rest] = s.split(thousandsSep).join('').split(decimalSep ?? '\u0000');
  if (rest.length > 0) return { value: null, ambiguous: false };
  const value = Number(`${intPart || '0'}${fracPart !== undefined ? `.${fracPart}` : ''}`);
  if (!Number.isFinite(value)) return { value: null, ambiguous: false };
  return { value: negative ? -value : value, ambiguous };
}

function extractCurrency(text: string, locale: PartnerLocale): { rest: string; currency?: string } {
  const code = text.match(/\b([A-Za-z]{3})\b/);
  if (code && isIsoCurrency(code[1]!.toUpperCase())) {
    return { rest: text.replace(code[0], ''), currency: code[1]!.toUpperCase() };
  }
  for (const [symbol, iso] of Object.entries(CURRENCY_SYMBOLS)) {
    if (text.includes(symbol)) {
      // "$" is shared by many currencies: trust the partner default if it is a dollar currency
      const currency = symbol === '$' && DOLLAR_CURRENCIES.has(locale.defaultCurrency) ? locale.defaultCurrency : iso;
      return { rest: text.replace(symbol, ''), currency };
    }
  }
  return { rest: text };
}

export function normalizePrice(v: unknown, locale: PartnerLocale): Normalized<number> {
  if (isBlank(v)) return none();
  let value: number | null;
  let detectedCurrency: string | undefined;
  const issues: FieldIssue[] = [];
  if (typeof v === 'number') {
    value = Number.isFinite(v) ? v : null;
  } else if (typeof v === 'string') {
    const { rest, currency } = extractCurrency(v.trim(), locale);
    detectedCurrency = currency;
    const parsed = parseDecimal(rest.trim(), locale);
    value = parsed.value;
    if (parsed.ambiguous) {
      issues.push({ code: 'PRICE_LOCALE_AMBIGUOUS', message: `"${v}" read as ${value} (partner decimal separator "${locale.decimalSeparator}")` });
    }
  } else {
    value = null;
  }
  if (value === null) return bad('PRICE_UNPARSEABLE', `"${String(v)}" is not a price`);
  if (value < 0) return bad('PRICE_NEGATIVE', `${value} is negative`);
  const result: Normalized<number> = ok(Math.round(value * 10000) / 10000, issues);
  if (detectedCurrency) result.detectedCurrency = detectedCurrency;
  return result;
}

export function normalizeQuantity(v: unknown, locale: PartnerLocale): Normalized<number> {
  if (isBlank(v)) return none();
  let value: number | null = null;
  if (typeof v === 'number') value = v;
  else if (typeof v === 'string') {
    const t = v.trim();
    // Stock is integral, so "1.000" / "1,000" / "1 000" are thousands groupings, never decimals.
    value = /^-?\d{1,3}([.,'\s ]\d{3})+$/.test(t) ? Number(t.replace(/[.,'\s ]/g, '')) : parseDecimal(t, locale).value;
  }
  if (value === null || !Number.isFinite(value)) return bad('QUANTITY_INVALID', `"${String(v)}" is not a number`);
  if (!Number.isInteger(value)) {
    // "1,000" with comma-decimal locale would read as 1.0 -> integer; "12.5" is genuinely fractional
    return bad('QUANTITY_INVALID', `${value} is not a whole number`);
  }
  if (value < 0) return bad('QUANTITY_NEGATIVE', `${value} is negative`);
  return ok(value);
}

// ---------------------------------------------------------------------------------- codes

let isoCurrencies: Set<string> | null = null;
export function isIsoCurrency(code: string): boolean {
  isoCurrencies ??= new Set(Intl.supportedValuesOf('currency'));
  return isoCurrencies.has(code);
}

export function normalizeCurrency(v: unknown): Normalized<string> {
  if (isBlank(v)) return none();
  const text = String(v).trim();
  const upper = text.toUpperCase();
  if (isIsoCurrency(upper)) return ok(upper);
  const bySymbol = CURRENCY_SYMBOLS[text] ?? CURRENCY_SYMBOLS[text.toLowerCase()];
  if (bySymbol) return ok(bySymbol);
  return bad('CURRENCY_INVALID', `"${text}" is not an ISO 4217 code`);
}

const AVAILABILITY_VOCABULARY: Record<string, Availability> = {};
for (const [value, words] of Object.entries({
  in_stock: ['in stock', 'instock', 'in_stock', 'available', 'yes', 'y', 'true', '1', 'auf lager', 'verfugbar', 'lieferbar', 'en stock', 'disponible'],
  out_of_stock: ['out of stock', 'outofstock', 'out_of_stock', 'oos', 'no', 'n', 'false', '0', 'sold out', 'soldout', 'unavailable', 'nicht verfugbar', 'ausverkauft', 'rupture'],
  preorder: ['preorder', 'pre-order', 'pre order', 'backorder', 'backordered', 'coming soon', 'vorbestellung'],
  discontinued: ['discontinued', 'eol', 'end of life', 'retired', 'delisted', 'auslaufartikel'],
} satisfies Record<Availability, string[]>)) {
  for (const w of words) AVAILABILITY_VOCABULARY[w] = value as Availability;
}

export function normalizeAvailability(v: unknown): Normalized<Availability> {
  if (isBlank(v)) return none();
  if (typeof v === 'boolean') return ok(v ? 'in_stock' : 'out_of_stock');
  const key = String(v)
    .trim()
    .replace(/^https?:\/\/schema\.org\//i, '') // schema.org/InStock
    .replace(/([a-z])([A-Z])/g, '$1 $2') // InStock -> In Stock
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // verfügbar -> verfugbar
    .toLowerCase()
    .replace(/[_]+/g, ' ')
    .trim();
  const value = AVAILABILITY_VOCABULARY[key] ?? AVAILABILITY_VOCABULARY[key.replace(/\s+/g, '')];
  return value ? ok(value) : bad('AVAILABILITY_UNKNOWN', `"${String(v)}" is not a known availability`);
}

function gtinCheckDigitValid(digits: string): boolean {
  const body = digits.slice(0, -1);
  const check = Number(digits.at(-1));
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    // weights 3,1,3,1... from the right of the body
    const weight = (body.length - i) % 2 === 1 ? 3 : 1;
    sum += Number(body[i]) * weight;
  }
  return (10 - (sum % 10)) % 10 === check;
}

export function normalizeGtin(v: unknown): Normalized<string> {
  if (isBlank(v)) return none();
  const text = typeof v === 'number' ? (Number.isInteger(v) ? v.toFixed(0) : String(v)) : String(v).trim();
  if (/e\+?\d+$/i.test(text)) {
    return bad('GTIN_INVALID', `"${text}" is in scientific notation (digits were lost in a spreadsheet)`);
  }
  let digits = text.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits)) return bad('GTIN_INVALID', `"${text}" contains non-digits`);
  // Spreadsheets drop leading zeros: an 11-digit UPC or 7-digit EAN-8 is usually one zero short.
  if (digits.length === 7 || digits.length === 11) digits = `0${digits}`;
  if (![8, 12, 13, 14].includes(digits.length)) return bad('GTIN_INVALID', `"${text}" has ${digits.length} digits (expected 8, 12, 13 or 14)`);
  if (!gtinCheckDigitValid(digits)) return bad('GTIN_INVALID', `"${text}" fails the check digit`);
  return ok(digits);
}

export function normalizeUrl(v: unknown): Normalized<string> {
  if (isBlank(v)) return none();
  let text = String(v).trim();
  if (/^www\./i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
    return ok(url.toString());
  } catch {
    return bad('URL_INVALID', `"${text}" is not an http(s) URL`);
  }
}

// ---------------------------------------------------------------------------------- dates

function isoFromParts(y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): string | null {
  const date = new Date(Date.UTC(y, m - 1, d, hh, mm, ss));
  // reject 2025-02-30 etc. (Date would silently roll over)
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  if (hh > 23 || mm > 59 || ss > 59) return null;
  return date.toISOString();
}

const TIME = String.raw`(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?`;
const YMD = new RegExp(String.raw`^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})${TIME}$`);
const XYZ = new RegExp(String.raw`^(\d{1,2})([-/.])(\d{1,2})\2(\d{2}|\d{4})${TIME}$`);

/**
 * Dates without an explicit timezone are treated as UTC (documented assumption).
 * Day/month order: unambiguous when one part is > 12, "DD.MM.YYYY" is always day-first
 * (German convention); otherwise we use the partner locale and report it.
 */
export function normalizeDate(v: unknown, locale: PartnerLocale): Normalized<string> {
  if (isBlank(v)) return none();
  if (typeof v === 'number' || (typeof v === 'string' && /^\d{10}(\d{3})?$/.test(v.trim()))) {
    const n = Number(v);
    const ms = n > 1e12 ? n : n * 1000; // epoch ms vs seconds
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? bad('DATE_UNPARSEABLE', `${v} is not a timestamp`) : ok(d.toISOString());
  }
  const text = String(v).trim();

  // Full ISO 8601 with timezone or "Z"
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const d = new Date(text);
    if (!Number.isNaN(d.getTime())) return ok(d.toISOString());
  }

  let m = text.match(YMD);
  if (m) {
    const iso = isoFromParts(+m[1]!, +m[2]!, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
    return iso ? ok(iso) : bad('DATE_UNPARSEABLE', `"${text}" is not a real date`);
  }

  m = text.match(XYZ);
  if (m) {
    const a = +m[1]!;
    const sep = m[2]!;
    const b = +m[3]!;
    let y = +m[4]!;
    if (y < 100) y += 2000;
    let order: 'DMY' | 'MDY';
    const issues: FieldIssue[] = [];
    if (sep === '.') order = 'DMY';
    else if (a > 12) order = 'DMY';
    else if (b > 12) order = 'MDY';
    else if (a === b) order = 'DMY';
    else {
      order = locale.dateOrder;
      issues.push({ code: 'DATE_AMBIGUOUS', message: `"${text}" read as ${order} (partner locale)` });
    }
    const [day, month] = order === 'DMY' ? [a, b] : [b, a];
    const iso = isoFromParts(y, month, day, +(m[5] ?? 0), +(m[6] ?? 0), +(m[7] ?? 0));
    return iso ? ok(iso, issues) : bad('DATE_UNPARSEABLE', `"${text}" is not a real date`);
  }

  return bad('DATE_UNPARSEABLE', `"${text}" is not a recognised date format`);
}

// ---------------------------------------------------------------------------------- dispatch

export function normalizeByType(type: FieldType, v: unknown, locale: PartnerLocale): Normalized<string | number> {
  switch (type) {
    case 'string':
      return normalizeText(v);
    case 'decimal':
      return normalizePrice(v, locale);
    case 'integer':
      return normalizeQuantity(v, locale);
    case 'currency':
      return normalizeCurrency(v);
    case 'availability':
      return normalizeAvailability(v);
    case 'gtin':
      return normalizeGtin(v);
    case 'url':
      return normalizeUrl(v);
    case 'datetime':
      return normalizeDate(v, locale);
  }
}
