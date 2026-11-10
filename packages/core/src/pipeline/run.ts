import { CANONICAL_FIELDS, NormalizedProductSchema, emptyProduct, type CanonicalFieldName, type NormalizedProduct } from '../schema/canonical.ts';
import { resolvePolicy, type ResolvedPolicy } from '../schema/importTypes.ts';
import { ISSUE_CATALOG, displayValue, severityFor, type Issue, type IssueCode, type RecordLocation } from '../errors.ts';
import { decodeChunks, decodeHead, type DecodeResult } from '../formats/decode.ts';
import { detectFormat, getAdapter } from '../formats/registry.ts';
import { FormatError, type ReadOptions } from '../formats/types.ts';
import { proposeMapping, type FieldProfile, type MappingProposal, type SavedMapping } from '../mapping/mapper.ts';
import { isBlank, normalizeByType, normalizeSku, type PartnerLocale } from '../normalize/index.ts';
import { IssueAggregator, type IssueGroup } from './report.ts';

/** Re-openable byte stream: analysis reads the head, processing reads everything. */
export type ByteSource = () => AsyncIterable<Uint8Array>;

export function bufferSource(buf: Uint8Array, chunkSize = 64 * 1024): ByteSource {
  return async function* () {
    for (let i = 0; i < buf.length; i += chunkSize) yield buf.subarray(i, i + chunkSize);
  };
}

export interface RunInput {
  source: ByteSource;
  filename?: string | null;
  /** Explicit format id; detected when omitted. */
  format?: string | null;
  readOptions?: ReadOptions;
  importType: string;
  policyOverride?: { maxErrorRate?: number | null; reason?: string | null };
  locale: PartnerLocale;
  savedMapping?: SavedMapping;
  /** How many records to sample for field discovery and mapping. */
  sampleSize?: number;
}

export interface FatalError {
  code: IssueCode;
  message: string;
  hint: string;
}

export interface Analysis {
  format: string | null;
  detectionMethod: string | null;
  formatScores: Record<string, number>;
  encoding: DecodeResult['encoding'];
  policy: ResolvedPolicy;
  fields: FieldProfile[];
  proposal: MappingProposal | null;
  fatal: FatalError | null;
}

function fatalFrom(err: unknown): FatalError {
  if (err instanceof FormatError) {
    return { code: err.code, message: err.message, hint: err.detail && err.code !== 'FORMAT_AMBIGUOUS' ? err.detail : ISSUE_CATALOG[err.code].hint({ samples: err.detail ? [err.detail] : [], count: 1 }) };
  }
  throw err;
}

async function readHead(source: ByteSource, max = 16 * 1024): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source()) {
    parts.push(chunk);
    size += chunk.length;
    if (size >= max) break;
  }
  return Buffer.concat(parts).subarray(0, max);
}

/**
 * Phase 1: detect the format, discover fields from a sample, propose a mapping.
 * Cheap (reads only the first `sampleSize` records), so the UI can show the proposal
 * before anything is written.
 */
export async function analyzeFile(input: RunInput): Promise<Analysis> {
  const policy = resolvePolicy(input.importType, input.policyOverride);
  const decode: DecodeResult = { encoding: 'utf-8' };
  const base = { policy, fields: [] as FieldProfile[], proposal: null, encoding: decode.encoding };
  let detection;
  try {
    const head = decodeHead(await readHead(input.source));
    if (!head.trim()) throw new FormatError('FILE_EMPTY', 'The file is empty');
    detection = detectFormat(head, input.filename, input.format);
  } catch (err) {
    return { ...base, format: null, detectionMethod: null, formatScores: {}, fatal: fatalFrom(err) };
  }

  const sampleSize = input.sampleSize ?? 200;
  const fields = new Map<string, unknown[]>();
  try {
    let seen = 0;
    for await (const event of detection.adapter.read(decodeChunks(input.source(), decode), input.readOptions)) {
      if (event.type !== 'record') continue;
      for (const [k, v] of Object.entries(event.record.fields)) {
        const samples = fields.get(k) ?? [];
        if (samples.length < 20 && !isBlank(v)) samples.push(v);
        fields.set(k, samples);
      }
      if (++seen >= sampleSize) break;
    }
  } catch (err) {
    return { ...base, format: detection.adapter.id, detectionMethod: detection.method, formatScores: detection.scores, encoding: decode.encoding, fatal: fatalFrom(err) };
  }
  const profiles = [...fields].map(([name, samples]) => ({ name, samples }));
  return {
    format: detection.adapter.id,
    detectionMethod: detection.method,
    formatScores: detection.scores,
    encoding: decode.encoding,
    policy,
    fields: profiles,
    proposal: proposeMapping(profiles, policy.importType, input.locale, input.savedMapping),
    fatal: null,
  };
}

