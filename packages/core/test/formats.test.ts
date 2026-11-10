import { describe, expect, it } from 'vitest';
import { csvAdapter, sniffDelimiter } from '../src/formats/csv.ts';
import { decodeChunks } from '../src/formats/decode.ts';
import { flatten } from '../src/formats/flatten.ts';
import { detectRecordPath, jsonAdapter } from '../src/formats/json.ts';
import { detectFormat } from '../src/formats/registry.ts';
import { bytes, collect } from './helpers.ts';

describe('csv', () => {
  it.each([
    ['sku,name,price\nA,x,1\nB,y,2\n', ','],
    ['sku;name;price\nA;x;1,50\nB;y;2,50\n', ';'],
    ['sku\tname\tprice\nA\tx\t1\n', '\t'],
    ['sku|name|price\nA|x|1\n', '|'],
  ])('sniffs the delimiter of %j', (text, delimiter) => {
    expect(sniffDelimiter(text).delimiter).toBe(delimiter);
  });

  it('does not split on delimiters inside quotes', async () => {
    const events = await collect(csvAdapter, 'sku,name\nA,"Shirt, blue"\n');
    expect(events[0]).toMatchObject({ type: 'record', record: { fields: { sku: 'A', name: 'Shirt, blue' } } });
  });

  it('de-duplicates and fills blank headers', async () => {
    const events = await collect(csvAdapter, 'sku,price,price,\nA,1,2,x\n');
    expect(events[0]).toMatchObject({ record: { fields: { sku: 'A', price: '1', price_2: '2', column_4: 'x' } } });
  });

  it('skips Excel trailing empty rows', async () => {
    const events = await collect(csvAdapter, 'sku,price\nA,1\n,\n,\n');
    expect(events).toHaveLength(1);
  });

  it('reports source line numbers', async () => {
    const events = await collect(csvAdapter, 'sku,price\nA,1\n\nB,2\n');
    expect(events.map((e) => e.type === 'record' && e.record.location.line)).toEqual([2, 4]);
  });
});

describe('json', () => {
  it.each([
    ['[{"sku":1}]', ''],
    ['{"products":[{"sku":1}]}', 'products'],
    ['{"meta":{"tags":["a","b"],"count":2},"data":{"items":[{"sku":1}]}}', 'data.items'],
    ['{"warnings":[],"items":[{"sku":1}]}', 'items'],
    ['{"a":"b"}', null],
  ])('detects the record path in %s', (head, expected) => {
    expect(detectRecordPath(head)).toBe(expected);
  });

  it('streams records from a nested path with JSON pointers', async () => {
    const events = await collect(jsonAdapter, '{"data":{"items":[{"sku":"A"},{"sku":"B"}]}}');
    expect(events.map((e) => e.type === 'record' && e.record.location.pointer)).toEqual(['/data/items/0', '/data/items/1']);
  });

  it('fails the whole file when the document is truncated', async () => {
    await expect(collect(jsonAdapter, '[{"sku":"A"},{"sku":"B"},{"sk')).rejects.toMatchObject({ code: 'FILE_UNPARSEABLE' });
  });
});

describe('flatten', () => {
  it('turns nested objects into dot paths and scalar arrays into joined values', () => {
    expect(flatten({ sku: 'A', pricing: { amount: 9.5, currency: 'EUR' }, tags: ['x', 'y'], images: [{ url: 'u' }] })).toEqual({
      sku: 'A',
      'pricing.amount': 9.5,
      'pricing.currency': 'EUR',
      tags: 'x|y',
      'images[0].url': 'u',
    });
  });
});

describe('detectFormat', () => {
  it('prefers an explicit format', () => {
    expect(detectFormat('sku,price\n', 'x.json', 'csv').adapter.id).toBe('csv');
  });
  it('uses the extension when the content agrees', () => {
    expect(detectFormat('{"sku":1}\n{"sku":2}\n', 'feed.jsonl').adapter.id).toBe('ndjson');
  });
  it('ignores a lying extension and sniffs the content', () => {
    const d = detectFormat('[{"sku":1}]', 'export.csv');
    expect([d.adapter.id, d.method]).toEqual(['json', 'content']);
  });
  it('sniffs NDJSON vs JSON', () => {
    expect(detectFormat('{"sku":1}\n{"sku":2}\n').adapter.id).toBe('ndjson');
    expect(detectFormat('{\n  "products": [\n {"sku":1}]}').adapter.id).toBe('json');
  });
  it('refuses to guess on unrecognisable content', () => {
    expect(() => detectFormat('<<<binary>>>')).toThrow(/recognise/);
  });
});

describe('decodeChunks', () => {
  async function decode(buf: Uint8Array) {
    const result = { encoding: 'utf-8' as 'utf-8' | 'windows-1252' };
    let text = '';
    for await (const t of decodeChunks(bytes(buf, 3), result)) text += t;
    return { text, encoding: result.encoding };
  }

  it('decodes UTF-8 split across chunk boundaries and strips the BOM', async () => {
    const buf = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Müller ☕')]);
    expect(await decode(buf)).toEqual({ text: 'Müller ☕', encoding: 'utf-8' });
  });

  it('falls back to Windows-1252 for legacy exports', async () => {
    const buf = new Uint8Array([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]); // "Müller" in cp1252
    expect(await decode(buf)).toEqual({ text: 'Müller', encoding: 'windows-1252' });
  });
});
