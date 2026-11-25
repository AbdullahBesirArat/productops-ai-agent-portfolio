# Engineering evidence

Results below come from running this exact snapshot locally on 2026-11-25 (Windows 11, Node.js 24.13, PostgreSQL 16 in Docker, system Chrome) against an isolated, freshly created database with synthetic seed data and throwaway random credentials. They are point-in-time results, not guarantees.

| Check | Result |
|---|---|
| Lint, typecheck, build | pass |
| Unit tests (`npm test`) | 150/150 (15 consecutive passes after fixing an order-dependent assertion in one concurrent test; see note below) |
| PostgreSQL integration (`npm run test:db`) | 160/160 |
| Chrome end-to-end (`npm run test:e2e`) | 9 pass, 1 skipped (the opt-in screenshot capture) |
| Reliability fault injection (`npm run test:reliability`) | 11/11 |
| Synthetic evaluation (`npm run eval:chain`) | 63/63 intents matched, 0 hard-invariant failures. Fixed fixtures with a rule-based classifier and mocks; this says nothing about LLM or real-world accuracy |
| Demo launcher | starts, `/health` and `/ui` respond |

GitHub Actions results for this repository are shown by the CI badge in the [README](../../README.md); the workflow runs `checks` and `db-tests` ([workflow](../../.github/workflows/ci.yml)).

## What proves what

| Claim | Reproducible proof |
|---|---|
| Auth DB privilege separation and process outage behaviour | [H1 DB boundary](../../test/db/h1-boundary.test.ts) |
| Forgery, expiry and wrong algorithm rejected | [JWT unit tests](../../test/auth-jwt.test.ts) |
| RLS setup and colliding tenant fixtures | [Catalog](../../test/db/catalog.test.ts), [tenant tests](../../test/db/tenant.test.ts), [agent fixtures](../../test/fixtures/agent) |
| Tool allowlist, strict args, live role, timeouts, audited failure | [Tools HTTP](../../test/db/tools-http.test.ts), [agent DB](../../test/db/agent.test.ts) |
| Grounding, abstention, disclosure separation | [Support DB](../../test/db/support.test.ts), [eval script](../../scripts/eval-chain.ts) |
| Separate-actor approval, viewer denial, responsive UI | [Browser suite](../../test/e2e/operator-flow.test.ts), [screenshots](screenshots/README.md) |
| Rollback, contention and recovery | [Reliability suite](../../test/reliability/reliability.test.ts), [chain tests](../../test/reliability/eval-chain.test.ts) |

Reliability coverage: drained pool, database outage and server-side timeout; audit, adapter and service failures; malformed input and actor throttling; replay and conflicting idempotency keys; competing decisions, stale versions and live membership; restart persistence and JWT expiry. Timing numbers from a single local run are not a service-level objective.

## Note: test flake found and fixed during release preparation

During snapshot verification, `preview keeps ownership unverified even when an advisory verifier reports verified` failed intermittently. The test runs two previews concurrently and asserted the order of verifier calls, which is timing-dependent. The assertion now compares the exact set of calls (organisation, actor and order code) independent of order. No timeout was changed and no product code was modified.
