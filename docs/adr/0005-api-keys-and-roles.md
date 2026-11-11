# ADR 5: API keys with three roles for the pilot

**Status:** accepted (feedback round 1, InfoSec finding #1)

## Context

The MVP had no authentication. InfoSec required, before go-live:

- that only named people can change the catalog;
- that the dangerous actions (approving a held file, raising the bad-row limit, changing how a supplier's files are read) are limited to a smaller group;
- that every such action is attributable to a person.

The company's SSO team could not schedule an integration inside the pilot.

## Options

| Option                              | For                                                                                                                    | Against                                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **OIDC with the company IdP**       | The right end state: central offboarding, MFA, groups.                                                                 | Needs the IdP team; weeks, not days.                                                                                     |
| **Username/password with sessions** | Familiar                                                                                                               | A new credential store to secure, CSRF to handle, and password policy to own. All of it gets thrown away when SSO lands. |
| **API keys with roles**             | Small, testable, works for the UI, scripts and the supplier SFTP bridge. The roles carry over unchanged to SSO groups. | Long-lived bearer secrets; manual rotation.                                                                              |

## Decision

API keys, one per person, with three roles:

| Role     | Can                                                                                                             |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| uploader | upload, view runs, download set-aside rows                                                                      |
| reviewer | + confirm mappings, approve or reject held runs, override the bad-row limit (with a reason), read the audit log |
| admin    | + change or forget saved supplier mappings, read `/metrics`                                                     |

- **Storage:** keys are kept only as SHA-256 hashes (`config/*.json`, mounted from the secret store) and compared in constant time.
- **Transport:** the UI keeps the key in `sessionStorage` and sends it as `Authorization: Bearer`. There are no cookies, so CSRF does not apply.
- **Four eyes:** the uploader of a held file cannot approve it. Admins can, and that is the documented escalation path.
- **Demo keys:** the demo key file is refused in production mode unless `ALLOW_DEMO_KEYS=true` is set deliberately.

## Consequences

- **Moving to SSO** replaces `resolveActor()`, which turns a request into `{ id, name, role }`. Nothing else changes: role checks, the audit log and the UI all work on the actor.
- **Rotation is manual:** edit the key file and restart. Acceptable for a pilot with three to five users.
- **Plain SHA-256 is enough here** (no bcrypt or argon2): keys are random, high-entropy secrets, not human passwords, so slow hashing adds nothing.
