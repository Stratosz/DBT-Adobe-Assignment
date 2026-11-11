import { Readable, pipeline } from 'node:stream';
import parserStream from 'stream-json';
import { pick } from 'stream-json/filters/pick.js';
import { streamArray } from 'stream-json/streamers/stream-array.js';
import { displayValue } from '../errors.ts';
import { lines } from './decode.ts';
import { flatten } from './flatten.ts';
import { FormatError, type AdapterEvent, type FormatAdapter, type ReadOptions } from './types.ts';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Find where the records live without loading the document:
 *  - root array                      -> ""            ([{...}, {...}])
 *  - first key holding objects       -> "products"    ({"meta": {...}, "products": [{...}]})
 *  - nested                          -> "data.items"  ({"data": {"items": [{...}]}})
 * Only looks at the head of the file; configure `recordPath` per partner when this guesses wrong.
 */
export function detectRecordPath(head: string): string | null {
  const trimmed = head.trimStart();
  if (trimmed.startsWith('[')) return '';
  if (!trimmed.startsWith('{')) return null;
  // Walk keys with a tiny tokenizer, tracking object nesting, until "key": [ {
  const path: string[] = [];
  let i = trimmed.indexOf('{') + 1;
  let lastKey: string | null = null;
  let emptyArrayFallback: string | null = null;
  while (i < trimmed.length) {
    const ch = trimmed[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < trimmed.length && trimmed[j] !== '"') j += trimmed[j] === '\\' ? 2 : 1;
      const str = trimmed.slice(i + 1, j);
      const after = trimmed.slice(j + 1).match(/^\s*:/);
      if (after) {
        lastKey = str;
        i = j + 1 + after[0].length;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (ch === '{' && lastKey !== null) {
      path.push(lastKey);
      lastKey = null;
    } else if (ch === '}') {
      path.pop();
    } else if (ch === '[') {
      if (lastKey !== null && /^\[\s*\{/.test(trimmed.slice(i))) return [...path, lastKey].join('.');
      if (lastKey !== null && emptyArrayFallback === null && /^\[\s*\]/.test(trimmed.slice(i))) {
        emptyArrayFallback = [...path, lastKey].join('.');
      }
      // skip over arrays of scalars / nested arrays we don't care about
      let depth = 1;
      i++;
      while (i < trimmed.length && depth > 0) {
        if (trimmed[i] === '[') depth++;
        else if (trimmed[i] === ']') depth--;
        else if (trimmed[i] === '"') {
          i++;
          while (i < trimmed.length && trimmed[i] !== '"') i += trimmed[i] === '\\' ? 2 : 1;
        }
        i++;
      }
      lastKey = null;
      continue;
    }
    if (ch === ',') lastKey = null;
    i++;
  }
  return emptyArrayFallback;
}

function firstLine(head: string): string {
  const nl = head.indexOf('\n');
  return (nl === -1 ? head : head.slice(0, nl)).trim();
}

function parsesAsObject(text: string): boolean {
  try {
    return isPlainObject(JSON.parse(text));
  } catch {
    return false;
  }
}

/** A JSON document whose records live in an array (root or nested). Streamed, never loaded whole. */
export const jsonAdapter: FormatAdapter = {
  id: 'json',
  label: 'JSON document',
  extensions: ['json'],

  sniff(head) {
    const t = head.trimStart();
    if (t.startsWith('[')) return 0.95;
    if (!t.startsWith('{')) return 0.0;
    // A first line that is a complete object, followed by more lines, smells like NDJSON.
    const nl = t.indexOf('\n');
    const rest = nl === -1 ? '' : t.slice(nl + 1).trimStart();
    if (parsesAsObject(firstLine(t)) && rest.startsWith('{')) return 0.3;
    return 0.9;
  },

  async *read(text: AsyncIterable<string>, options: ReadOptions = {}): AsyncIterable<AdapterEvent> {
    const iterator = text[Symbol.asyncIterator]();
    let head = '';
    const buffered: string[] = [];
    while (head.length < 64 * 1024) {
      const next = await iterator.next();
      if (next.done) break;
      head += next.value;
      buffered.push(next.value);
    }
    if (!head.trim()) throw new FormatError('FILE_EMPTY', 'The file is empty');

    const recordPath = options.recordPath ?? detectRecordPath(head);
    if (recordPath === null) {
      throw new FormatError(
        'FILE_UNPARSEABLE',
        'Could not find an array of records in the JSON document',
        'Set the record path (e.g. "data.products") on the partner profile.',
      );
    }
    async function* replay() {
      yield* buffered;
      for (let n = await iterator.next(); !n.done; n = await iterator.next()) yield n.value;
    }

    // stream.pipeline (not .pipe) so a parse error anywhere surfaces on the iterator below.
    const stages = [
      Readable.from(replay()),
      parserStream(),
      ...(recordPath ? [pick.asStream({ filter: recordPath, once: true })] : []),
      streamArray.asStream(),
    ];
    const items = (pipeline as unknown as (...s: unknown[]) => NodeJS.ReadableStream)(...stages, () => {});

    const pointerBase = recordPath ? `/${recordPath.replaceAll('.', '/')}` : '';
    let count = 0;
    try {
      for await (const { key, value } of items as AsyncIterable<{ key: number; value: unknown }>) {
        const location = { index: key, pointer: `${pointerBase}/${key}` };
        count++;
        if (!isPlainObject(value)) {
          yield {
            type: 'issue',
            raw: value,
            issue: {
              code: 'RECORD_UNPARSEABLE',
              severity: 'error',
              message: `Expected an object, got ${Array.isArray(value) ? 'array' : typeof value}`,
              value: displayValue(value),
              location,
            },
          };
          continue;
        }
        yield { type: 'record', record: { fields: flatten(value), raw: value, location } };
      }
    } catch (err) {
      // A truncated or corrupt document is fatal: we cannot know what is missing, and
      // half-applying a full catalog is worse than not applying it.
      throw new FormatError(
        'FILE_UNPARSEABLE',
        count ? `JSON is malformed after ${count} records: ${(err as Error).message}` : `JSON is malformed: ${(err as Error).message}`,
        'The export may have been cut off. Ask the partner to resend the complete file.',
      );
    }
    if (count === 0) throw new FormatError('FILE_EMPTY', `No records found at "${recordPath || '(root)'}"`);
  },
};

/** Newline-delimited JSON: one object per line. A bad line only quarantines that line. */
export const ndjsonAdapter: FormatAdapter = {
  id: 'ndjson',
  label: 'NDJSON / JSON Lines',
  extensions: ['ndjson', 'jsonl'],

  sniff(head) {
    const t = head.trimStart();
    if (!t.startsWith('{')) return 0;
    if (!parsesAsObject(firstLine(t))) return 0.05;
    const nl = t.indexOf('\n');
    const rest = nl === -1 ? '' : t.slice(nl + 1).trimStart();
    return rest.startsWith('{') ? 0.95 : 0.5;
  },

  async *read(text: AsyncIterable<string>): AsyncIterable<AdapterEvent> {
    let index = 0;
    for await (const { line, lineNo, tooLong } of lines(text)) {
      if (!tooLong && !line.trim()) continue;
      const location = { index, line: lineNo };
      index++;
      if (tooLong) {
        yield {
          type: 'issue',
          raw: null,
          issue: { code: 'RECORD_TOO_LARGE', severity: 'error', message: `Line ${lineNo} is longer than 1 MB`, location },
        };
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (err) {
        yield {
          type: 'issue',
          raw: line,
          issue: {
            code: 'RECORD_UNPARSEABLE',
            severity: 'error',
            message: `Line ${lineNo} is not valid JSON: ${(err as Error).message}`,
            value: displayValue(line),
            location,
          },
        };
        continue;
      }
      if (!isPlainObject(value)) {
        yield {
          type: 'issue',
          raw: value,
          issue: {
            code: 'RECORD_UNPARSEABLE',
            severity: 'error',
            message: `Line ${lineNo} is not a JSON object`,
            value: displayValue(line),
            location,
          },
        };
        continue;
      }
      yield { type: 'record', record: { fields: flatten(value), raw: value, location } };
    }
    if (index === 0) throw new FormatError('FILE_EMPTY', 'The file has no records');
  },
};
