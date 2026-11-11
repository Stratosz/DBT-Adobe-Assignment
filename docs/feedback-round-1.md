# Feedback round 1: two weeks into the pilot

## Context

The MVP went to pilot at the customer, Summit & Trail (a fictional mid-size outdoor retailer; see [customer-note.md](customer-note.md)). Two suppliers are live:

- **Nordwind Outdoor:** a weekly CSV from their ERP.
- **Peak Supply:** a nightly JSON catalog plus an hourly NDJSON stock feed.

At the end of week two we held a review with three groups:

- **Mara**, catalog operations lead: daily user of the console.
- **Tobias**, InfoSec: the go-live sign-off.
- **Ilinca**, pricing and finance.

They brought seven requests. This document records what they asked for, what we understood the underlying need to be, what we decided, and how we verified the change. "We" is me as the forward-deployed engineer, with Mara as product owner on the customer side.

| #   | Request (their words)                                                           | From   | Decision                                                       |
| --- | ------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------- |
| 1   | "Before this goes live it needs a security review."                             | Tobias | **Accepted.** Security hardening (below)                       |
| 2   | "Peak's stock numbers went _backwards_ on Tuesday."                             | Mara   | **Accepted.** Stale-record guard                               |
| 3   | "A supplier sent prices 90% too low and it went live."                          | Ilinca | **Accepted, modified.** Price-swing review instead of blocking |
| 4   | "A 3-row price fix was held because of one typo."                               | Mara   | **Accepted.** Minimum-count rule                               |
| 5   | "Peak's full catalog is 200 MB now. Uploads time out, and everyone else waits." | Mara   | **Accepted.** Async processing                                 |
| 6   | "We confirmed a wrong column mapping and can't undo it."                        | Mara   | **Accepted.** Manage saved mappings                            |
| 7   | "Can it just map everything automatically? Confirming is annoying."             | Mara   | **Pushed back.** Counter-proposal below                        |

Also raised in the session and **deferred to round 2**, with a reason for each:

- **SSO with the company's identity provider.** It needs their IdP team. API keys with roles cover the pilot (see #1).
- **Supplier self-service portal.** Real value, but it is a product decision about letting suppliers into the system.
- **XML feeds** from a supplier that is still being onboarded. The adapter layer is ready ([adding-a-format.md](adding-a-format.md)).
- **Email alerts.** The metrics exist; alert routing belongs in their monitoring stack.

---

## 1. Security review (InfoSec)

Tobias reviewed the MVP against the company's checklist for internal tools that handle supplier data. Findings and responses:

| Finding                                                                                                            | Risk                                                  | Change                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No authentication.** Anyone on the network can approve a held run or raise the bad-row limit.                    | Unauthorised catalog changes                          | API keys with three roles: **uploader** (upload, view, download), **reviewer** (also: confirm mappings, approve or reject held runs, override the limit), **admin** (also: manage saved mappings, read metrics). Keys are stored only as SHA-256 hashes and compared in constant time. SSO is the production path (deferred above). |
| **No record of _who_ did what.**                                                                                   | No accountability, fails audit                        | Append-only `audit_events` table: actor, role, action, run, supplier, details. Shown on each run in the UI; `GET /api/audit` for reviewers.                                                                                                                                                                                         |
| **CSV formula injection.** Set-aside rows contain supplier text, and ops open the file in Excel.                   | A cell like `=HYPERLINK("http://…")` executes on open | Cells starting with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'` in exports (OWASP guidance). Covered by tests.                                                                                                                                                                                                              |
| **Prototype pollution.** A column named `__proto__` is assigned onto a plain object.                               | Corrupted records; a classic JS injection vector      | Records are built on null-prototype objects. A test uses a `__proto__` header and a `constructor` key.                                                                                                                                                                                                                              |
| **Resource exhaustion.** No cap on columns per record or value length; the quarantine download is built in memory. | A single crafted file degrades the service            | Caps of 500 fields per record and 10,000 characters per value (oversized records are set aside, not crashed on). Quarantine downloads are streamed in pages. Uploads stream to disk instead of being buffered in memory.                                                                                                            |
| **No rate limiting.**                                                                                              | Abuse or accidental loops                             | Per-key rate limit (stricter on uploads); `429` with a `Retry-After` header.                                                                                                                                                                                                                                                        |
| **Unsanitised filename** in the `Content-Disposition` header.                                                      | Header injection, broken downloads                    | Filenames reduced to a safe character set before use in headers.                                                                                                                                                                                                                                                                    |
| **No security headers.**                                                                                           | Clickjacking, MIME sniffing                           | Helmet: CSP, `X-Content-Type-Options`, `frame-ancestors 'none'`, and more.                                                                                                                                                                                                                                                          |
| **Request bodies not validated** at the boundary.                                                                  | Unexpected input reaches business logic               | JSON schemas on every route, published as OpenAPI at `/docs`.                                                                                                                                                                                                                                                                       |
| **Metrics publicly readable.**                                                                                     | Leaks supplier names and volumes                      | `/metrics` requires an admin key. `/health` stays public with no data in it.                                                                                                                                                                                                                                                        |
| **No dependency scanning.**                                                                                        | Known-vulnerable packages                             | `npm audit --omit=dev --audit-level=high` in CI, plus a Dependabot config.                                                                                                                                                                                                                                                          |

