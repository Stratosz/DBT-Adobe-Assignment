import { csvAdapter } from './csv.ts';
import { jsonAdapter, ndjsonAdapter } from './json.ts';
import { FormatError, type FormatAdapter } from './types.ts';

/**
 * The only place formats are wired in. Adding a format = write an adapter that satisfies
 * FormatAdapter, add it here, and run the shared contract tests (test/formats.contract.test.ts).
 */
const adapters = new Map<string, FormatAdapter>();

export function registerAdapter(adapter: FormatAdapter): void {
  if (adapters.has(adapter.id)) throw new Error(`Format "${adapter.id}" is already registered`);
  adapters.set(adapter.id, adapter);
}

export function getAdapter(id: string): FormatAdapter {
  const adapter = adapters.get(id);
  if (!adapter) {
    throw new FormatError(
      'FORMAT_UNDETECTED',
      `Unknown format "${id}". Supported: ${listAdapters()
        .map((a) => a.id)
        .join(', ')}`,
    );
  }
  return adapter;
}

export function listAdapters(): FormatAdapter[] {
  return [...adapters.values()];
}

registerAdapter(csvAdapter);
registerAdapter(jsonAdapter);
registerAdapter(ndjsonAdapter);

export interface Detection {
  adapter: FormatAdapter;
  method: 'explicit' | 'extension' | 'content';
  scores: Record<string, number>;
}

const EXTENSION_MIN_SCORE = 0.3;
const EXTENSION_OVERRIDE_MARGIN = 0.5;
const AMBIGUITY_MARGIN = 0.1;
const CONFIDENT_SCORE = 0.8;

/**
 * Detection order: explicit choice > file extension (if the content agrees) > best content sniff.
 * If two formats sniff almost equally and neither is confident, we refuse to guess.
 */
export function detectFormat(head: string, filename?: string | null, explicit?: string | null): Detection {
  const scores = Object.fromEntries(listAdapters().map((a) => [a.id, Number(a.sniff(head).toFixed(3))]));
  if (explicit) return { adapter: getAdapter(explicit), method: 'explicit', scores };

  const ext = filename?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext) {
    const byExt = listAdapters().find((a) => a.extensions.includes(ext));
    const extScore = scores[byExt?.id ?? ''] ?? 0;
    const bestScore = Math.max(...Object.values(scores));
    // Trust the extension unless the content clearly says otherwise (NDJSON saved as ".json"
    // is common): another format must beat it by a wide margin to override it.
    if (byExt && extScore >= EXTENSION_MIN_SCORE && bestScore - extScore < EXTENSION_OVERRIDE_MARGIN) {
      return { adapter: byExt, method: 'extension', scores };
    }
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [first, second] = ranked;
  if (!first || first[1] < EXTENSION_MIN_SCORE) {
    throw new FormatError('FORMAT_UNDETECTED', 'Could not recognise the file format');
  }
  if (second && first[1] < CONFIDENT_SCORE && first[1] - second[1] < AMBIGUITY_MARGIN) {
    throw new FormatError('FORMAT_AMBIGUOUS', `Content matches both ${first[0]} and ${second[0]}`, `${first[0]}, ${second[0]}`);
  }
  return { adapter: getAdapter(first[0]), method: 'content', scores };
}
