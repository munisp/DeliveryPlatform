# SwitchOS Remaining Material Blockers Remediation Wave — 2026-06-21

## Scope of This Wave

This remediation wave targeted a subset of the **remaining material blockers** that still prevented a stronger claim about flow-of-funds safety and production readiness. The work in this wave focused on the active Go-based Mojaloop service because it remains the most sensitive runtime for money movement, lifecycle evidence, and external middleware-backed reliability.

The objective was to convert more of the remaining funds-path risk from **repository intent** into **actual executable behavior**. This report therefore distinguishes clearly between what is now implemented and what still cannot be claimed honestly without real staged infrastructure.

## Implemented Changes

| Area | Implemented change | Practical effect |
|---|---|---|
| Broker-backed workflow events | Extended the Mojaloop workflow runtime to publish durable funds workflow events to **Kafka** when `KAFKA_BROKERS` and `KAFKA_FUNDS_TOPIC` are configured | Transfer, refund, and reconciliation events can now move beyond PostgreSQL persistence and Dapr publication into a real broker-backed stream for downstream consumers |
| Funds middleware visibility | Added `fundsMiddlewareStatus()` and exposed it through the Mojaloop `/health` response | Runtime health now reports whether Dapr and Kafka-backed funds integrations are actually configured rather than implying a purely static capability |
| Reconciliation breadth | Added a `buildReconciliationOverview()` path that aggregates transfer counts, refund counts, settlement states, inconsistent audits, gross transferred amount, refunded amount, and net settled amount | The service now provides a stronger reconciliation summary baseline instead of only per-transfer audits |
| Reconciliation endpoint | Added `/reconcile/overview` to the Mojaloop HTTP surface | Operators and automation can now request a live aggregate reconciliation view through the service boundary |
| Dependency surface | Added the Kafka client dependency in the Mojaloop module and refreshed the module lockfile | The new broker-backed publication path is backed by real compile-time dependencies rather than pseudo-code |
| Automated validation | Expanded Go tests to cover Kafka-unconfigured behavior and middleware configuration reporting in addition to the pre-existing Dapr and refund-state tests | The new runtime behavior is verified in code rather than only described in documentation |

## Verification Outcomes

The following verification steps were executed during this wave.

| Check | Result | Notes |
|---|---|---|
| `gofmt -w main.go workflow_runtime.go workflow_runtime_test.go` | Passed | The modified Go sources were reformatted successfully |
| `go mod tidy` in `services/go/mojaloop` | Passed | The new Kafka dependency resolved successfully and the module graph updated cleanly |
| `go test ./...` in `services/go/mojaloop` | Passed | The remediated Mojaloop service compiled and all Go tests passed |

## What This Wave Improves Materially

This wave materially improves the platform in three ways.

First, the funds workflow path now has a **real broker-backed publication option** in addition to PostgreSQL persistence and Dapr publication. That means the platform can support more realistic asynchronous funds-event distribution when Kafka infrastructure is actually provided.

Second, the reconciliation surface is no longer limited to single-transfer inspection. The new aggregate reconciliation overview makes it possible to monitor **portfolio-level refund and settlement posture**, which is more aligned with operational treasury and trust requirements.

Third, the health output is more honest and operationally useful. Instead of suggesting that middleware readiness exists abstractly, the service now exposes whether Dapr and Kafka funds integrations are truly configured in the running environment.

## Honest Residual Constraints

These changes reduce real blocker weight, but they do **not** eliminate all remaining material blockers.

| Residual blocker | Why it still remains |
|---|---|
| No real staged external payment and ledger proof | Repository code still cannot prove safety under actual callback timing, network failure, or production concurrency without staged infrastructure |
| No real Temporal-backed funds orchestration | Workflow evidence and Kafka-backed publication are stronger, but a true Temporal workflow runtime is still not implemented in the active funds path |
| No Fluvio-backed funds runtime | Kafka is now wired in the active funds runtime when configured, but Fluvio-specific publication and validation remain unimplemented |
| Reconciliation is stronger but still not platform-wide across every finance boundary | The new overview aggregates Mojaloop transfer and refund behavior, but full closure across every payout, wallet, treasury, and reporting boundary is still incomplete |
| Sensitive route enforcement is still not live-proven behind staged gateway and identity infrastructure | Gateway, WAF, policy, and identity assets exist in the repository, but their end-to-end enforcement still requires a live staged environment |
| Local PostgreSQL-dependent legacy validation still depends on real provisioned infrastructure | Earlier suites now skip honestly when the database is unavailable, but stronger claims still require full CI or staged execution without skips |

## Updated Honest Assessment

> This wave further strengthens the SwitchOS funds path by adding **real Kafka-backed workflow publication**, a **live reconciliation overview**, and **clearer middleware readiness reporting** in the active Mojaloop runtime. However, it still does **not** justify a blanket claim that all remaining material blockers are closed. The platform is stronger and more operationally credible than before, but staged proof, true workflow orchestration, and broader reconciliation closure are still required before any materially stronger safety claim would be honest.

## Recommended Next Actions

1. Implement true Temporal-backed orchestration for transfer, refund, reversal, and reconciliation workflows in the active funds path.
2. Decide whether Fluvio is a required production broker for the funds domain; if yes, add a real Fluvio publication path and validation similar to the new Kafka integration.
3. Extend reconciliation beyond Mojaloop transfer and refund tables into payout, wallet, treasury, and reporting boundaries.
4. Run staged end-to-end payment simulations against provisioned Kafka, PostgreSQL, gateway, identity, and ledger infrastructure.
5. Promote the currently environment-bound database suites into provisioned CI or staging so stronger claims are backed by non-skipped execution evidence.
