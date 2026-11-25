# Case study: a bounded deterministic/mock agent workflow

## Problem and constraints

A support operator needs order, stock or policy evidence to prepare a draft while keeping tenants isolated and avoiding unsupported statements. The prototype uses synthetic records, no paid provider or real LLM, and no outbound channel. Operator approval records a decision only.

## Architecture and trust boundaries

A single-origin browser reaches the business API. Its login proxy calls a restricted auth process over loopback, which signs EdDSA tokens. PostgreSQL grants separate auth and app identities. The API checks live role and membership, then uses transaction-local tenant and actor context. The shared gateway validates requests and makes read-only lookups. [Architecture](ARCHITECTURE.md)

## What works

Operators preview deterministic classifications with source-backed internal evidence and a separately composed customer-safe draft. A member creates a review and cannot self-approve. A distinct owner can approve internally. Review history records revisions, expected versions and events. A viewer receives 403 and a foreign-tenant order looks missing. [Demo](DEMO_RUNBOOK.md)

## Failure cases

The workflow abstains on missing or contradictory evidence. Unexpected tool names and arguments stop at validation. Fault injection exercises exhausted pools, DB outages, audit failures, malformed payloads, stale writes and competing approvals. Idempotency limits duplicate work. [Reliability tests](../../test/reliability/reliability.test.ts)

## Tests and evaluation

Unit, PostgreSQL integration, Chrome end-to-end and reliability suites run locally and in CI; a 63-item synthetic classification set checks hard invariants. See [Engineering evidence](ENGINEERING_EVIDENCE.md) for what was run on this snapshot.

## Security limitations and lessons

Moving signing and hash lookup into a separate process narrows F1, but proxy visibility and a shared OS identity leave exposure. The API still supplies database context, so F2 requires a different trust boundary. The four-eyes rule helps in ordinary operation and cannot establish human intent after API compromise. Edited text can also diverge from language metadata. [Security model](SECURITY_MODEL.md)

## Next steps (not implemented)

Resolve separate service identities, an independent approval boundary, retention and deployment design before any real-data pilot. Any real-model integration would need its own evaluation.
