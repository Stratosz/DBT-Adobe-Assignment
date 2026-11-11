import { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import type { CsvError } from 'csv-parse';
import { displayValue } from '../errors.ts';
import { emptyRecord } from './flatten.ts';
import { FormatError, type AdapterEvent, type FormatAdapter, type ReadOptions } from './types.ts';

const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'] as const;

/** Count delimiter occurrences outside double quotes. */
function countOutsideQuotes(line: string, delimiter: string): number {
  let inQuotes = false;
  let n = 0;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === delimiter) n++;
  }
  return n;
}

/**
 * Pick the delimiter that splits the first lines into the same, non-zero number of columns.
 * European Excel exports use ";" because "," is the decimal separator, so we cannot assume ",".
 */
export function sniffDelimiter(head: string): { delimiter: string; confidence: number } {
  const sample = head.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, 20);
  // Drop the last line: it may be cut off mid-record by the head boundary.
  if (sample.length > 2) sample.pop();
  let best = { delimiter: ',', confidence: 0 };
  for (const d of CANDIDATE_DELIMITERS) {
    const counts = sample.map((l) => countOutsideQuotes(l, d));
    const first = counts[0] ?? 0;
    if (first === 0) continue;
    const consistent = counts.filter((c) => c === first).length / counts.length;
    // more columns + more consistency = more likely
    const confidence = consistent * Math.min(1, 0.6 + first * 0.05);
    if (confidence > best.confidence) best = { delimiter: d, confidence };
  }
  return best;
}

function uniqueHeaders(header: string[]): string[] {
  const seen = new Map<string, number>();
  return header.map((h, i) => {
    const base = h.trim() || `column_${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
}

export const csvAdapter: FormatAdapter = {
  id: 'csv',
  label: 'CSV / delimited text',
  extensions: ['csv', 'tsv', 'txt'],

  sniff(head) {
    const trimmed = head.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('<')) return 0.05;
    return sniffDelimiter(head).confidence * 0.85;
  },

  async *read(text: AsyncIterable<string>, options: ReadOptions = {}): AsyncIterable<AdapterEvent> {
    // We need the head to sniff the delimiter, then replay it in front of the rest.
    const iterator = text[Symbol.asyncIterator]();
    let head = '';
    const buffered: string[] = [];
    while (head.length < 16 * 1024) {
      const next = await iterator.next();
      if (next.done) break;
      head += next.value;
      buffered.push(next.value);
    }
    if (!head.trim()) throw new FormatError('FILE_EMPTY', 'The file is empty');

    const delimiter = options.delimiter ?? sniffDelimiter(head).delimiter;
    async function* replay() {
      yield* buffered;
      for (let n = await iterator.next(); !n.done; n = await iterator.next()) yield n.value;
    }

    const parser = Readable.from(replay()).pipe(
      parse({
        delimiter,
        bom: true,
        relax_quotes: true,
        skip_empty_lines: true,
        skip_records_with_error: true,
        info: true,
        // A single record over 1 MB means a broken file (e.g. an unclosed quote); fail it, don't buffer forever.
        max_record_size: 1_000_000,
      }),
    );

    const skipped: AdapterEvent[] = [];
    parser.on('skip', (err: CsvError & { record?: unknown; lines?: number; raw?: string }) => {
      skipped.push({
        type: 'issue',
        raw: err.raw ?? err.record ?? null,
        issue: {
          code: 'RECORD_UNPARSEABLE',
          severity: 'error',
          message: err.message,
          value: err.raw ? displayValue(err.raw) : undefined,
          location: { index: -1, line: err.lines },
        },
      });
    });

    let header: string[] | null = null;
    let index = 0;
    try {
      for await (const { record, info } of parser as AsyncIterable<{ record: string[]; info: { lines: number } }>) {
        while (skipped.length) yield skipped.shift()!;
        if (!header) {
          header = uniqueHeaders(record);
          continue;
        }
        // Excel loves trailing ",,,," rows; they carry no data.
        if (record.every((v) => v.trim() === '')) continue;
        const fields = emptyRecord();
        header.forEach((h, i) => (fields[h] = record[i] ?? ''));
        yield { type: 'record', record: { fields, raw: fields, location: { index, line: info.lines } } };
        index++;
      }
    } catch (err) {
      throw new FormatError('FILE_UNPARSEABLE', `CSV could not be parsed: ${(err as Error).message}`);
    }
    while (skipped.length) yield skipped.shift()!;
    if (!header) throw new FormatError('FILE_EMPTY', 'The file has no header row');
  },
};
