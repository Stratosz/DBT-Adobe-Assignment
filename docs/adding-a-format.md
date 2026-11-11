# Adding a source format

Everything after the adapter (mapping, normalization, validation, policy, reports, UI) is format-agnostic. A new format touches three places.

## 1. Write the adapter

Create `packages/core/src/formats/<format>.ts` exporting a `FormatAdapter`:

```ts
export const xmlAdapter: FormatAdapter = {
  id: 'xml',
  label: 'XML',
  extensions: ['xml'],
  sniff(head) {
    return head.trimStart().startsWith('<') ? 0.9 : 0;
  },
  async *read(text, options) {
    // Stream with a SAX parser (e.g. "saxes"), collecting each element at options.recordPath
    // (e.g. "catalog.product") into a plain object, then:
    //   yield { type: 'record', record: { fields: flatten(obj), raw: obj, location: { index, line } } };
    // For a broken element:
    //   yield { type: 'issue', raw, issue: { code: 'RECORD_UNPARSEABLE', severity: 'error', message, location } };
    // For a broken document:
    //   throw new FormatError('FILE_UNPARSEABLE', '...', 'what the partner should do');
    // If no records are found:
    //   throw new FormatError('FILE_EMPTY', '...');
  },
};
```

Build each record's `fields` with `emptyRecord()` (or `flatten()`, which uses it), never `{}`. That keeps keys like `__proto__` from touching object prototypes. Size limits (500 fields, 10,000 characters per value) are enforced by the pipeline, so you don't need to repeat them. A streaming parser should still avoid buffering unbounded input for a single record.

Rules the contract tests enforce:

- Yield **flat** `fields`. Use `flatten()` for nested data.
- Every record has a `location`, with `line` or `pointer`, so people can find it in the source.
- Keep `raw` as the original record. It is what goes back to the supplier in the quarantine file.
- One bad record must not stop the stream, unless the format makes it impossible to continue safely.
- An empty file throws `FormatError('FILE_EMPTY')`.

## 2. Register it

In `packages/core/src/formats/registry.ts`:

```ts
registerAdapter(xmlAdapter);
```

The UI's format dropdown and `/api/meta` pick it up automatically.

## 3. Add contract samples

In `packages/core/test/formats.contract.test.ts`, add `valid`, `oneMalformed` and `empty` samples for the new id. The suite fails until you do, on purpose.

Then add fixtures for any format-specific quirks (for example XML attributes vs elements) to `formats.test.ts`.
