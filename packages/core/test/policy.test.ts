import { describe, expect, it } from 'vitest';
import { IMPORT_TYPES, PolicyError, resolvePolicy } from '../src/schema/importTypes.ts';
import { severityFor } from '../src/errors.ts';

describe('resolvePolicy', () => {
  it('uses the import type default threshold when there is no override', () => {
    const p = resolvePolicy('price_update');
    expect(p.maxErrorRate).toBe(IMPORT_TYPES.price_update.maxErrorRate);
    expect(p.overridden).toBe(false);
  });

  it('accepts a bounded override with a reason and records it', () => {
    const p = resolvePolicy('full_catalog', { maxErrorRate: 0.3, reason: 'partner migration week' });
    expect(p).toMatchObject({ maxErrorRate: 0.3, overridden: true, overrideReason: 'partner migration week' });
  });

  it.each([-0.1, 0.51, Number.NaN])('rejects out-of-bounds override %s', (v) => {
    expect(() => resolvePolicy('full_catalog', { maxErrorRate: v, reason: 'x' })).toThrow(PolicyError);
  });

  it('rejects an override without a reason', () => {
    expect(() => resolvePolicy('full_catalog', { maxErrorRate: 0.2, reason: '  ' })).toThrow(/reason/);
  });

  it('rejects unknown import types with the list of valid ones', () => {
    expect(() => resolvePolicy('everything')).toThrow(/full_catalog, price_update, inventory_update/);
  });
});

describe('severityFor', () => {
  it('escalates invalid values only for required fields', () => {
    expect(severityFor('PRICE_UNPARSEABLE', true)).toBe('error');
    expect(severityFor('PRICE_UNPARSEABLE', false)).toBe('warning');
  });
  it('never escalates resolved judgement calls', () => {
    expect(severityFor('DATE_AMBIGUOUS', true)).toBe('warning');
  });
});
