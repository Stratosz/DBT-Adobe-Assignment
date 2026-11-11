import type { CanonicalFieldName } from './schema/canonical.ts';

/**
 * Error taxonomy.
 *
 * Every problem the pipeline finds becomes an Issue with a stable `code`. Codes are what
 * the report groups by, what metrics are labelled with, and what a partner can be told to
 * fix. Each code carries a human hint that says *what to do*, not just what went wrong.
 *
 * kind:
 *  - fatal:    the whole file cannot be processed (run FAILED)
 *  - invalid:  a value is wrong. If the field is required by the import type the record is
 *              quarantined; otherwise the field is dropped (null) and the record loads with a warning.
 *  - resolved: we had to make a judgement call (e.g. ambiguous date) and did; always a warning.
 *  - review:   the value is valid but suspicious against the live catalog (e.g. a 90% price drop);
 *              the record is kept but the run is held until a person approves it.
 *  - info:     worth knowing, nothing to fix (e.g. extra unmapped columns).
 */
export type Severity = 'error' | 'warning' | 'info';
export type IssueKind = 'fatal' | 'invalid' | 'resolved' | 'review' | 'info';

export interface RecordLocation {
  /** 0-based record index in the file (after the header for CSV). */
  index: number;
  /** 1-based physical line in the source file, when meaningful (CSV, NDJSON). */
  line?: number;
  /** JSON pointer into the source document, e.g. /products/41 */
  pointer?: string;
}

export interface HintContext {
  field?: CanonicalFieldName | undefined;
  sourceField?: string | undefined;
  samples: string[];
  count: number;
}

interface IssueDefinition {
  kind: IssueKind;
  title: string;
  hint: (ctx: HintContext) => string;
}

const f = (ctx: HintContext) => (ctx.sourceField ? `"${ctx.sourceField}"` : 'the column');
const list = (ctx: HintContext) => ctx.samples.map((v) => `"${v}"`).join(', ');
const s = (ctx: HintContext) => (ctx.samples.length ? ` Examples: ${ctx.samples.map((v) => `"${v}"`).join(', ')}.` : '');

