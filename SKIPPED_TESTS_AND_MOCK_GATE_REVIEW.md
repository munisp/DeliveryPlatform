# Skipped Tests & Controlled Production-Gate Review

**Repository:** `munisp/DeliveryPlatform`  
**Scope:** remaining skipped tests, controlled Docker Compose gate simulation, and verifier implementation review  
**Result:** the fail-closed dependency gate passed a controlled healthy simulation and rejected an unavailable Kafka endpoint; one stale unit test was enabled and fixed.

## 1. Current Test Status

The full local suite now reports **139 passing tests and 27 skipped tests**. The count decreased from 28 because the mobile logout test was no longer stale: its production router already cleared the session cookie correctly, but the test request fixture lacked hostname data. The fixture and cookie helper were hardened, and the test now passes.

| Skip group | Count | Scenario coverage | Enablement condition |
|---|---:|---|---|
| Growth: referral leaderboard | 5 | Current period, entry update, ranking calculation, leaderboard retrieval, user position | A configured `ENV.databaseUrl` with the growth tables and deterministic seed data |
| Growth: push notifications | 4 | Token registration, retrieval, deactivation, delivery logs | Same database plus a disposable test user |
| Growth: A/B campaigns | 5 | Variant creation, retrieval, metrics, performance, allocation update | Same database plus campaign write permissions and cleanup isolation |
| Loyalty program | 7 | Account lifecycle, points, tier upgrade, redemption, insufficient-points rejection | `TEST_DATABASE_URL` targeting an isolated database containing users and loyalty tables |
| Marketplace intelligence | 3 | Seeded driver profile, dispatch payload, compensation-aware ranking | Configured database plus seeded driver `id=1` and related operational data |
| Non-Mojaloop idempotency | 3 | Referral retry safety, loyalty redemption replay, scheduler campaign deduplication | `TEST_DATABASE_URL` to an isolated database with the nine required idempotency and growth tables |

The DB-backed tests no longer contain hard-coded local credentials in the loyalty or non-Mojaloop test files. They now require `TEST_DATABASE_URL`, and `scripts/run-db-backed-integration-tests.sh` rejects database URLs that look like production before running write-heavy test cases.

## 2. Controlled Docker Compose Simulation

The controlled harness uses `deploy/testing/docker-compose.production-gate-mock.yml` and a local Node-based mock container. It is intentionally **not a substitute for real PostgreSQL, Redis, Temporal, Kafka, Fluvio, Caddy, Keycloak, APISIX, or Open AppSec**. It proves only that the production verifier is correctly wired to accept required healthy endpoints and fail closed when a dependency becomes unavailable.

| Mode | Setup | Observed result |
|---|---|---|
| Healthy controlled mode | Mock TLS edge, mock OIDC discovery, mock WAF 403, and open Temporal/Kafka/Fluvio ports; deterministic `psql` and `redis-cli` shims | All production-gate checks passed |
| Failing controlled mode | Identical setup except `KAFKA_BROKERS=127.0.0.1:65530` | Gate exited non-zero and recorded `Kafka broker 127.0.0.1:65530 is unreachable` |

## 3. How `verify-production-dependencies.sh` Works

The verifier is intentionally fail closed.

| Gate stage | Check | Failure result |
|---|---|---|
| Configuration | Requires public/auth hosts, PostgreSQL credentials, Redis URL, Temporal address, Kafka brokers, and Fluvio brokers | Exits 2 before network work |
| Tooling | Requires `curl`, `psql`, `redis-cli`, and `nc` | Exits 2 if a client is unavailable |
| PostgreSQL | Executes `SELECT 1` with `sslmode=require` | Non-zero failure |
| Redis | Requires authenticated `redis-cli ... PING` to return `PONG` | Non-zero failure |
| Temporal | TCP reachability probe to `TEMPORAL_ADDRESS` | Non-zero failure |
| Kafka / Fluvio | TCP probe of every configured broker endpoint | Non-zero failure for any broker |
| Public edge | Delegates to `verify-staging-edge.sh` | Requires TLS health, HTTP redirect, Keycloak OIDC discovery, and WAF block behavior |

## 4. Limits and Next Step

The simulation validates the **deployment gate**, not the middleware implementations. The 27 remaining skips require a disposable PostgreSQL integration database with migrations and deterministic seeds. The real production gate must still be executed against a Docker/Kubernetes staging environment with HA PostgreSQL, authenticated Redis, Temporal, Kafka, Fluvio, Caddy, APISIX, Keycloak, and an attached Open AppSec enforcement point.
