# SwitchOS Recommended Next Actions Remediation Wave — 2026-06-21

## Scope of This Wave

This remediation wave targeted the highest-impact **recommended next actions** that were still feasible to implement truthfully in the current repository and environment after the prior funds-safety and blocker-closure work. The focus remained on the most trust-sensitive paths: **funds workflow orchestration**, **broker-backed reliability**, and **reconciliation breadth** across more than the isolated Mojaloop transfer tables.

The goal of this wave was not to overstate completion. Instead, it was to convert additional repository intent into **real executable behavior** that improves operational credibility while still documenting what remains unproven without live staged infrastructure.

## Implemented Changes

| Area | Implemented change | Practical effect |
|---|---|---|
| Fluvio-capable funds publication | Extended `services/go/mojaloop/workflow_runtime.go` with a `publishWorkflowEventToFluvio` path using `FLUVIO_KAFKA_BROKERS` and `FLUVIO_FUNDS_TOPIC` when configured | The active Mojaloop funds runtime can now publish workflow events to a second broker-backed path in addition to Kafka and Dapr, rather than leaving Fluvio completely outside the executable funds runtime |
| Temporal-oriented orchestration outbox | Added durable `mojaloop_workflow_orchestration` persistence plus `enqueueTemporalWorkflowTask` support in the Mojaloop workflow runtime | Transfer, refund, reversal, and reconciliation events can now create durable orchestration records and optionally submit to an external Temporal bridge when configured, improving auditability and failure handling even though this is still not a native Temporal worker |
| Middleware readiness visibility | Expanded `fundsMiddlewareStatus()` to report Dapr, Kafka, Fluvio, and Temporal-oriented orchestration readiness | Runtime health can now describe a fuller funds middleware posture instead of reporting only a subset of the configured ecosystem |
| Broader platform funds reconciliation | Added `getFundsReconciliationSnapshot()` to `server/db.ts` | The Node runtime can now aggregate platform-level finance signals across `transactions`, `payout_settlements`, `driver_incentives`, and `orders`, extending reconciliation beyond isolated Mojaloop transfer and refund tables |
| Protected reconciliation surface | Added `analytics.fundsReconciliation` to `server/routers.ts` | Operators and analytics consumers can now request a real protected backend snapshot of net collected funds, payout exposure, unsettled incentives, settlement posture, and reconciliation recommendations |
| Verification | Re-ran the focused Vitest suites and Mojaloop Go test suite after the new changes | The newly added paths were checked in the current environment rather than being left as unverified code |

## Verification Outcomes

The following checks were executed for this wave.

| Check | Result | Notes |
|---|---|---|
| `gofmt -w workflow_runtime.go` in `services/go/mojaloop` | Passed | The updated Go workflow runtime was reformatted successfully |
| `go test ./...` in `services/go/mojaloop` | Passed | The remediated Mojaloop service still compiles and its Go test suite remains green after the Fluvio-capable and Temporal-oriented additions |
| `npm test -- --run tests/policy.integration.test.ts tests/integration-probes.test.ts tests/operational-events.integration.test.ts tests/platform.scenarios.test.ts` | Passed | The focused Node and Vitest validation suite passed after the new router and reconciliation changes |

## What This Wave Improves Materially

This wave materially improves the platform in three ways.

First, the active funds runtime is no longer limited to PostgreSQL persistence, Dapr publication, and Kafka publication. It now has a **real Fluvio-capable broker publication path** when an appropriate broker endpoint is configured through the environment. That does not prove end-to-end Fluvio staging, but it does move Fluvio support from aspiration toward actual executable behavior in the live Mojaloop service.

Second, the service now creates a **durable orchestration trail** for workflow handoff to Temporal-oriented infrastructure. Instead of only recording workflow events, it also persists orchestration tasks and can attempt bridge submission when a Temporal bridge URL is configured. This does not yet amount to native Temporal workflow execution, but it materially improves auditability and gives the platform a stronger handoff model for external orchestration.

Third, reconciliation coverage is broader and more operationally useful. The new platform funds reconciliation snapshot extends beyond the isolated Mojaloop transfer and refund tables into the wider operator-facing finance picture: transactions, payout settlements, unsettled incentives, driver-fee obligations, and a derived payout coverage gap. This reduces one of the major earlier weaknesses, namely that funds confidence depended on fragmented, non-unified views.

## Honest Residual Constraints

These improvements are real, but they do **not** eliminate all remaining material blockers.

| Residual blocker | Why it still remains |
|---|---|
| No native Temporal worker implementation in the active funds service | The new code persists orchestration tasks and can call an external bridge, but it does not yet run native Temporal workflows with activity retries, workflow history, or task polling inside the service |
| No live staged Fluvio proof | The service now contains a real Fluvio-capable publication path, but there is still no staged broker deployment in this environment proving operational behavior under real load or broker failure |
| Reconciliation is broader, but still not complete across every finance boundary | The new snapshot covers transactions, settlements, incentives, and orders, but it still does not unify every wallet, treasury, chargeback, dispute, and external payment-rail boundary |
| Platform-wide idempotency remains incomplete | Mojaloop idempotency is stronger than before, but there is still no single platform-wide idempotency contract across every money-moving route and every backend boundary |
| Sensitive funds paths are still not live-proven behind staged gateway, identity, and policy infrastructure | Repository assets and runtime hooks exist, but truthful stronger claims still require a staged environment with live enforcement and end-to-end payment simulations |
| Legacy infrastructure-aware suites still depend on provisioned PostgreSQL and full staged services for non-skipped execution evidence | Validation is more honest now, but some broader claims still depend on infrastructure that is not running in this sandbox |

## Updated Honest Assessment

> This remediation wave materially strengthens the SwitchOS platform by adding a **real Fluvio-capable funds publication path**, a **durable Temporal-oriented orchestration outbox with optional bridge submission**, and a **broader protected platform funds reconciliation snapshot** across transactions, settlements, incentives, and orders. However, the platform still does **not** justify a blanket claim that all remaining recommended actions are closed. The implementation is stronger and more operationally credible than before, but native Temporal execution, staged broker proof, broader finance-boundary reconciliation, and staged end-to-end payment simulations are still required before a materially stronger claim would be honest.

## Recommended Next Actions

1. Replace the Temporal bridge pattern with a **native Temporal worker and workflow implementation** for transfer, refund, reversal, and reconciliation execution.
2. Run **staged broker validation** against real Kafka and Fluvio infrastructure, including failure injection and retry behavior.
3. Extend the platform reconciliation snapshot into **wallet, treasury, dispute, and chargeback** boundaries so finance confidence is not limited to settlement and transaction summaries.
4. Define and enforce a **platform-wide idempotency contract** for every money-moving API and asynchronous funds workflow.
5. Run staged end-to-end funds simulations behind the provisioned **gateway, identity, policy, broker, and ledger** stack so stronger claims rely on live proof rather than repository evidence alone.
