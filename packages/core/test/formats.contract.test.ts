import { describe, expect, it } from 'vitest';
import { listAdapters } from '../src/formats/registry.ts';
import { FormatError } from '../src/formats/types.ts';
import { collect } from './helpers.ts';

/**
 * Contract every format adapter must satisfy. A new adapter only needs to add its samples
 * here; if this suite passes, the rest of the pipeline works with it unchanged.
 */
interface ContractSamples {
  /** three records with sku A1, B2, C3 and a price field */
  valid: string;
  /** same, but the second record is malformed at the format level */
  oneMalformed: string;
  empty: string;
}

const SAMPLES: Record<string, ContractSamples> = {
  csv: {
    valid: 'sku,price\nA1,1.50\nB2,2.50\nC3,3.50\n',
    oneMalformed: 'sku,price\nA1,1.50\nB2,2.50,EXTRA,COLUMNS\nC3,3.50\n',
    empty: '',
  },
  json: {
    valid: '{"meta":{"v":1},"products":[{"sku":"A1","price":1.5},{"sku":"B2","price":2.5},{"sku":"C3","price":3.5}]}',
    oneMalformed: '{"products":[{"sku":"A1","price":1.5},"not-an-object",{"sku":"C3","price":3.5}]}',
    empty: '{"products":[]}',
  },
  ndjson: {
    valid: '{"sku":"A1","price":1.5}\n{"sku":"B2","price":2.5}\n{"sku":"C3","price":3.5}\n',
    oneMalformed: '{"sku":"A1","price":1.5}\n{"sku":"B2","price":\n{"sku":"C3","price":3.5}\n',
    empty: '\n\n',
  },
};

describe.each(listAdapters().map((a) => [a.id, a] as const))('format adapter contract: %s', (id, adapter) => {
  const samples = SAMPLES[id];

  it('has contract samples (add them when registering a new format)', () => {
    expect(samples).toBeDefined();
  });
  if (!samples) return;

  it('yields one flat record per source record, in order', async () => {
    const events = await collect(adapter, samples.valid);
    const records = events.flatMap((e) => (e.type === 'record' ? [e.record] : []));
    expect(records.map((r) => String(r.fields.sku))).toEqual(['A1', 'B2', 'C3']);
    expect(records.every((r) => typeof r.fields.price !== 'object')).toBe(true);
  });

  it('gives every record a location and keeps the raw record', async () => {
    const events = await collect(adapter, samples.valid);
    for (const e of events) {
      if (e.type !== 'record') continue;
      expect(e.record.location.index).toBeGreaterThanOrEqual(0);
      expect(e.record.location.line ?? e.record.location.pointer).toBeDefined();
      expect(e.record.raw).toBeTruthy();
    }
  });

  it('reports a malformed record as a record-level issue and keeps going', async () => {
    const events = await collect(adapter, samples.oneMalformed);
    const issues = events.filter((e) => e.type === 'issue');
    const records = events.filter((e) => e.type === 'record');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.type === 'issue' && issues[0]!.issue.code).toBe('RECORD_UNPARSEABLE');
    expect(records).toHaveLength(2);
  });

  it('fails the file with FILE_EMPTY when there are no records', async () => {
    await expect(collect(adapter, samples.empty)).rejects.toMatchObject({ code: 'FILE_EMPTY' });
    await expect(collect(adapter, samples.empty)).rejects.toBeInstanceOf(FormatError);
  });

  it('recognises its own valid sample when sniffing', () => {
    const best = listAdapters()
      .map((a) => [a.id, a.sniff(samples.valid)] as const)
      .sort((a, b) => b[1] - a[1])[0]!;
    expect(best[0]).toBe(id);
  });
});
