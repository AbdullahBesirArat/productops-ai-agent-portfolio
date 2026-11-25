# Security model

Scope: local prototype, synthetic data. Tests support the listed mitigations under test conditions only; this is an engineering threat review, not a certification. F1 is reduced; F2 is unresolved.

## Controls

- **Authentication.** A fixed loopback login proxy forwards the validated login to a distinct auth process. Scrypt verification and EdDSA signing happen there. The business API verifies issuer, audience, allowed algorithm, key ID and expiry, then resolves live membership and role. [JWT](../../src/auth/jwt.ts) · [Signing](../../src/auth/signing.ts)
- **Tenant and tool scope.** Protected routes derive tenant and actor from validated claims. The gateway rechecks current authorization and uses read-only tenant transactions, strict arguments, budgets and redacted audit. [Guard](../../src/auth/guard.ts) · [Gateway](../../src/tools/gateway.ts)
- **Disclosure and review.** Unverified ownership keeps order details internal; stock evidence stays internal. Revisions and events record internal decisions with version and four-eyes checks. The UI keeps its access token in memory. Nothing is ever sent. [Disclosure](../../src/support/disclosure.ts) · [Review store](../../src/support/review-store.ts) · [UI](../../ui/app.js)

## Threats, mitigations and residual risk

| Threat | Mitigation | Test evidence | Residual risk |
|---|---|---|---|
| Forged or expired JWT | EdDSA pinning, key ID, issuer/audience, expiry checks | [auth-jwt](../../test/auth-jwt.test.ts) | A stolen valid token is replayable until expiry |
| Role downgrade / membership revoke | Live membership and role read on each protected call and tool step | [agent DB](../../test/db/agent.test.ts) | In-flight work may already have fetched data |
| Tenant or actor spoofing | Verified claims supply context; strict request shapes | [logging-and-input](../../test/db/logging-and-input.test.ts) | DB context is caller-asserted under API compromise |
| RLS bypass | FORCE RLS, restricted runtime role, transaction-local context, catalog assertions | [catalog](../../test/db/catalog.test.ts), [tenant](../../test/db/tenant.test.ts) | DB admins and over-privileged identities remain a risk |
| Credential hash exposure (F1) | Restricted auth role owns hash lookup; API receives public keys only | [h1-boundary](../../test/db/h1-boundary.test.ts) | API proxy sees plaintext; shared OS user |
| Compromised API (F2) | Ordinary-path authorization, scoping and four-eyes checks | [h1-boundary](../../test/db/h1-boundary.test.ts) | API can assert org/actor context; approval intent untrusted under compromise |
| Prompt injection / tool arguments | Deterministic adapter, allowlist, strict schemas, bounded execution | [agent DB](../../test/db/agent.test.ts) | Finite rule coverage; says nothing about a real model |
| Customer disclosure | Internal evidence separated from customer draft; edit checks | [E2E](../../test/e2e/operator-flow.test.ts) | Heuristic filters; ownership unverified |
| Same-user approval, races, stale updates | Separate approver, expected versions, locking, idempotency, append-only history | [review-store](../../test/db/review-store.test.ts) | Actor claims share F2 trust |
| Secrets/PII in logs and CI | Log sanitization, redacted projections, masked CI credentials | [ui-secrets](../../test/db/ui-secrets.test.ts) | Future debug output or privileged hosts |
| Rate limit, outage, login-proxy SSRF | In-memory limits, fixed loopback URL, redirects disabled, deadlines | [auth-http](../../test/auth-http.test.ts) | Limits reset on restart; shared-host faults |
| Dependency / CI supply chain | Lockfile, `npm audit` gates, read-only workflow permissions | [audit-gate](../../test/audit-gate.test.ts) | Point-in-time audit; action tags can move |
| Retention and deployment | Loopback config, synthetic data | [config](../../test/config.test.ts) | No retention, backup or monitoring evidence |

## Hardening paths that are not implemented

Closing F2 would need a trusted approval boundary: for example a DB-verified, single-use decision proof issued by an independent confirmation service, or per-tenant DB principals. Either requires key custody, a separate confirmation route and negative tests for every mutation path. Process-level hardening (distinct OS identities, trusted login ingress, network restriction) reduces exposure but does not resolve F2. None of this is built.
