# Consumer Scale Baseline — 2026-11-12 (P5-SCALE)

Program: DeliveryPlatform consumer-parity, gap #3 (scale proof).
Scope: consumer tRPC surfaces mounted in `server/routers.ts` —
`consumer:` (:2085), `consumerCatalog:` (:2086), `consumerRide:` (:2090).
Harness: k6 scripts in `deploy/kubernetes/resilience-test/k6/` +
guarded runner `scripts/testing/resilience/run-k6-consumer-suite.sh`.

**Honesty convention: this document contains NO fabricated measurements.**
Every number in the "expected" column is a script-authored projection
(threshold encoded in the k6 scripts), explicitly marked PROJECTION. The
"observed" column is `NOT YET MEASURED` until a guarded suite run completes
and its summary JSON is transcribed here verbatim.

## 1. SLO budget (P5-owned; no prior SPEC_PERFORMANCE.md exists)

| Surface class | Budget | Rationale |
|---|---|---|
| Consumer reads (`consumerCatalog.*`, `consumerRide.myRideTrips`) | p95 < 150 ms, p99 < 300 ms | Indexed point reads over 0072/0104 tables |
| Consumer mutations (`consumer.createCart/addCartItem/checkout`, `consumerRide.requestRide`) | p95 < 300 ms, p99 < 600 ms | Transactional writes incl. integer-kobo fare quote (`fare_quote` CHECK) and idempotency ledger insert |
| `/api/health` liveness | p95 < 10 ms, p99 < 25 ms | Pure in-memory response (`server/_core/index.ts:747`); only meaningful from an in-cluster runner (WAN RTT would dominate otherwise) |
| Error rate (all) | < 0.1% (`rate<0.001`) | Matches existing ride_payment_ingress.js convention |

## 2. Harness usage

Non-production gated — the runner refuses to execute unless ALL guards pass:
`CONFIRM_NON_PRODUCTION_RESILIENCE_TESTS=run`, `TARGET_ENV ∈ {test, staging,
preproduction}`, HTTPS non-prod `CONSUMER_BASE_URL`, exact kubectl context
match, namespace label `resilience.delivery-platform.io/environment=non-production`,
k6-operator TestRun CRD present, and secret key `consumer-session-token`
(test-only consumer account session token; accepted as a Bearer credential by
`server/_core/auth.ts`).

```bash
CONFIRM_NON_PRODUCTION_RESILIENCE_TESTS=run \
RESILIENCE_TEST_CONTEXT=<non-prod-context> \
CONSUMER_BASE_URL=https://staging.example.invalid \
TARGET_ENV=staging \
VERTICAL_ID=1 PROVIDER_ID=1 \
scripts/testing/resilience/run-k6-consumer-suite.sh
```

Launches three TestRuns (parallelism 3 each, `separate: true`):

| TestRun | Script | Procedures exercised | Executor |
|---|---|---|---|
| consumer-checkout-ingress | consumer_checkout_ingress.js | `consumer.createCart` → `consumer.addCartItem` → `consumer.checkout` (mutation chain) | constant-arrival-rate, 20 rps / 15m default |
| consumer-catalog-read | consumer_catalog_read.js | `consumerCatalog.consumerVerticals` / `.consumerProviders` / `.consumerCatalog` + `/api/health` probe | constant-arrival-rate, 60 rps read mix + 1 rps health / 15m |
| consumer-ride-request | consumer_ride_request.js | `consumerRide.requestRide` (trip + fare quote in one txn) + `consumerRide.myRideTrips` read-back | constant-arrival-rate, 15 rps mutate + 30 rps read / 15m |

Each script emits a percentile JSON summary
(`<name>-<runId>-summary.json` via `handleSummary`, same convention as
`tests/longcat.loadtest.ts` percentile reporting and
`ride_payment_ingress.js`) plus a one-line stdout JSON of the budget p95s.
Artifacts land in `validation/resilience_runs/<RUN_ID>/`.