export const ISSUE_CATALOG = {
  // ---- file level -------------------------------------------------------------------
  FILE_EMPTY: {
    kind: 'fatal',
    title: 'File contains no records',
    hint: () => 'The upload has no data rows. Check that the partner export finished before the file was sent.',
  },
  FILE_UNPARSEABLE: {
    kind: 'fatal',
    title: 'File could not be parsed',
    hint: (c) => `The file is not valid for the selected format.${s(c)} Re-export the file, or choose the correct format on upload.`,
  },
  FORMAT_UNDETECTED: {
    kind: 'fatal',
    title: 'File format could not be detected',
    hint: () => 'Choose the format explicitly on upload (csv, json, ndjson).',
  },
  FORMAT_AMBIGUOUS: {
    kind: 'fatal',
    title: 'File format is ambiguous',
    hint: (c) => `The content matches several formats (${c.samples.join(', ')}). Choose the format explicitly on upload.`,
  },
  ENCODING_FALLBACK: {
    kind: 'resolved',
    title: 'File is not valid UTF-8; decoded as Windows-1252',
    hint: () => 'Accented characters were recovered using Windows-1252. Ask the partner to export as UTF-8 to avoid garbled names.',
  },
  REQUIRED_FIELD_UNMAPPED: {
    kind: 'fatal',
    title: 'A required field has no source column',
    hint: (c) => `No column could be mapped to "${c.field}". Map it manually in the mapping step, or ask the partner to include it.`,
  },
  FIELD_LATE_APPEARANCE: {
    kind: 'info',
    title: 'Field appeared after the sampled records',
    hint: (c) => `${f(c)} was not in the first records used for mapping, so it was not mapped. If it matters, add it to this partner's mapping.`,
  },
  FIELD_UNMAPPED: {
    kind: 'info',
    title: 'Source field not mapped to the product model',
    hint: (c) => `${f(c)} is kept in the raw record but not imported. Map it if it carries product data.`,
  },
  FIELD_NOT_WRITABLE: {
    kind: 'info',
    title: 'Field is ignored by this import type',
    hint: (c) => `"${c.field}" is mapped but this import type does not update it. Use a full catalog import to change it.`,
  },
  // ---- record level -----------------------------------------------------------------
  RECORD_UNPARSEABLE: {
    kind: 'invalid',
    title: 'Record could not be parsed',
    hint: (c) => `The record is malformed (bad quoting, broken JSON line, wrong number of columns).${s(c)}`,
  },
  REQUIRED_VALUE_MISSING: {
    kind: 'invalid',
    title: 'Required value is empty',
    hint: (c) => `${f(c)} is empty but "${c.field}" is required for this import type. Fill it in or remove the row from the export.`,
  },
  RECORD_TOO_LARGE: {
    kind: 'invalid',
    title: 'Record exceeds the size limits',
    hint: () =>
      'The record has too many fields or a value that is far too long (limits: 500 fields, 10,000 characters per value). This is usually a broken export or a wrong delimiter.',
  },
  STALE_RECORD: {
    kind: 'resolved',
    title: 'Record is older than the product in the catalog; skipped',
    hint: () =>
      'The catalog already has newer data for these SKUs (by the supplier timestamp), so this older data was not applied. Expected when feeds arrive out of order; nothing to fix unless the supplier clock is wrong.',
  },
  PRICE_SWING: {
    kind: 'review',
    title: 'Price changed more than the allowed swing against the catalog',
    hint: (c) =>
      `These prices moved more than the allowed percentage compared with the current catalog.${s(c)} If it is a sale or a repricing, approve the run; if it looks like a unit or currency bug, reject it and ask the supplier for a corrected file.`,
  },
  SCHEMA_VIOLATION: {
    kind: 'invalid',
    title: 'Normalized record failed the final schema check',
    hint: () => 'This indicates a gap in normalization rather than a partner problem. Report it to the integration team with the run id.',
  },
  DUPLICATE_SKU: {
    kind: 'resolved',
    title: 'SKU appears more than once in the file; last occurrence wins',
    hint: (c) =>
      `The same SKU appears in several records.${s(c)} The last one was kept. Check whether the export joins a table that multiplies rows (e.g. variants or warehouses).`,
  },
  // ---- field level ------------------------------------------------------------------
  PRICE_UNPARSEABLE: {
    kind: 'invalid',
    title: 'Price is not a number',
    hint: (c) => `${f(c)} contains values that are not prices.${s(c)} Expected e.g. 19.99 or 19,99.`,
  },
  PRICE_NEGATIVE: {
    kind: 'invalid',
    title: 'Price is negative',
    hint: (c) => `${f(c)} has negative prices.${s(c)} Discounts should not be exported as product prices.`,
  },
  PRICE_LOCALE_AMBIGUOUS: {
    kind: 'resolved',
    title: 'Decimal separator was ambiguous; resolved using the partner locale',
    hint: (c) =>
      `Values like ${list(c)} could mean either thousands or decimals. They were read using the partner's configured locale. Confirm the locale on the partner profile.`,
  },
  CURRENCY_INVALID: {
    kind: 'invalid',
    title: 'Currency is not a known ISO 4217 code',
    hint: (c) => `${f(c)} has unrecognised currencies.${s(c)} Use 3-letter ISO codes (EUR, USD, GBP).`,
  },
  CURRENCY_DEFAULTED: {
    kind: 'resolved',
    title: 'No currency in record; partner default used',
    hint: () =>
      "The record has a price but no currency. The partner's default currency was applied. Add a currency column if the partner sells in more than one.",
  },
  QUANTITY_INVALID: {
    kind: 'invalid',
    title: 'Quantity is not a whole number',
    hint: (c) => `${f(c)} contains non-integer stock values.${s(c)}`,
  },
  QUANTITY_NEGATIVE: {
    kind: 'invalid',
    title: 'Quantity is negative',
    hint: (c) => `${f(c)} has negative stock.${s(c)} Backorders should be exported as 0 with availability "preorder".`,
  },
  AVAILABILITY_UNKNOWN: {
    kind: 'invalid',
    title: 'Availability value not recognised',
    hint: (c) =>
      `${f(c)} has values we cannot map to in_stock / out_of_stock / preorder / discontinued.${s(c)} Add them to the availability vocabulary if they are legitimate.`,
  },
  GTIN_INVALID: {
    kind: 'invalid',
    title: 'GTIN/EAN has the wrong length or check digit',
    hint: (c) => `${f(c)} has invalid barcodes.${s(c)} Spreadsheet tools often drop leading zeros or turn barcodes into 1.23E+12; export the column as text.`,
  },
  URL_INVALID: {
    kind: 'invalid',
    title: 'URL is not a valid http(s) URL',
    hint: (c) => `${f(c)} has malformed URLs.${s(c)}`,
  },
  DATE_UNPARSEABLE: {
    kind: 'invalid',
    title: 'Date could not be parsed',
    hint: (c) => `${f(c)} has dates in an unknown format.${s(c)} ISO 8601 (2025-03-14T10:00:00Z) is preferred.`,
  },
  DATE_AMBIGUOUS: {
    kind: 'resolved',
    title: 'Day/month order was ambiguous; resolved using the partner locale',
    hint: (c) => `Dates like ${list(c)} could be day-first or month-first. The partner's locale was used.`,
  },
  TEXT_TRUNCATED: {
    kind: 'resolved',
    title: 'Text value was too long and was truncated',
    hint: (c) => `${f(c)} has values over the maximum length.`,
  },
} satisfies Record<string, IssueDefinition>;

export type IssueCode = keyof typeof ISSUE_CATALOG;

export interface Issue {
  code: IssueCode;
  severity: Severity;
  message: string;
  field?: CanonicalFieldName | undefined;
  sourceField?: string | undefined;
  value?: string | undefined;
  location?: RecordLocation | undefined;
}

export function issueKind(code: IssueCode): IssueKind {
  return ISSUE_CATALOG[code].kind;
}

/**
 * Severity depends on context: an invalid value in a field the import type requires
 * quarantines the record; the same value in an optional field only drops that field.
 */
export function severityFor(code: IssueCode, fieldIsRequired: boolean): Severity {
  switch (ISSUE_CATALOG[code].kind) {
    case 'fatal':
      return 'error';
    case 'invalid':
      return fieldIsRequired ? 'error' : 'warning';
    case 'resolved':
    case 'review':
      return 'warning';
    case 'info':
      return 'info';
  }
}

export function displayValue(value: unknown, max = 60): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
