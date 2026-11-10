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

export function flatten(value: unknown, maxDepth = 6): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  walk(value, '', 0);
  return out;

  function walk(v: unknown, path: string, depth: number): void {
    if (v !== null && typeof v === 'object' && depth < maxDepth) {
      if (Array.isArray(v)) {
        if (v.every((x) => x === null || typeof x !== 'object')) {
          out[path || 'value'] = v.filter((x) => x !== null && x !== '').join(ARRAY_JOINER);
          return;
        }
        v.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
        return;
      }
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length === 0 && path) {
        out[path] = null;
        return;
      }
      for (const [k, child] of entries) walk(child, path ? `${path}.${k}` : k, depth + 1);
      return;
    }
    if (v !== null && typeof v === 'object') {
      out[path] = JSON.stringify(v); // depth cap reached: keep as JSON text
      return;
    }
    out[path || 'value'] = v;
  }
}
