# SwitchOS Flow-of-Funds Audit

**Author:** Manus AI  
**Date:** 2026-06-21

## Executive Summary

This review evaluated the SwitchOS codebase specifically through the lens of **flow of funds**: every workflow where money is quoted, reserved, transferred, settled, compensated, paid out, reconciled, or reported in a way that could materially damage operator trust if it fails.

The platform contains **real implemented components** in this area. The most substantive money-moving path is the **Go Mojaloop service** backed by PostgreSQL persistence and a PostgreSQL-backed TigerBeetle-style ledger shim. There is also a separate **driver payout and settlement path** in the TypeScript database layer, plus generic `transactions` and `wallets` tables in the primary schema. However, these components are **not yet unified into one platform-wide, strongly orchestrated, end-to-end funds architecture**.

The honest conclusion is that I **cannot guarantee** that all flow-of-funds scenarios are fully implemented, robust under all failure modes, or impossible to compromise. Some important scenarios are partially implemented, some are only represented in adjacent UI or summary logic, and some critical distributed guarantees are still missing. In particular, **Temporal, Kafka, and Fluvio are not yet active, end-to-end fund-orchestration dependencies in the live money path**, while APISIX, Open AppSec, Keycloak, Permify, Redis, and OpenSearch are materially improved but not all proven together as a full production topology in this environment.

## What the Current Code Actually Contains

| Area | What is actually implemented | Audit implication |
| --- | --- | --- |
| Cross-FSP quote and transfer service | `services/go/mojaloop/main.go` persists `mojaloop_quotes` and `mojaloop_transfers` in PostgreSQL and exposes initiation, callback, and retrieval endpoints | There is a real money-transfer service path, not only placeholders |
| Ledger posting | `services/go/mojaloop/tigerbeetle_client.go` performs debit and credit updates plus a durable `ledger_entries` insert inside a SQL transaction | There is basic atomic posting behavior for that specific path |
| Driver payout settlement | `server/db.ts` computes base earnings and bonus amounts into `payout_settlements`, then separately updates `driver_incentives` | This is a second money-moving path, but it is weaker and split across multiple writes |
| Generic finance model | `drizzle/0000_jittery_pride.sql` defines `transactions` and `wallets` | The shared platform schema supports transaction records, but not a full double-entry core ledger |
| Shared transaction reporting | `server/db.ts` includes `getTransactions` and `getFinanceSummary` | Finance reporting exists, but it is summary-level and not a strong orchestration or reconciliation layer |
| Middleware support | Redis rate limiting, Permify-aware authorization, Dapr/OpenSearch operational events, live integration probes, OIDC hooks | Important platform controls exist, but they do not yet make the money path fully orchestrated or formally safe |

## Top 20 Production-Relevant Flow-of-Funds Scenarios

The following scenarios are the most relevant comparable money-movement flows for a multi-vertical delivery and marketplace platform.

| # | Scenario | Typical stakeholder |
| --- | --- | --- |
| 1 | Customer payment quote generation before checkout | Customer, merchant, finance ops |
| 2 | Cross-FSP transfer initiation for a completed payment | Customer, payer FSP, payee FSP |
| 3 | Transfer callback completion and state finalization | Finance ops, external switch |
| 4 | Quote callback acceptance and persisted quote state update | Finance ops, external switch |
| 5 | Transfer retrieval and replay-safe status lookup | Support, reconciliation team |
| 6 | Quote retrieval and replay-safe status lookup | Support, merchant ops |
| 7 | Duplicate transfer request replay | External system, middleware, fraud/risk |
| 8 | Duplicate quote request replay | External system, finance ops |
| 9 | Insufficient-balance rejection at payer ledger | Payer FSP, treasury |
| 10 | Ledger debit-credit atomic posting for one transfer | Treasury, finance controls |
| 11 | Driver monthly earnings settlement creation | Driver ops, payroll/finance |
| 12 | Driver settlement approval workflow | Finance manager |
| 13 | Driver settlement processing and payout completion | Payroll, finance ops |
| 14 | Cancelled-order compensation case handling | Support, finance ops |
| 15 | Commission and platform-fee reporting | Finance team |
| 16 | Wallet balance read and wallet-backed value storage | Customer, driver, merchant |
| 17 | Refund or reversal of a completed payment | Support, finance ops, treasury |
| 18 | Partial capture / partial settlement / split settlement | Merchant ops, finance team |
| 19 | Chargeback / dispute / compensation adjustment | Risk, support, finance |
| 20 | Reconciliation across payment, ledger, settlement, and reporting layers | Finance ops, audit, treasury |

