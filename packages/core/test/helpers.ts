import type { AdapterEvent, FormatAdapter, ReadOptions } from '../src/formats/types.ts';

/** Feed text in small chunks so tests exercise chunk boundaries, like a real stream. */
export async function* chunked(text: string, size = 7): AsyncIterable<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

export async function collect(adapter: FormatAdapter, text: string, options?: ReadOptions, chunkSize = 7): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of adapter.read(chunked(text, chunkSize), options)) out.push(e);
  return out;
}

export async function* bytes(buf: Uint8Array, size = 5): AsyncIterable<Uint8Array> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}
