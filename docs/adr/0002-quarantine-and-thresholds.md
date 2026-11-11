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
- Small files are sensitive: 1 bad row in 20 is 5%. This was addressed in round 1 (below).
- Approval is a human bottleneck, so `feed_runs_waiting` is exported for alerting.

## Amendments (feedback round 1)

- **Minimum count** ([#4](../feedback-round-1.md#4-one-typo-held-a-3-row-file-ops)): a run is held for its bad-row rate only when the rate is over the limit **and** at least `minQuarantinedToHold` rows were set aside:
  - `full_catalog`: 3;
  - `price_update`: 2;
  - `inventory_update`: 5.

  Below that, the run commits and the decision message says why it was not held.

- **Review holds** ([#3](../feedback-round-1.md#3-prices-90-too-low-went-live-finance)): a second reason to hold, independent of the bad-row rate. A valid price that moves more than `maxPriceChange` (50%; off for inventory updates) against the live catalog raises `PRICE_SWING`. Any `PRICE_SWING` holds the run, and the result lists every reason in `holdReasons`.
- **Stale records** ([#2](../feedback-round-1.md#2-stock-went-backwards-ops)) are a third outcome besides accepted and set aside. Records older than the catalog are skipped (`STALE_RECORD`) and don't count as bad rows.
- **Who decides:** approving or rejecting a held run needs the reviewer role. The person who uploaded the file cannot approve it (four-eyes rule; admins can, as the escalation path). Overriding the limit on upload also needs the reviewer role.