## Coverage Matrix for the Top 20 Scenarios

| # | Scenario | Coverage status | Evidence in code | Honest assessment |
| --- | --- | --- | --- | --- |
| 1 | Customer payment quote generation | **Implemented** | Mojaloop `requestQuote`, `mojaloop_quotes` persistence | Real quote request path exists |
| 2 | Cross-FSP transfer initiation | **Implemented** | Mojaloop `initiateTransfer`, TigerBeetle posting, transfer persistence | Real initiation path exists |
| 3 | Transfer callback completion | **Implemented** | `/callbacks/transfers` updates stored transfer state | Real callback handler exists |
| 4 | Quote callback acceptance | **Implemented** | `/callbacks/quotes` updates quote state | Real callback handler exists |
| 5 | Transfer retrieval | **Implemented** | `/transfers/{id}` reads local store then external switch | Real lookup path exists |
| 6 | Quote retrieval | **Implemented** | `/quotes/{id}` reads local store then external switch | Real lookup path exists |
| 7 | Duplicate transfer replay | **Partially implemented** | `ledger_entries.transfer_id` uniqueness and duplicate check | Ledger path is idempotent-ish, but service-wide replay protection is incomplete |
| 8 | Duplicate quote replay | **Partially implemented** | `mojaloop_quotes.quote_id` primary key | Persistence deduplicates by key, but caller-side idempotency contracts are weak |
| 9 | Insufficient-balance rejection | **Implemented** | TigerBeetle shim checks payer balance under lock | Real control exists for that path |
| 10 | Atomic ledger posting | **Partially implemented** | Single SQL transaction in `ProcessMojaloopTransfer` | Atomic inside the ledger shim, but not across switch forwarding and all downstream steps |
| 11 | Driver settlement creation | **Implemented** | `payout_settlements` insert from completed orders and approved incentives | Real computation path exists |
| 12 | Driver settlement approval | **Implemented** | `approveSettlement` updates status and approver | Real approval path exists |
| 13 | Driver settlement processing | **Partially implemented** | `processSettlement` marks settlement completed and updates incentives | No integrated payout rail or ledger posting is attached |
| 14 | Cancelled-order compensation handling | **Partially implemented** | Workspace logic surfaces compensation counts and recommendations | Operational visibility exists, but robust funds workflow is incomplete |
| 15 | Commission / fee reporting | **Partially implemented** | `getFinanceSummary` reads generic transactions | Reporting exists, but depends on incomplete upstream transaction population |
| 16 | Wallet balance handling | **Not fully implemented** | Wallet table exists in schema | There is no robust wallet service backing all flows |
| 17 | Refund / reversal | **Not implemented** | No robust reversal/refund path located in audited money services | Major gap |
| 18 | Partial capture / split settlement | **Not implemented** | No implementation found in Mojaloop, ledger, or shared transaction layer | Major gap |
| 19 | Chargeback / dispute adjustment | **Not implemented** | No dedicated dispute or chargeback flow found | Major gap |
| 20 | End-to-end reconciliation | **Partially implemented** | TigerBeetle shim has `ReconcileTransaction`; finance summaries exist | Reconciliation is too narrow and not full-platform |

## Atomicity, Idempotency, and Failure-Mode Audit

### What is strong today

