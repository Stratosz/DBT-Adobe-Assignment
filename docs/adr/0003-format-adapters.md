# ADR 3: Pluggable format adapters with a shared contract

**Status:** accepted

## Context

Feeds arrive as CSV today and as JSON/NDJSON from newer suppliers. XML and Excel are likely next. Format handling should not leak into the mapping, normalization or validation code.

## Decision

- Each format is a `FormatAdapter` (`packages/core/src/formats/types.ts`) with:
  - `sniff(head)`: a score from 0 to 1 for how likely the head of the file is this format;
  - `read(text)`: an async stream of flat `RawRecord { fields, location, raw }`, or record-level issues.
- Adapters are registered in one place (`registry.ts`). Detection order:
  1. the format chosen explicitly on upload;
  2. the file extension, if the content agrees;
  3. the highest sniff score.

  If two formats score almost the same, detection refuses to guess.

- Nested data is flattened to dot paths, so the mapper treats `pricing.amount` like a column name. Arrays of scalars are joined with `|`; arrays of objects keep index paths.
- All formats are streamed: `csv-parse`, `stream-json`, and line splitting for NDJSON.
- A file-level failure (empty, truncated JSON) throws a `FormatError` and fails the run. A record-level failure (one bad CSV row or NDJSON line) becomes a quarantined record.
- `formats.contract.test.ts` runs the same behavioural tests against every registered adapter.

## Consequences

- Adding a format is local work: see [adding-a-format.md](../adding-a-format.md).
- Normalizers must accept `unknown`, because JSON gives numbers and booleans while CSV gives strings. The test "CSV and JSON normalize identically" guards this.
- Flattening is lossy for complex arrays (variants, multiple images). Supporting those needs a richer target model, not just a different adapter.

## Amendments (feedback round 1)

- **Size limits** apply to every adapter's output, enforced by the pipeline, so a new adapter gets them for free:
  - 500 fields per record and 10,000 characters per value (`RECORD_TOO_LARGE`, record set aside);
  - CSV records over 1 MB and NDJSON lines over 1 MB are set aside without buffering the rest of the file.
- **Records are null-prototype objects** (`emptyRecord()` in `flatten.ts`), so a column or key named `__proto__` or `constructor` is plain data. Adapters that build records by hand must use `emptyRecord()`.
- **Dependencies:** `stream-json` was upgraded from 1.x to 3.x (ESM API: `pick.asStream()`, `streamArray.asStream()`) and `csv-parse` from 5 to 7, both after `npm audit` findings.
