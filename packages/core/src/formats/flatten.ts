/**
 * Flatten a nested JSON object into dot paths so it looks like a row of columns:
 *
 *   { pricing: { amount: 9.5 }, tags: ["a", "b"], images: [{ url: "x" }] }
 *   -> { "pricing.amount": 9.5, "tags": "a|b", "images[0].url": "x" }
 *
 * The fuzzy mapper then treats "pricing.amount" like any other column name. Arrays of
 * scalars are joined with "|" (a common convention in product feeds); arrays of objects keep
 * index paths. Depth is capped so a pathological document cannot blow up the field count.
 */
export const ARRAY_JOINER = '|';

export const MAX_FIELDS_PER_RECORD = 500;
export const MAX_VALUE_LENGTH = 10_000;

/** A record object without a prototype, so keys like "__proto__" or "constructor" are just data. */
export function emptyRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

export function flatten(value: unknown, maxDepth = 6, maxFields = MAX_FIELDS_PER_RECORD + 1): Record<string, unknown> {
  const out = emptyRecord();
  let count = 0;
  walk(value, '', 0);
  return out;

  function walk(v: unknown, path: string, depth: number): void {
    if (count >= maxFields) return; // caller sees maxFields keys and rejects the record
    if (v !== null && typeof v === 'object' && depth < maxDepth) {
      if (Array.isArray(v)) {
        if (v.every((x) => x === null || typeof x !== 'object')) {
          count++;
          out[path || 'value'] = v.filter((x) => x !== null && x !== '').join(ARRAY_JOINER);
          return;
        }
        v.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
        return;
      }
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length === 0 && path) {
        count++;
        out[path] = null;
        return;
      }
      for (const [k, child] of entries) walk(child, path ? `${path}.${k}` : k, depth + 1);
      return;
    }
    count++;
    if (v !== null && typeof v === 'object') {
      out[path] = JSON.stringify(v); // depth cap reached: keep as JSON text
      return;
    }
    out[path || 'value'] = v;
  }
}
