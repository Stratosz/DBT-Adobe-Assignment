/**
 * Decode a byte stream to text.
 *
 * Partner ERPs still emit Windows-1252 (Excel "CSV" on Windows). We decode strictly as
 * UTF-8 and, if a chunk is not valid UTF-8, switch to Windows-1252 for the rest of the file
 * and report it. A UTF-8 BOM is stripped by TextDecoder.
 */
export interface DecodeResult {
  encoding: 'utf-8' | 'windows-1252';
}

export async function* decodeChunks(
  bytes: AsyncIterable<Uint8Array>,
  result: DecodeResult = { encoding: 'utf-8' },
): AsyncIterable<string> {
  let utf8: InstanceType<typeof TextDecoder> | null = new TextDecoder('utf-8', { fatal: true });
  const latin = new TextDecoder('windows-1252');
  for await (const chunk of bytes) {
    if (utf8) {
      try {
        const text = utf8.decode(chunk, { stream: true });
        if (text) yield text;
        continue;
      } catch {
        utf8 = null;
        result.encoding = 'windows-1252';
      }
    }
    const text = latin.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const tail = utf8 ? utf8.decode() : latin.decode();
  if (tail) yield tail;
}

/** Decode a whole buffer (used for sniffing the head of a file). */
export function decodeHead(bytes: Uint8Array, max = 16 * 1024): string {
  const head = bytes.subarray(0, max);
  try {
    // stream:true so a multi-byte char cut at the boundary is not treated as invalid
    return new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
  } catch {
    return new TextDecoder('windows-1252').decode(head);
  }
}

/** Split a text stream into lines (handles \n and \r\n), tracking 1-based line numbers. */
export async function* lines(
  text: AsyncIterable<string>,
  maxLineLength = 1_000_000,
): AsyncIterable<{ line: string; lineNo: number; tooLong?: boolean }> {
  let buffer = '';
  let scanFrom = 0; // only scan new text for newlines (keeps this linear)
  let lineNo = 0;
  let dropping = false; // inside an over-long line: discard until the next newline
  for await (const chunk of text) {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n', scanFrom)) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      scanFrom = 0;
      lineNo++;
      if (dropping) {
        dropping = false;
        yield { line: '', lineNo, tooLong: true };
        continue;
      }
      yield { line: raw.endsWith('\r') ? raw.slice(0, -1) : raw, lineNo };
    }
    scanFrom = buffer.length;
    if (buffer.length > maxLineLength) {
      dropping = true;
      buffer = '';
      scanFrom = 0;
    }
  }
  if (dropping) {
    lineNo++;
    yield { line: '', lineNo, tooLong: true };
    return;
  }
  if (buffer.length) {
    lineNo++;
    yield { line: buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer, lineNo };
  }
}
