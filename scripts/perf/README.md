# Perf harness (`scripts/perf/`)

Reproducible benchmark suite for the DeliveryPlatform performance program.
`baseline.json` was measured against the **pre-perf-tuning** tree (commit
`604d431`, before wave W1–W3 merged). After the tuning waves land, re-run the
same suite (`PERF_LABEL=after`) and diff.

## Contents

| File | Purpose |
|---|---|
| `apply-migrations.mjs` | Applies `drizzle/0000–0092` to a scratch PG16 with the documented stubs (pgcrypto/postgis/citext/btree_gist dropped, geometry/geography→text, ST_* CHECKs + gist indexes + EXCLUDE constraints dropped, `public.gen_random_uuid()` unqualified, `check_function_bodies=off`). Idempotent. |
| `seed.mjs` | Benchmark data volumes (10k users, 50k fare quotes + ride trips, 20k orders/transactions/offers/…, 5 markets, council 15/50/150, etc.) + stub DDL for tables not covered by migrations (`loyalty_*`, `marketing_campaigns`, `longcat_voice_*`, `service_providers.category`, …). Run against a FRESH database. |
| `bench.mjs` | Benchmark runner: p50/p95/p99 over ≥200 iterations (20-iteration warmup) for health, hot read paths, fail-open-with-dependency-down, and service-to-service calls. Spawns a stub OPA on :8190. Writes `baseline.json` (or `$PERF_LABEL.json`). |
| `pgserver-boot.py` | Starts a throwaway PostgreSQL 16.2 via pip `pgserver` (unix socket). |
| `boot-server.sh` | Boots the Node server on :3005 with `perf.env`. |
| `boot-services.sh` | Builds + starts Rust signer (:8109), Go notification-dispatcher (:8099) + safety-engine (:8107), Python lakehouse (:8007). |
| `perf.env` | Environment for the server/services (placeholder secrets, loopback URLs). |
| `baseline.json` | Measured pre-tuning baseline (commit `604d431`). |

## Exact repro (baseline)

Prereqs: `pnpm install` in the repo root; `pip install pgserver fastapi
"uvicorn[standard]" prometheus-client "psycopg[binary]" psycopg-pool requests
python-dateutil`; go 1.23+; cargo (only for service benchmarks).

```sh
# 1. Start scratch PostgreSQL (PG16) — leave running in a terminal
pip install pgserver
python3 scripts/perf/pgserver-boot.py /tmp/pgdata-perf
# 2. Create DB + apply migrations (with stubs) + seed — one-off
psql -h /tmp/pgdata-perf -U postgres -c 'CREATE DATABASE deliveryplatform;'
node scripts/perf/apply-migrations.mjs      # 92/92 files, stubbed
node scripts/perf/seed.mjs                  # prints row counts
# 3. Boot server (:3005) and satellites (:8007/:8099/:8107/:8109)
sh scripts/perf/boot-server.sh &            # login: admin@switchos.local / ChangeMe123!
sh scripts/perf/boot-services.sh
# 4. Run the benchmark suite (writes scripts/perf/baseline.json)
node scripts/perf/bench.mjs --out scripts/perf/baseline.json
```

## After run (post-tuning), one command

On the tuned checkout, repeat steps 1–3 (fresh pgdata for identical volumes),
then:

```sh
PERF_LABEL=after PERF_COMMIT=<sha> node scripts/perf/bench.mjs --out scripts/perf/after.json
```

## What is measured

- **(a)** `GET /api/health` (SLO p95<10ms)
- **(b)** hot read paths (perf-audit P0/P1): `analytics.fundsReconciliation`,
  the 6 analytics dashboard procedures (`summary`, `orderStats`, `driverStats`,
  `marketplaceOverview`, `revenueTrend`, `ordersByVertical`),
  `economics.getFareFloor` / `getTakeRate`, `protection.getPolicy`,
  `contractDefaults.getContractDefaults`,
  `riderVerification.getMyVerificationStatus`,
  OPA-gated protected procedure (`analytics.summary` sample),
  campaign send trigger (`localCommerceSuperGateway.merchantGrowthCampaign`,
  single-user and full-audience), `council.listConsultations`, and
  `auth.me` (session middleware: `last_seen` UPDATE + `resolvePublicUser`)
- **(c)** fail-open with dependency DOWN: `economics.generateMarketReport`
  (`MARKET_ECONOMICS_URL` unset → dead :8110); breaker opens after 5 refused
  connections, then ~0 added latency
- **(d)** service-to-service: Go `notification-dispatcher` + `safety-engine`
  `/health`, Rust `work-record-signer` `/sign` (sequential + 4-parallel),
  Python lakehouse `/health`

## Known pre-tuning defects captured by the baseline

- `analytics.fundsReconciliation` **500s at 604d431**: invalid SQL — `FILTER`
  after `COALESCE` (`server/db.ts:3779` ff.). Baseline records
  `allIterationsErrored: true` with time-to-500 latencies.
- `analytics.*` re-syncs the lakehouse inline on every call (P0): p50 ≈ 0.9s.
- Campaign full-audience send iterates 10k users sequentially (P1): ~65s.
- Mobility lower()-on-enum 500s and `service_providers.category` drift are
  known and tolerated (not benchmarked).
