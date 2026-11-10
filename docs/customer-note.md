# Customer note: who this is for and what it is worth

## The customer I assumed

**A mid-size outdoor and sports retailer** that sells online. It has about 40 suppliers and a catalog of roughly 50k SKUs, running on a commerce platform (think Adobe Commerce, with product data also feeding a customer data platform for personalisation).

Suppliers send product data in whatever their own systems produce:

- **Older European suppliers** email or upload a weekly Excel-generated CSV. Separators are `;`, prices use decimal commas, the encoding is Windows-1252, and the column names are in German. These files change whenever the supplier upgrades its ERP or someone "tidies up" the export.
- **Newer suppliers** expose a JSON API (nightly catalog) and an NDJSON stock feed (hourly). The structure is nested, dates are US-style, and fields are added without notice.

Today two people in catalog operations open every file and fix it in Excel before it is imported. When they miss something, the damage reaches customers: prices of 0, products marked out of stock, names with broken umlauts. The retailer has also had at least one incident where a truncated export wiped stock levels for an entire brand.

## The problem in their words

- "We find out a supplier changed their file when customers complain."
- "Every new supplier is a mini-project for IT."
- "We can't tell suppliers exactly what's wrong, so the same mistakes come back every week."

## What this solution changes

| Today | With feed intake |
|---|---|
| Ops fix every file by hand | Clean files import without anyone touching them. People only see what needs a decision. |
| A renamed column breaks the import or maps wrongly | The tool suggests the match with a reason. Someone confirms it once, and it is remembered for that supplier. |
| A broken export partially overwrites the catalog | The file is held when too many rows are bad. Nothing is applied until someone approves. |
| "The file has errors," sent back to the supplier | The supplier gets back their own rows, each with the column, the bad value and how to fix it. |
| New supplier format = IT project | One supplier config entry, plus at most one format adapter. Mapping is learned from the first file. |
| No visibility | A run history, plus metrics on held and failed runs, data quality per supplier, and schema drift. |

## Value, in the terms the customer would measure

- **Ops time:** from hand-fixing every file to only handling exceptions. At 40 suppliers × 15–30 minutes per file per week, that is most of one person's week back.
- **Catalog incidents avoided:** the threshold-and-hold rule targets exactly the failure that caused the wiped-stock incident.
- **Faster supplier onboarding:** days instead of a sprint. The first file shows what maps and what doesn't.
- **Better data from suppliers over time:** precise, row-level feedback is the only kind suppliers actually act on.

## What I would validate with the customer first

1. Which import types they really run, and their real tolerance for bad rows in each. My thresholds are placeholders.
2. Whether a full catalog should ever deactivate products that are missing from the file. I assumed never.
3. Who approves held runs, and how fast it has to happen. That decides whether alerting needs to page someone.
4. Whether suppliers could get self-service access to their own results. That is the biggest lever on data quality.