export interface AcceptedRecord {
  product: NormalizedProduct;
  /** Only the fields this import type writes and the record actually provided. */
  presentFields: CanonicalFieldName[];
  warnings: Issue[];
  location: RecordLocation;
}

export interface QuarantinedRecord {
  raw: unknown;
  issues: Issue[];
  location: RecordLocation;
}

export interface RecordSink {
  accepted(record: AcceptedRecord): void | Promise<void>;
  quarantined(record: QuarantinedRecord): void | Promise<void>;
}

export type RunStatus = 'COMMITTED' | 'HELD_FOR_REVIEW' | 'FAILED';

export interface RunResult {
  status: RunStatus;
  format: string | null;
  encoding: DecodeResult['encoding'];
  counts: { total: number; accepted: number; acceptedWithWarnings: number; quarantined: number; duplicateSkus: number };
  errorRate: number;
  maxErrorRate: number;
  policy: { importType: string; overridden: boolean; overrideReason: string | null };
  mapping: Record<string, CanonicalFieldName>;
  issueGroups: IssueGroup[];
  fatal: FatalError | null;
  durationMs: number;
  recordsPerSecond: number;
  decisionReason: string;
}

/**
 * Phase 2: stream every record through mapping -> normalization -> validation and hand it
 * to the sink as accepted or quarantined. Memory is bounded by the issue aggregator and the
 * SKU set used for duplicate detection.
 */
