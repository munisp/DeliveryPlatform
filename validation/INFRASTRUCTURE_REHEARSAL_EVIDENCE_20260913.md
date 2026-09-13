# Infrastructure Rehearsal Evidence — 2026-09-13

This document records **real-infrastructure validation runs** of the SwitchOS
DeliveryPlatform funds and orchestration middleware, executed against locally
provisioned services (no mocks, no simulators) on 2026-09-13. Raw logs are
committed alongside this file under `validation/evidence/20260913/`.

## Infrastructure under test (user-space, no root)

| Component | Version | Deployment |
|---|---|---|
| PostgreSQL | 16.4 (zonky embedded binaries) | 2 isolated instances (ports 5432/5433), funds schema at schema-contract **v10** |
| Temporal | dev server (CLI) | 2 instances, real SQLite-backed persistence |
| Apache Kafka | 3.9.1 KRaft single-node | port 19092, `RequireAll` acks exercised |
| Redis | 7.2.10 (built from source) | port 6379 |
| TigerBeetle | 0.16.x/0.17.x binaries | single-node rehearsal only (see §4) |
| Toolchains | Go 1.22.12, Rust 1.85.0, Node/pnpm, Python 3 | full build/test verification |

## 1. Temporal journey rehearsal — PASS (3.53s)

`TestRealTemporalJourneyRehearsal` ran two real journeys
(`delivery.warehouse_replenishment`, `ride.driver_payout_release`) through a
live Temporal dev server with a real worker:

- Transient downstream failure (HTTP 409 fixture) retried by Temporal
  (attempts 1–3 observed in history) — retry policy honored by the real server.
- Compensation action (`/inventory/replenishment-cancel`) executed on the
  failure path.
- Ride journey reached `payment_reconcile` reconciliation step.

Log: `temporal_journey_rehearsal_20260913.log`

## 2. Temporal worker-recovery rehearsal — PASS (18.29s)

Same rehearsal with `workerRecovery=true`: the worker was stopped mid-flight
and restarted; the live Temporal server redelivered pending activities to the
new worker and both journeys completed — proving crash-recovery semantics of
the workflow runtime against real server state, not a mocked scheduler.

Log: `temporal_journey_worker_recovery_20260913.log`

## 3. PostgreSQL funds suite — PASS

Full `services/go/mojaloop` test suite (build, vet, `go test -count=1`) against
the isolated PostgreSQL instance, including:

- Transactional outbox: persist-before-publish, `FOR UPDATE SKIP LOCKED`
  claims, claim leases with fencing tokens, stale-completion rejection,
  fail-closed lease timestamp faults.
- TigerBeetle refund finalization rejecting expired claims.
- Refund reservations including pending ledger, serialized under concurrency.
- Schema-contract guard restored to the pre-test contract version (v10) —
  previously a latent test bug restored a hardcoded v7.

Log: `integrate_final_verify_20260913.log` (GO mojaloop: PASS)

## 4. Kafka live-broker rehearsal — PASS (2.31s)

`TestFundsWorkflowEventLiveKafkaRehearsal`
(`services/go/mojaloop/funds_kafka_live_rehearsal_test.go`, env-gated via
`LIVE_KAFKA_BROKERS`/`LIVE_KAFKA_TOPIC`) exercised the **production publish
path** (`publishWorkflowEventToKafkaCompatible` — synchronous writer,
`RequiredAcks: RequireAll`) against a real Kafka 3.9.1 KRaft broker and
consumed the message back, verifying message key, all four workflow headers,
and the full envelope payload.

Log: `kafka_live_rehearsal_20260913.log`

The Fluvio destination uses the same code path over its Kafka-compatible
endpoint (`publishWorkflowEventToFluvio` → `publishWorkflowEventToKafkaCompatible`),
so broker-visible durability evidence covers both destinations' shared writer.

## 5. Full integration verification (branch `integrate`) — PASS

All five remediation workstreams merged (drizzle real schema, Go/Rust graceful
shutdown + self-healing pools, verification retrieval hardening, frontend
hygiene, consumer idempotency + real ILPv4 crypto), then verified:

- **Go**: 9/9 modules — build, vet, test PASS
- **Rust**: 3/3 crates — `cargo check --all-targets`, `cargo test` PASS
- **TypeScript**: `tsc --noEmit` PASS; `vitest` 330 passed / 0 failed / 38
  skipped; `vite build` PASS
- **Python**: all services `py_compile` PASS
- Repo integrity: `git fsck` 0 broken links

Log: `integrate_final_verify_20260913.log`

## 6. Known environment limits (not product defects)

- **TigerBeetle 3-node fault-proxy rehearsal**: each TigerBeetle node requires
  ~2.2 GB RSS by design (pre-allocated grid cache); the sandbox cgroup allows
  ~3 GB total, so a 3-node cluster with Toxiproxy fault injection cannot be
  provisioned in this environment. Single-node TigerBeetle binary smoke was
  performed; the multi-node replication/failover rehearsal remains scheduled
  for a host with ≥8 GB RAM per the runbook (`TIGERBEETLE_RUNBOOK.md`).
- **PostGIS-dependent migrations** (27 of 72): the zonky embedded PostgreSQL
  binaries do not ship PostGIS, so geospatial migrations were not applied in
  this rehearsal environment. All funds/ledger/outbox/contract migrations
  applied cleanly (contract v10 verified).