Preconditions: a seeded test consumer account (session token), at least one
active vertical (`VERTICAL_ID`) and provider (`PROVIDER_ID`). Idempotency
keys are unique per iteration (`k6-*-<runId>-<vu>-<iter>`, matching
`consumerIdempotencyKeySchema`), so every mutation is genuine work rather than
a replay short-circuit.

## 3. Expected vs observed

| Metric | Expected (PROJECTION — script-authored threshold) | Observed |
|---|---|---|
| consumer.createCart p95 | < 300 ms (PROJECTION) | NOT YET MEASURED |
| consumer.addCartItem p95 | < 300 ms (PROJECTION) | NOT YET MEASURED |
| consumer.checkout p95 | < 300 ms (PROJECTION) | NOT YET MEASURED |
| consumerCatalog.consumerVerticals p95 | < 150 ms (PROJECTION) | NOT YET MEASURED |
| consumerCatalog.consumerProviders p95 | < 150 ms (PROJECTION) | NOT YET MEASURED |
| consumerCatalog.consumerCatalog p95 | < 150 ms (PROJECTION) | NOT YET MEASURED |
| consumerRide.requestRide p95 | < 300 ms (PROJECTION) | NOT YET MEASURED |
| consumerRide.myRideTrips p95 | < 150 ms (PROJECTION) | NOT YET MEASURED |
| /api/health p95 | < 10 ms (PROJECTION, in-cluster runner only) | NOT YET MEASURED |
| error rate (all operations) | < 0.1% (PROJECTION) | NOT YET MEASURED |

No suite run has been executed as of 2026-11-12; there is no staging
environment wired to this repository in the current program phase. Transcribe
the `handleSummary` stdout JSON verbatim into this table after the first
guarded run.

## 4. Process-state audit — `server/_core/index.ts` `new Map()`/`new Set()`

Seven occurrences (line numbers from main snapshot 2026-11-12, post-P4):

| # | Line | Code | Classification | Horizontal-scaling impact | Sticky-session verdict |
|---|---|---|---|---|---|
| 1 | :1402 | `new Set(["admin","platform_admin","super_admin"])` in `requireFinancialAdministrator` | Request-scoped transient (constructed per call, discarded) | None — no shared mutable state; constant could be hoisted as a micro-opt but is not a correctness concern | Not required |
| 2 | :1478 | `new Set(["admin","operator","ops","platform_admin","super_admin"])` in `requireOperationsActor` | Request-scoped transient | None | Not required |
| 3 | :1731 | `new Set(["admin","platform_admin","super_admin"])` in `requireComplianceReviewer` | Request-scoped transient | None | Not required |
| 4 | :1869 | `new Set(["admin","platform_admin","super_admin"])` in `requireIntegrationAdmin` | Request-scoped transient | None | Not required |
| 5 | :2275 | `const permittedFinancialSimulationScenarios = new Set(["database-partition","broker-failure","temporal-recovery"])` | **Process-global**, module-level; read-only after init (allowlist, never mutated) | None — identical immutable content in every replica; no cross-replica coherence needed | Not required |
| 6 | :2311 | `new Set(["updated_desc","updated_asc","created_desc","created_asc"])` in `/api/admin/finance/overview` handler | Request-scoped transient | None | Not required |
| 7 | :3212 | `new Set(["updated_desc","updated_asc","created_desc","created_asc"])` in `/api/admin/finance/report.csv` handler | Request-scoped transient | None | Not required |

**Verdict: zero horizontal-scaling blockers, zero sticky-session
requirements.** Six of seven are per-request throwaway allowlists (pure
functions of the request); the single process-global (#5) is an immutable
allowlist read-only after module init, so every replica converges trivially.
No in-process mutable session, queue, or cache state exists in
`server/_core/index.ts`; all durable coordination lives in PostgreSQL
(`consumer_processed_events` idempotency ledger, `FOR UPDATE` claim patterns)
so the app tier scales horizontally behind a plain round-robin load balancer.

Audit classification is snapshot-tested in `server/scale-polish.test.ts`
(7 occurrences; exactly 1 module-level `const … = new Set([` binding; exactly
6 inline `!new Set([` request-scoped uses).
