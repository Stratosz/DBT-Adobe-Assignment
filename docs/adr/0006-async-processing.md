# ADR 6: Async processing with the database as the queue

**Status:** accepted (feedback round 1, #5); supersedes the "synchronous processing" half of [ADR 4](0004-sqlite-and-synchronous-processing.md)

## Context

Peak's full catalog reached about 200 MB. In the MVP:

- the file was processed inside the upload request, so browsers timed out;
- the whole upload was buffered in memory;
- because writes are serialized (SQLite has one writer), every other upload waited behind it;
- a crash mid-run left nothing to resume.

## Decision

- **Uploads stream to disk** while being hashed (SHA-256, for the duplicate guard). The API answers `202 Accepted` with the run in status `RECEIVED` and a `Location` header. Clients poll `GET /api/runs/{id}`.
- **The `runs` table is the queue.** A single in-process worker claims the oldest run with `UPDATE … WHERE id = (SELECT … ORDER BY created_at LIMIT 1) RETURNING *`. The claim is atomic, so the same statement still works with several workers on Postgres (with `FOR UPDATE SKIP LOCKED`).
- **Order:** oldest first, which keeps each supplier's files in arrival order. Correctness across out-of-order files comes from the stale-record guard (supplier timestamps), not from queue order.
- **Idempotent processing:** staging and quarantine for the run are cleared before processing, and nothing reaches `products` before commit. A re-run produces the same result.
- **Recovery:**
  - On start, runs left in `PROCESSING` are re-queued (`attempts` + 1).
  - After 3 attempts the run is marked `FAILED` with a clear reason, instead of crash-looping.
  - An exception inside processing marks only that run `FAILED`; the worker carries on.
- **Graceful shutdown:** on `SIGTERM` the server stops accepting requests and waits for the current run, bounded by `SHUTDOWN_TIMEOUT_MS`. Anything unfinished is recovered on next start. The Docker `CMD` uses exec form so the signal reaches Node.

## Alternatives considered

- **A queue service (SQS, BullMQ/Redis) now:** the right step for horizontal scale, but it adds infrastructure the customer would have to run during a pilot. The database-backed queue gives the same API contract (202 + polling) and survives restarts.
- **Worker threads in the same process:** they don't help while the database has a single writer.

## Production path

1. Keep raw files in object storage; the upload handler writes there.
2. Publish `run.received` to a queue (SQS); workers scale on queue depth (`feed_queue_depth` is already exported).
3. Use Postgres: `SKIP LOCKED` claims, `COPY` into staging, a set-based upsert for promotion.
4. Allow at most one in-flight run per supplier, so ordering holds without global serialization.
5. Push the result instead of polling (webhook or SSE) for the UI and for supplier notifications.
