# ADR 1: Fuzzy field mapping with confidence bands

**Status:** accepted

## Context

The most common way supplier feeds drift is that columns get renamed (`Preis` becomes `VK-Preis`), added or removed. We could take one of three approaches:

1. **Strict:** any change blocks the run. This is safe, but every rename stops the pipeline, and people learn to click "accept" without looking.
2. **Aliases only:** known names map; unknown ones are ignored. Renames silently drop data.
3. **Fuzzy matching with a confidence score.**

## Decision

Option 3, with explicit bands and safety rules (`packages/core/src/mapping/mapper.ts`):

| Evidence | Confidence |
|---|---|
| Mapping saved for this supplier (a person decided) | 1.00 |
| Exact canonical name | 1.00 |
| Known alias | 0.97 |
| Known alias at the end of a nested path (`details.brand`) | 0.90 |
| Name similarity (Jaro-Winkler / token overlap) | at most 0.88 |
| Sample values fit the field's type (≥90%) | +0.10 |
| Sample values contradict the type (<50% fit) | −0.25 |
| Values alone identify the field (GTIN check digits, ISO currencies, URLs, availability words) | 0.75–0.80 |

- **Bands:** at 0.90 or above the mapping is applied automatically. Between 0.65 and 0.90 a person confirms it. Below 0.65 the column is not imported (it stays in the raw record and is reported).
- **Safety rules:**
  - A fuzzy name match is capped below the auto band. It can only be applied automatically when the column's values support it.
  - A **required** field is never applied automatically from a fuzzy or value-only match.
  - If two columns compete for the same field and their scores are within 0.05, that is a conflict and goes to a person.
  - Every match carries a human-readable reason, shown in the UI.

Decisions are saved per supplier, including "don't import this column", so the next file with the same columns goes through without questions.

## Consequences

- The first file after a rename needs one confirmation. Later files don't.
- The thresholds are judgment calls, tuned on the fixtures. In production they should be calibrated against confirmed decisions; the stored decisions are exactly that training data.
- An LLM could add suggestions in the 0.65–0.90 band without changing this contract.
