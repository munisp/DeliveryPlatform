# Code Readiness Audit — 2026-08-21

## Decision

The repository is **not eligible for a 100/100 code-readiness claim**. The audit produced a reproducible V8 coverage baseline of **12.92% lines**, **57.44% branches**, and **28.30% functions** across all instrumented files. This is a measurement result, not a proxy for financial correctness. The full suite currently passes **205 tests**, with **30 intentional environment-gated skips**.

## Remediations in this revision

| Finding | Resolution | Evidence |
|---|---|---|
| PostgreSQL certificate verification disabled in production pools | Application and financial-admin pools now use `rejectUnauthorized: true`; optional private CA is supplied through `DATABASE_SSL_CA`. | `env.ts`, `server/db.ts`, `financialAdminStore.ts`, financial-admin regression contract |
| Dismissed finance alerts remained visible as active warnings | Active alert retrieval now filters the latest `dismiss` action while retaining its audit history. | `financialAdminStore.ts`, financial-admin regression contract |
| Runtime production schema mutation and seed fallback | The legacy runtime bootstrap is development-only; production startup no longer executes its DDL or synthetic reference-data paths. A missing leaderboard period returns no result instead of seeding data. | `server/db.ts`, financial-admin regression contract |
| Coverage not reproducibly measurable | Added the version-matched V8 coverage provider and captured a full-suite baseline. | `@vitest/coverage-v8@2.1.9`, coverage output |

## Remaining code-quality debt

The legacy development bootstrap in `server/db.ts` remains a large, un-migrated compatibility surface. Its production execution is now disabled, but a complete migration extraction and direct database integration test suite are needed before its related product modules can be scored as production-complete. Real TigerBeetle, broker, Temporal, and database topology verification remain separate target-environment gates.

## Required next engineering work

1. Split the legacy `server/db.ts` bootstrap into reviewed migrations and remove it completely.
2. Add integration coverage for `accountLifecycleStore`, `financialAdminStore`, authentication/session stores, and the HTTP route layer using a disposable PostgreSQL database.
3. Enforce coverage thresholds only after excluded generated, test-only, and environment-gated paths have been reviewed and documented.
