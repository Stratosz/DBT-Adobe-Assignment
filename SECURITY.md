# Security and threat model

This covers the system as delivered after [feedback round 1](docs/feedback-round-1.md): an internal tool, reached over the corporate network, used by catalog operations to ingest supplier files into the live product catalog.

## What we protect

| Asset                                              | Why it matters                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **The live catalog** (prices, stock, product data) | Wrong prices cost money; wrong stock loses sales. This is the asset the whole design protects.            |
| **Supplier files and set-aside rows**              | Commercially sensitive: cost and price lists, assortments. Low personal-data content (product data only). |
| **Saved supplier mappings**                        | Silently change how every future file is read.                                                            |
| **API keys**                                       | Grant the ability to change the catalog.                                                                  |
| **Audit log**                                      | Accountability; must not be editable through the app.                                                     |

## Actors and trust boundaries

```
 Supplier (untrusted) --file--> Ops user (trusted, authenticated) --HTTPS--> API --> SQLite / uploads
                                                                     |
                                       Prometheus (admin key) <------+
```

- **Supplier file contents are untrusted input**, even though a trusted employee uploads them. Every value may be hostile: formulas, `__proto__` keys, megabyte-long cells, broken encodings, truncated documents.
- **Authenticated users are trusted with their role, not more.** Uploaders cannot approve; reviewers cannot change saved mappings; nobody approves their own held upload (admins excepted, as the escalation path).
- **The network is not trusted for confidentiality.** TLS terminates at the company's load balancer (HSTS is set). The service itself listens on plain HTTP behind it.

## Threats and controls (STRIDE)

| Threat                     | Example                                                     | Control                                                                                                                                                                      | Where                             |
| -------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Spoofing**               | Someone on the network calls the API                        | API keys, hashed at rest, constant-time compare. Every `/api` route requires a role.                                                                                         | `apps/api/src/auth.ts`            |
|                            | Demo keys left on in production                             | The server refuses to start with the demo key file when `NODE_ENV=production` unless explicitly allowed.                                                                     | `server.ts`                       |
| **Tampering**              | A crafted file overwrites good data                         | Validation and normalization; per-file bad-row limit; price-swing review; staleness check by supplier timestamp, repeated at commit; staging before commit.                  | core pipeline, `db.promote`       |
|                            | SQL injection through column names or values                | Parameterized statements; column names come only from whitelists.                                                                                                            | `db.ts`                           |
|                            | Prototype pollution via `__proto__` / `constructor` keys    | Null-prototype records; own-property checks.                                                                                                                                 | `formats/flatten.ts`, `mapper.ts` |
|                            | Request body smuggling extra fields                         | JSON schemas with `additionalProperties: false`; enums for field names.                                                                                                      | `app.ts`                          |
| **Repudiation**            | "I didn't approve that"                                     | Append-only audit log (who, role, action, run, details); reasons required for approvals and overrides.                                                                       | `audit_events`                    |
| **Information disclosure** | Credentials in logs                                         | `authorization` and `cookie` headers redacted from logs.                                                                                                                     | `server.ts`                       |
|                            | Internal errors leak stack traces                           | Generic 500 with a request id; details only in server logs.                                                                                                                  | `app.ts` error handler            |
|                            | Metrics reveal supplier names and volumes                   | `/metrics` requires the admin role; `/health` returns no data.                                                                                                               | `app.ts`                          |
|                            | Path traversal to read server files                         | Uploads stored under generated names; route params validated by pattern; `@fastify/static` upgraded past its path-traversal advisory.                                        | `runService.ts`, deps             |
| **Denial of service**      | Huge upload, huge record, deeply nested JSON                | Upload limit (250 MB, streamed to disk); 500 fields and 10,000 characters per value; 1 MB per CSV record or NDJSON line; flattening depth cap; streaming parsers throughout. | core, multipart limits            |
|                            | Request flooding                                            | Per-key rate limiting, stricter on uploads.                                                                                                                                  | `@fastify/rate-limit`             |
|                            | One big file blocks everyone                                | Async processing: uploads return immediately and a worker processes them.                                                                                                    | `runService.ts`                   |
| **Elevation of privilege** | Uploader approves their own bad file                        | Role checks on every mutating route; four-eyes rule on approvals.                                                                                                            | `auth.ts`, `runService.approve`   |
| **Client-side attacks**    | XSS from supplier text shown in the UI                      | React escapes output; strict CSP (`script-src 'self'`, no inline scripts); `frame-ancestors 'none'`.                                                                         | `@fastify/helmet`                 |
|                            | Formula injection when ops open the set-aside rows in Excel | Cells starting with `= + - @` (or tab/CR) are prefixed with `'`.                                                                                                             | `pipeline/quarantine.ts`          |
|                            | Header injection through filenames                          | Filenames reduced to `[A-Za-z0-9._-]` in `Content-Disposition`.                                                                                                              | `safeFilename`                    |
| **Supply chain**           | Vulnerable dependency                                       | `npm audit --omit=dev --audit-level=high` gates CI; Dependabot for npm, Actions and the base image. Round 1's first audit found and fixed 2 high and 5 moderate advisories.  | CI                                |

## Operational security

- **Container:** runs as the non-root `node` user, with a read-only root filesystem (compose) and a single writable `/data` volume. It also sets `no-new-privileges`.
- **Configuration** is validated at startup and fails fast on bad values.
- **Secrets:** the key file is mounted from the platform's secret store (`API_KEYS_FILE`). Keys are never stored in plaintext.

## Accepted risks and next steps

| Item                                                                           | Status                                                                                                                                                                   |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **API keys instead of SSO.** Keys are long-lived and shared per person.        | Accepted for the pilot. Next: OIDC with the company IdP, IdP groups mapped to the same three roles, short-lived sessions ([ADR 5](docs/adr/0005-api-keys-and-roles.md)). |
| **No encryption at rest** of uploads and the database in this deployment.      | Relies on the volume encryption of the hosting platform.                                                                                                                 |
| **No retention policy.** Raw uploads and set-aside rows are kept indefinitely. | Next: delete raw files after N days (configurable), keep run metadata and the audit log.                                                                                 |
| **No malware scanning** of uploads.                                            | Files are parsed as text and never executed or served back as-is, so the risk is low. Add scanning if supplier portals ever upload directly.                             |
| **The audit log is append-only by convention**, not tamper-proof.              | Next: ship audit events to the central log store (write-once).                                                                                                           |
| **Dev-only advisory:** moderate ReDoS in `minimatch` via `typescript-eslint`.  | Not shipped in the image. Waiting for an upstream release; Dependabot will raise it.                                                                                     |

## Reporting

Report suspected vulnerabilities to the integration team privately rather than in a public issue.