| Control area | Current strength | Evidence |
| --- | --- | --- |
| Single-transfer ledger posting | Moderate | The TigerBeetle-style ledger shim uses a SQL transaction with `FOR UPDATE`, balance check, debit, credit, and ledger entry insert in one transaction |
| Durable payment state | Moderate | Mojaloop quotes and transfers are persisted in PostgreSQL instead of in-memory structures |
| Duplicate ledger-entry protection | Moderate | `ledger_entries.transfer_id` is unique and duplicate transfer IDs are checked before posting |
| Access control on internal payment endpoints | Moderate | Mojaloop endpoints require an internal service token |

### What remains weak or incomplete

| Risk area | Current weakness | Why it matters |
| --- | --- | --- |
| End-to-end atomicity | The system does not atomically coordinate ledger update, transfer persistence, switch forwarding, eventing, and reporting in one distributed workflow | A failure between steps can leave externally observable divergence |
| Settlement atomicity | Driver settlement creation and incentive linkage are split across separate DB operations | Partial failure can orphan or misalign payout state |
| Settlement payment execution | Settlement completion is mostly status mutation plus payment reference recording | This is not a strong actual payout rail |
| Refund and reversal support | No robust reverse-posting workflow was found | This is a major trust and operational risk |
| Global idempotency | There is no clear platform-wide idempotency key contract across all money routes | Retries may be safe in some places and unsafe in others |
| Unified funds ledger | Shared schema has generic `transactions` and simple `wallets`, while the real posting logic lives in a separate Mojaloop/TigerBeetle path | This fragmentation reduces confidence and complicates reconciliation |

## Middleware Truth Table for Flow of Funds

| Middleware / control | Status in current code | Honest flow-of-funds judgment |
| --- | --- | --- |
| PostgreSQL | **Real and active** | This is the primary durable backbone for funds state |
| Mojaloop | **Real and active** | There is a genuine quote/transfer service path |
| TigerBeetle | **Partially real** | Implemented as a PostgreSQL-backed ledger shim, not a native TigerBeetle cluster |
| Redis | **Real but indirect** | Used for shared rate limiting, which helps protect funds surfaces but does not guarantee settlement safety |
| Keycloak / OIDC | **Real integration path, environment-dependent** | Important for identity, but not enough alone to guarantee fund-flow integrity |
| Permify | **Real integration path, environment-dependent** | Helps authorization boundaries, but does not replace transactional safety |
| Dapr | **Real for operational events** | Useful for event propagation, not yet a full money-workflow orchestrator |
| OpenSearch | **Real for operational event indexing** | Supports observability, not transaction correctness |
| Kafka | **Partial** | Present in the lakehouse connector, not a proven platform-wide funds-event backbone |
| Fluvio | **Probe/config level** | Not an active end-to-end money path today |
| Temporal | **Probe/config level** | Not an active end-to-end funds orchestration engine today |
| APISIX | **Repository-managed and probed** | Important edge control, but not fully validated as the live front door in this environment |
| Open AppSec | **Repository-managed** | Important WAF posture, but not validated around live payment traffic here |
| Lakehouse | **Real analytics surface** | Useful for reporting and observability, not a primary atomic funds engine |

## Can I Confirm That All 20 Scenarios Are Fully Addressed With No Gaps?

No. I cannot honestly confirm that.

The codebase addresses **some** of the top 20 scenarios with real implementation, especially around **quote creation**, **transfer initiation**, **transfer/quote callback handling**, **ledger posting**, and **basic driver settlement generation**. However, I found clear remaining gaps in **refunds**, **reversals**, **chargebacks**, **partial captures**, **split settlements**, **unified reconciliation**, and **platform-wide distributed orchestration**.

## Can I Guarantee the Fund Flows Cannot Be Compromised?

No. I cannot honestly guarantee that.

A truthful guarantee would require at least all of the following to be proven in a live staging or production-like environment:

| Required proof area | Why it is required |
| --- | --- |
| Full gateway and WAF validation through APISIX and Open AppSec | To prove hostile traffic is filtered correctly at the edge |
| Live identity and authorization enforcement with Keycloak/OIDC and Permify | To prove role, tenant, and policy boundaries on all money paths |
| End-to-end distributed workflow validation | To prove failures between services do not produce split-brain fund state |
| Refund, reversal, and dispute workflows | To prove money can be corrected safely after downstream failures |
| Load, retry, timeout, and duplicate-request testing | To prove idempotency and replay resistance under real stress |
| Independent reconciliation reporting | To prove the ledger, payments, payouts, and summaries converge consistently |

The current repository is **stronger than an ordinary prototype**, but it is **not yet at the level where a no-compromise guarantee would be honest**.

## Honest Completion Score for Flow of Funds

| Dimension | Honest score | Reason |
| --- | --- | --- |
| Durable persistence of money state | 84/100 | Core payment path persists to PostgreSQL; some secondary money paths are still fragmented |
| Atomic posting behavior | 72/100 | Present inside the ledger shim, absent end to end across distributed steps |
| Idempotency and replay safety | 68/100 | Some duplicate protection exists, but not platform-wide |
| Authorization and exposure control | 80/100 | Internal token protection and broader auth improvements exist, but full live topology proof is missing |
| Refund / reversal readiness | 25/100 | Major missing area |
| Settlement and payout rigor | 58/100 | Driver settlement exists, but payout execution and reconciliation are not robust enough |
| Middleware completeness for funds | 54/100 | PostgreSQL and Mojaloop are real; Temporal, Kafka, and Fluvio are not yet full funds-path dependencies |
| Reconciliation and auditability | 62/100 | Some reporting exists, but the architecture is still fragmented |
| Overall flow-of-funds readiness | 63/100 | Credible foundation, but not yet trustworthy enough for a blanket guarantee |

## Recommended Next Fixes Before Any Stronger Claim

| Priority | Needed improvement | Why it matters most |
| --- | --- | --- |
| 1 | Implement refund, reversal, and compensation payment workflows with durable postings | These are critical trust-preserving flows |
| 2 | Unify shared `transactions`, `wallets`, Mojaloop transfers, settlements, and ledger entries into one coherent reconciliation model | Fragmentation is the largest architecture weakness |
| 3 | Introduce Temporal-backed orchestration for multi-step fund workflows | Needed for reliable distributed compensation and recovery |
| 4 | Establish platform-wide idempotency keys and retry contracts | Needed for safe duplicate handling |
| 5 | Add end-to-end reconciliation jobs and exception queues | Needed to detect divergence early |
| 6 | Validate the live front door through APISIX + Open AppSec + OIDC + Permify in staging | Needed before any meaningful guarantee |
| 7 | Add automated tests focused on transfer failure injection, duplicate delivery, reversal handling, and settlement race conditions | Needed to raise confidence materially |
| 8 | Decide whether TigerBeetle remains a shim or becomes a true external ledger dependency | Needed for architectural clarity and audit credibility |

## Final Judgment

The platform does **not** currently justify a statement that **all flow-of-funds scenarios are properly implemented and cannot be compromised**.

What it does justify is a narrower, truthful statement:

> SwitchOS has a **real, partially durable, partially atomic flow-of-funds foundation** centered on PostgreSQL, a Mojaloop transfer service, and a TigerBeetle-style posting shim, plus adjacent settlement and reporting logic. However, it still has material gaps in reversals, disputes, unified reconciliation, and distributed orchestration. Because of those gaps, a blanket guarantee would be misleading.

If you want, I can next do one of two things:

1. produce a **scenario-by-scenario implementation backlog** to close the top 20 gaps in priority order, or  
2. start implementing the **highest-risk missing flow-of-funds controls** first, beginning with **refund/reversal orchestration, idempotency contracts, and Temporal-backed payout workflow recovery**.