export async function processRecords(input: RunInput, mapping: Record<string, CanonicalFieldName>, sink: RecordSink, analysis?: Analysis): Promise<RunResult> {
  const started = performance.now();
  const policy = resolvePolicy(input.importType, input.policyOverride);
  const importType = policy.importType;
  const required = new Set<CanonicalFieldName>(importType.requiredFields);
  const writable = new Set<CanonicalFieldName>(importType.writableFields);
  const aggregator = new IssueAggregator();
  const decode: DecodeResult = { encoding: 'utf-8' };
  const counts = { total: 0, accepted: 0, acceptedWithWarnings: 0, quarantined: 0, duplicateSkus: 0 };
  const seenSkus = new Set<string>();
  const knownFields = new Set(analysis?.fields.map((f) => f.name) ?? Object.keys(mapping));
  const lateFields = new Set<string>();

  const finish = (status: RunStatus, decisionReason: string, fatal: FatalError | null = null): RunResult => {
    const durationMs = Math.round(performance.now() - started);
    const errorRate = counts.total ? counts.quarantined / counts.total : 0;
    return {
      status,
      format: analysis?.format ?? input.format ?? null,
      encoding: decode.encoding,
      counts,
      errorRate: Number(errorRate.toFixed(4)),
      maxErrorRate: policy.maxErrorRate,
      policy: { importType: importType.id, overridden: policy.overridden, overrideReason: policy.overrideReason },
      mapping,
      issueGroups: aggregator.result(),
      fatal,
      durationMs,
      recordsPerSecond: durationMs ? Math.round((counts.total / durationMs) * 1000) : counts.total,
      decisionReason,
    };
  };

  if (analysis?.fatal) return finish('FAILED', analysis.fatal.message, analysis.fatal);

  // Run-level notes: unmapped fields and mapped fields this import type ignores.
  for (const m of analysis?.proposal?.matches ?? []) {
    if (!(m.sourceField in mapping) && m.status !== 'ignored') {
      aggregator.add({ code: 'FIELD_UNMAPPED', severity: 'info', sourceField: m.sourceField, message: 'Not mapped' });
    }
  }
  for (const [source, target] of Object.entries(mapping)) {
    if (!writable.has(target)) aggregator.add({ code: 'FIELD_NOT_WRITABLE', severity: 'info', field: target, sourceField: source, message: 'Ignored by import type' });
  }

  const sourceByTarget = new Map<CanonicalFieldName, string>();
  for (const [source, target] of Object.entries(mapping)) if (writable.has(target)) sourceByTarget.set(target, source);
  const locale = input.locale;

  let format = analysis?.format ?? input.format;
  if (!format) {
    const a = await analyzeFile(input);
    if (a.fatal) return finish('FAILED', a.fatal.message, a.fatal);
    format = a.format!;
  }
  try {
    for await (const event of getAdapter(format).read(decodeChunks(input.source(), decode), input.readOptions)) {
      counts.total++;
      if (event.type === 'issue') {
        counts.quarantined++;
        aggregator.add(event.issue);
        await sink.quarantined({ raw: event.raw, issues: [event.issue], location: event.issue.location ?? { index: -1 } });
        continue;
      }
      const { fields, location, raw } = event.record;
      for (const k of Object.keys(fields)) {
        if (!knownFields.has(k) && !lateFields.has(k)) {
          lateFields.add(k);
          aggregator.add({ code: 'FIELD_LATE_APPEARANCE', severity: 'info', sourceField: k, message: 'First seen after sampling', location });
        }
      }

      const issues: Issue[] = [];
      const issue = (code: IssueCode, field: CanonicalFieldName | undefined, message: string, value?: unknown) => {
        const sourceField = field ? sourceByTarget.get(field) : undefined;
        issues.push({
          code,
          severity: severityFor(code, field ? required.has(field) : true),
          message,
          field,
          sourceField,
          value: value === undefined ? undefined : displayValue(value),
          location,
        });
      };

      const skuResult = normalizeSku(fields[sourceByTarget.get('sku') ?? '']);
      const product = emptyProduct(skuResult.value ?? '');
      const present: CanonicalFieldName[] = [];
      let detectedCurrency: string | undefined;

      for (const [target, source] of sourceByTarget) {
        const rawValue = fields[source];
        if (isBlank(rawValue)) {
          if (required.has(target)) issue('REQUIRED_VALUE_MISSING', target, `"${source}" is empty`, rawValue ?? '');
          continue;
        }
        const result = target === 'sku' ? skuResult : normalizeByType(CANONICAL_FIELDS[target].type, rawValue, locale);
        for (const i of result.issues) issue(i.code, target, i.message, rawValue);
        if (result.value !== null) {
          (product as Record<string, unknown>)[target] = result.value;
          present.push(target);
        }
        if (result.detectedCurrency) detectedCurrency = result.detectedCurrency;
      }

      // Derivations
      if (product.price !== null && writable.has('currency') && product.currency === null) {
        product.currency = detectedCurrency ?? locale.defaultCurrency;
        present.push('currency');
        if (!detectedCurrency) issue('CURRENCY_DEFAULTED', 'currency', `Defaulted to ${locale.defaultCurrency}`);
      }
      if (product.availability === null && product.quantity !== null && writable.has('availability')) {
        product.availability = product.quantity > 0 ? 'in_stock' : 'out_of_stock';
        present.push('availability');
      }

      const errors = issues.filter((i) => i.severity === 'error');
      if (!errors.length) {
        const parsed = NormalizedProductSchema.safeParse(product);
        if (!parsed.success) {
          const first = parsed.error.issues[0]!;
          issue('SCHEMA_VIOLATION', undefined, `${first.path.join('.')}: ${first.message}`);
        }
      }

      if (issues.some((i) => i.severity === 'error')) {
        counts.quarantined++;
        issues.forEach((i) => aggregator.add(i));
        await sink.quarantined({ raw, issues, location });
        continue;
      }

      if (seenSkus.has(product.sku)) {
        counts.duplicateSkus++;
        issue('DUPLICATE_SKU', 'sku', `SKU ${product.sku} seen before; this record wins`, product.sku);
      }
      seenSkus.add(product.sku);
      issues.forEach((i) => aggregator.add(i));
      counts.accepted++;
      if (issues.some((i) => i.severity === 'warning')) counts.acceptedWithWarnings++;
      await sink.accepted({ product, presentFields: [...new Set(present)], warnings: issues, location });
    }
  } catch (err) {
    const fatal = fatalFrom(err);
    return finish('FAILED', fatal.message, fatal);
  }

  if (decode.encoding !== 'utf-8') aggregator.add({ code: 'ENCODING_FALLBACK', severity: 'warning', message: 'Decoded as Windows-1252' });
  if (counts.total === 0) {
    return finish('FAILED', 'No records', { code: 'FILE_EMPTY', message: 'The file has no records', hint: ISSUE_CATALOG.FILE_EMPTY.hint() });
  }
  const errorRate = counts.quarantined / counts.total;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  if (errorRate > policy.maxErrorRate) {
    return finish(
      'HELD_FOR_REVIEW',
      `${pct(errorRate)} of records were quarantined, above the ${pct(policy.maxErrorRate)} limit for ${importType.label.toLowerCase()} imports. Nothing was applied; review and approve or reject the run.`,
    );
  }
  return finish('COMMITTED', `${pct(errorRate)} of records were quarantined, within the ${pct(policy.maxErrorRate)} limit.`);
}
