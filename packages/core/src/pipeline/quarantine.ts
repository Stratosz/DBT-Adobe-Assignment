import { flatten } from '../formats/flatten.ts';
import type { QuarantinedRecord } from './run.ts';

/**
 * Quarantine exports a partner can act on: the original record, untouched, plus why it was
 * rejected. They fix those rows and send them again; nothing else needs to be re-sent.
 */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function quarantineToCsv(records: QuarantinedRecord[]): string {
  const rows = records.map((r) => {
    const raw = r.raw !== null && typeof r.raw === 'object' ? flatten(r.raw) : { _raw: r.raw };
    return {
      _source_location: r.location.line !== undefined ? `line ${r.location.line}` : (r.location.pointer ?? ''),
      _error_codes: [...new Set(r.issues.map((i) => i.code))].join('|'),
      _error_messages: r.issues.map((i) => `${i.sourceField ? `${i.sourceField}: ` : ''}${i.message}`).join(' | '),
      ...raw,
    };
  });
  const columns: string[] = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!columns.includes(k)) columns.push(k);
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell((row as Record<string, unknown>)[c])).join(','));
  // BOM so Excel opens UTF-8 correctly (partners will open this in Excel)
  return `\uFEFF${lines.join('\n')}\n`;
}

export function quarantineToJson(records: QuarantinedRecord[]): string {
  return JSON.stringify(
    records.map((r) => ({
      _errors: r.issues.map((i) => ({ code: i.code, field: i.sourceField ?? i.field ?? null, message: i.message })),
      _source_location: r.location,
      record: r.raw,
    })),
    null,
    2,
  );
}
