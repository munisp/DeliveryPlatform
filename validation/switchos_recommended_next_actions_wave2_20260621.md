# SwitchOS Recommended Next Actions Remediation Wave 2 — 2026-06-21

## Scope of This Wave

This remediation wave continued the remaining **recommended next actions** from the previous funds-safety and production-readiness work. The priority in this pass was to close more of the still-open confidence gaps around **finance-boundary reconciliation**, especially where earlier reporting remained too narrow and still excluded wallet, dispute, and chargeback exposure from the platform-wide view.

The goal of this wave was not to claim final completion. The goal was to convert another material subset of the remaining recommended actions into **real executable and queryable runtime behavior** while preserving an honest boundary around what still requires staged infrastructure and broader treasury implementation.

## Implemented Changes

| Area | Implemented change | Practical effect |
|---|---|---|
| Broader funds reconciliation breadth | Extended `getFundsReconciliationSnapshot()` in `server/db.ts` to include `wallets`, `support_tickets`, and chargeback exposure from `transactions` in addition to orders, incentives, and payout settlements | The platform’s protected reconciliation view now covers more of the previously missing finance boundaries instead of focusing mainly on net payments and payout obligations |
| Wallet posture visibility | Added wallet count, aggregate wallet balance, negative-wallet count, and last wallet update timestamps to the reconciliation snapshot | Operators can now detect balance anomalies and negative wallet states that could undermine confidence in treasury integrity |
| Dispute and chargeback visibility | Added chargeback amount and count from transactions, along with open dispute-like and critical dispute ticket counts from support tickets | Reconciliation now surfaces customer-remediation and reserve-risk signals that previously remained outside the broader protected finance view |
| Derived treasury drift signal | Added `treasury_drift` as a derived comparison between total wallet balance and net collected funds | The platform now computes a concrete drift signal that can highlight imbalance between recorded balances and collected funds |
| Protected backend route coverage | Kept the new broader view reachable through `analytics.fundsReconciliation` in `server/routers.ts` | The expanded reconciliation breadth is exposed through a real protected runtime surface rather than living only in an internal helper |
| Verification | Re-ran the focused Vitest suites and Mojaloop Go tests after the reconciliation changes | The new changes were validated in the current environment instead of being left as unverified code |

## Verification Outcomes

| Check | Result | Notes |
|---|---|---|
| `npm test -- --run tests/policy.integration.test.ts tests/integration-probes.test.ts tests/operational-events.integration.test.ts tests/platform.scenarios.test.ts` | Passed | The focused Node and runtime validation suite passed after the broader reconciliation changes |
| `go test ./...` in `services/go/mojaloop` | Passed | The Mojaloop service remained green after the broader reconciliation work in the shared TypeScript runtime |

## What This Wave Improves Materially

This wave improves the platform in a materially important way because it reduces one of the core remaining weaknesses from the earlier funds-readiness assessment: **fragmented finance visibility**.

Before this wave, the broader platform reconciliation signal still left out several confidence-sensitive boundaries. A platform operator could inspect payments, settlements, incentives, and order-derived driver obligations, but could still miss wallet imbalances, live chargeback exposure, and open dispute pressure. Those omissions are precisely the kind of blind spots that can erode trust even when core transfer code appears healthy.

After this wave, the protected reconciliation snapshot now includes a more credible cross-section of the platform’s finance posture: payments, refunds, chargebacks, payout exposure, settlements, unsettled incentives, delivered driver-fee obligations, wallet balances, negative wallets, dispute-like tickets, and a derived treasury drift signal. This does **not** make the treasury model complete, but it materially improves operator visibility and risk awareness.

## Honest Residual Constraints

These changes are real, but they still do **not** eliminate all remaining blockers before a materially stronger claim would be honest.

| Residual blocker | Why it still remains |
|---|---|
| No native Temporal worker execution | The platform persists orchestration records and can bridge outward, but it still does not run native Temporal polling, activities, and workflow history inside the active runtime |
| No live staged Kafka or Fluvio proof | Broker-backed publication paths exist in code, but this environment still does not prove behavior under a real staged broker, backpressure, or broker failure |
| Treasury model still incomplete | The reconciliation view is broader, but it still does not unify every reserve, external bank settlement, dispute reserve, merchant reserve, or chargeback-liability accounting boundary |
| Platform-wide idempotency is still incomplete | Mojaloop has stronger idempotency, but there is still no single universal idempotency contract across every money-moving boundary in Node, Go, Rust, and Python services |
| No staged end-to-end funds simulations behind live gateway, identity, policy, broker, and ledger infrastructure | Repository assets and runtime hooks exist, but truthful stronger claims still require staged proof against real infrastructure |
| Some broader legacy suites remain infrastructure-dependent | Validation is more honest and targeted, but certain wider claims still depend on provisioned PostgreSQL and full staged services that are not running in this sandbox |

## Updated Honest Assessment

> This remediation wave materially improves the SwitchOS platform by extending the broader protected funds reconciliation surface into **wallet**, **chargeback**, and **dispute** boundaries, and by adding a concrete **treasury drift** signal that can highlight financial imbalance. However, the platform still does **not** justify a blanket claim that all remaining recommended next actions are closed. The implementation is stronger, more operationally useful, and less blind to finance risk than before, but native Temporal execution, staged broker proof, a fuller treasury model, and live end-to-end funds simulations are still required before any materially stronger claim would be honest.

## Recommended Next Actions After This Wave

1. Replace the current Temporal-oriented outbox bridge with a **native Temporal worker and workflow implementation** for transfer, refund, reversal, and reconciliation execution.
2. Run **staged Kafka and Fluvio validation** with live brokers, retry behavior, and failure injection so publication claims rely on proof rather than code presence alone.
3. Extend reconciliation further into **merchant reserve, treasury reserve, dispute reserve, and external rail settlement** boundaries so the finance view becomes closer to treasury-grade.
4. Define and enforce a **platform-wide idempotency contract** across every money-moving API and asynchronous workflow, not only Mojaloop.
5. Run staged end-to-end payment and payout simulations behind the full **gateway, identity, authorization, broker, and ledger** stack before making materially stronger operational claims.