Already fine, confirmed in the review:

- parameterised SQL with whitelisted column names;
- uploads stored under generated names (no path traversal);
- React escaping output;
- `javascript:` URLs rejected;
- generic 500 errors that don't leak internals;
- size limit on uploads;
- duplicate-file guard.

The full threat model is in [SECURITY.md](../SECURITY.md).

## 2. "Stock went backwards" (ops)

**What happened:** Peak's 10:00 stock file reached us after their 11:00 file (their SFTP job retried), and the older numbers overwrote the newer ones.

**Underlying need:** for any one SKU, never replace newer supplier data with older supplier data.

**Change:** before staging a record, compare its `updated_at` with the product already in the catalog. If the incoming record is older, skip it with a `STALE_RECORD` warning and count it as "skipped as older than the catalog". Records without a timestamp are applied, because there is nothing to compare; the supplier config should require timestamps for hourly feeds.

**Why not order runs by arrival time:** arrival order is exactly what went wrong. The supplier's own timestamp is the only reliable clock.

## 3. "Prices 90% too low went live" (finance)

**What happened:** a supplier's export divided prices by 10 (a currency-unit bug). Every value was a valid price, so nothing was set aside, and the file committed.

Ilinca first asked us to _reject_ any price change above 30%. We **modified** that. Sales and clearance legitimately cut prices by 50–70%, so a hard reject would block real business and train people to override it.

**Change:** a price that moves more than the import type's `maxPriceChange` against the current catalog (50% by default) raises `PRICE_SWING`. Any `PRICE_SWING` holds the run for review even when the bad-row rate is fine, and the hold reason lists the swings. A reviewer approves (a sale) or rejects (a bug) with one click and a reason, which goes to the audit log. Nothing is applied before that.

## 4. "One typo held a 3-row file" (ops)

**What happened:** 1 bad row out of 3 is 33%, above the 2% limit for price updates, so the run was held and the other two prices waited for a person.

**Change:** each import type now also has `minQuarantinedToHold`. A run is held for its bad-row rate only when the rate is over the limit **and** at least that many rows were set aside:

- `full_catalog`: 3;
- `price_update`: 2;
- `inventory_update`: 5.

The decision message explains which rule applied.

**Trade-off we discussed:** for price updates even one bad row can matter. That is why the minimum is 2, not 5, and set-aside rows are still reported and downloadable either way.

## 5. "Big files time out and block everyone" (ops)

**What happened:** Peak's full catalog grew to around 200 MB. The MVP processed files inside the upload request: the browser timed out, and because processing is serialised (SQLite has a single writer), every other upload waited.

**Change:**

- **Uploads stream to disk** while being hashed. The API returns `202 Accepted` with the run in status `RECEIVED`.
- **A worker** picks up queued runs from the database, which acts as a durable queue, so a crash does not lose work. Runs are processed one at a time, oldest first, which also keeps each supplier's runs in order.
- **The UI polls** runs that are in progress.
- **Recovery on startup:** runs left in `PROCESSING` by a crash are put back on the queue. Processing is idempotent, because staging is cleared first and nothing reaches the catalog until commit.
- **Graceful shutdown:** on `SIGTERM` the server stops taking requests and lets the current run finish, up to a timeout. Anything unfinished is recovered on the next start.

**Not done (documented):** a separate queue service and multiple workers. The production path (SQS or BullMQ, Postgres, workers scaled by queue depth) is in [ADR 6](adr/0006-async-processing.md).

## 6. "We can't undo a wrong mapping" (ops)

**Change:** each supplier has a mappings view, listing every saved decision with who made it and when. Admins can change a decision or remove it, so the field is suggested again on the next file. Every change is audited.

**Why admin-only:** a saved mapping changes how _every future file_ from that supplier is read. That is configuration, not day-to-day operation.

## 7. "Just map everything automatically" (pushed back)

**What Mara asked:** remove the confirmation step entirely.

**What we heard:** confirming is tedious when the answer is obvious. For example, `VK-Preis` is plainly a price for a German supplier.

**Why not:** the confirmation step is the control that prevents silent data corruption. Without it, a renamed `Sale price` column replaces the list price across the catalog. The cost of asking is one click per renamed column, once per supplier. The cost of guessing wrong is a pricing incident, which is the kind of incident this project exists to prevent (see #3).

**What we offered instead:**

- Saved decisions already make every later file automatic.
- Mapping changes are now editable (#6), so a wrong click is cheap to fix.
- For round 2: a supplier onboarding step where ops pre-approve the supplier's known column names up front, and a "confirm all suggestions" button for files where every suggestion has value evidence.

Mara agreed. The rule "never automatically map a required field from a guess" stays.

---

## How we verified

- Every item has tests. Run `npm test` and see `packages/core/test/round1.test.ts` and `apps/api/test/security.test.ts`.
- New demo fixtures:
  - `fixtures/peak/inventory_late.ndjson`: an older stock file arriving after a newer one;
  - `fixtures/peak/prices_bug.csv`: prices divided by 10;
  - `fixtures/peak/prices_small_fix.csv`: one typo in three rows;
  - `fixtures/peak/catalog_broken.json`: a truncated export.

  The [README demo script](../README.md#demo-script) walks through all of them.
