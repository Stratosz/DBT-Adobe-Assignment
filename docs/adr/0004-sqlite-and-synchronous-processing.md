# ADR 4: SQLite and synchronous processing for the demo

**Status:** accepted for the take-home; to be replaced for production

## Context

Reviewers should be able to run the project with `npm install && npm run dev`, with no Docker and no database server. The take-home is time-boxed.

## Decision

- Use Node's built-in `node:sqlite`, with WAL mode. It has no native module, so it installs the same way on macOS, Linux and CI.
- Process each file inside the upload request. Mutating operations are serialized by a promise queue in `RunService`, because SQLite has a single writer and the pipeline awaits between records.
- The schema is plain relational and maps directly onto Postgres: `runs`, `staged_products`, `quarantine`, `products`, `partners`, `partner_mappings`.

## Consequences

- One file is processed at a time. Throughput was measured at about 26k records/s end to end (100k rows in 3.8 s), which is fine for files up to the 50 MB limit.
- Large uploads hold the HTTP request open. The production path:
  1. store the upload in object storage and return `202` with the run id (the status model already supports polling);
  2. let a queue with workers process runs, with a per-partner concurrency of 1 so ordering is kept;
  3. move to Postgres with `COPY` into staging and a set-based `INSERT … ON CONFLICT` for promotion.
- `node:sqlite` is marked experimental in Node 22. Its warning is suppressed in `quiet-warnings.ts`.
