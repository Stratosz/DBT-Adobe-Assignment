# ADR 2: Row quarantine plus a per-file error threshold

**Status:** accepted

## Context

Bad data comes in two shapes:

- **A few bad rows in a good file**, such as one price typed as "auf Anfrage". The other rows should not wait for it.
- **A broken file**, such as an export bug that empties the price column. Applying even the "good" rows of such a file is risky, because the file as a whole cannot be trusted.

## Decision

- Every row is classified as accepted, accepted with warnings, or set aside (quarantined):
  - An invalid value in a field the **import type requires** sets the row aside.
  - An invalid value in an optional field drops that field (`null`) and adds a warning. For example, a bad UPC should not block a price.
  - Values that were ambiguous but resolved (a date read using the locale, a defaulted currency) are always warnings.
- Each file is held when the share of set-aside rows exceeds the import type's limit:
  - `full_catalog`: 5%
  - `price_update`: 2% (wrong prices cost money)
  - `inventory_update`: 10% (stale stock corrects itself with the next hourly feed)
- **A held run applies nothing.** Accepted rows sit in `staged_products` until a person approves (a reason is required) or rejects the run.
- **The limit can be overridden per upload**, within 0–50%, and only with a reason. The reason is stored with the run's policy and shown in the UI.

## Consequences

- One rule covers both kinds of failure, and it is explainable in one sentence ("65% of rows were bad, above the 5% limit").
- Small files are sensitive: 1 bad row in 20 is 5%. A minimum-count rule ("hold only if more than 5% _and_ more than N rows") is a reasonable next step.
- Approval is a human bottleneck, so `feed_runs_waiting` is exported for alerting.
