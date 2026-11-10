import type { Issue, IssueCode, RecordLocation } from '../errors.ts';

/**
 * A record as produced by a format adapter: flat field name -> value, plus where it came
 * from and the original record (kept verbatim for the quarantine file).
 *
 * Everything downstream of the adapter (mapping, normalization, validation, policy) works
 * on RawRecords only and never knows which format the data came from.
 */
export interface RawRecord {
  fields: Record<string, unknown>;
  location: RecordLocation;
  raw: unknown;
}

export type AdapterEvent =
  | { type: 'record'; record: RawRecord }
  /** Record-level problem (e.g. one malformed CSV row / NDJSON line). The run continues. */
  | { type: 'issue'; issue: Issue; raw: unknown };

export interface ReadOptions {
  /** CSV: force a delimiter instead of sniffing. */
  delimiter?: string | undefined;
  /** JSON: dot path to the array of records, e.g. "data.products". Auto-detected when omitted. */
  recordPath?: string | undefined;
}

export interface FormatAdapter {
  id: string;
  label: string;
  /** Lower-case file extensions without the dot. */
  extensions: string[];
  /** Confidence 0..1 that `head` (first few KB of decoded text) is this format. */
  sniff(head: string): number;
  /** Stream records out of decoded text chunks. Throw FormatError for file-level failures. */
  read(text: AsyncIterable<string>, options?: ReadOptions): AsyncIterable<AdapterEvent>;
}

/** A failure that makes the whole file unusable. The run is marked FAILED with this code. */
export class FormatError extends Error {
  constructor(
    readonly code: IssueCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}
