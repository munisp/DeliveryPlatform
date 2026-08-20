# Mission-Critical Code and Funds-Integrity Audit

**Assessment date:** 2026-08-20
**Scope:** DeliveryPlatform repository code, migrations, deployment contracts, and executable automated evidence. This is a code-and-test assessment; it is not a substitute for live financial-topology or staging evidence.

## Decision

> **Do not authorize a production funds launch yet.** Repository controls are materially strengthened and the automated suite is green, but real TigerBeetle, broker, Temporal, and network-partition recovery evidence remains a release gate.

## Verified scorecard

| Control area | Score | Basis | Decision |
| --- | ---: | --- | --- |
| Financial identity and money handling | 86/100 | Exact minor-unit storage, official TigerBeetle adapter, serialized refund reservations, transactional outbox, and new immutable identity controls | Strong code controls; live ledger proof still required |
| Idempotency and replay safety | 85/100 | Durable operation keys, workflow/outbox unique constraints, resource-bound replay rejection, and regression coverage | Strong; live distributed retry proof still required |
| Authorization and insider-threat controls | 88/100 | MFA step-up, OPA plus Permify fail-closed checks, tenant-bound policy input, active-session registry, and decision auditing | Strong configuration and code evidence |
| Edge and availability controls | 84/100 | Caddy, APISIX, Open AppSec, CORS/header stripping, rate limiting, and promotion checks | Requires live DDoS and proxy-chain exercise |
| Recovery and reconciliation | 76/100 | Outbox ordering/retry, refund reservations, compensation tests, and failed-refund filtering | Requires real replicated topology and fault injection |
| **Production release readiness** | **58/100** | Automated evidence is good, but required live financial and staging evidence is missing | **Release blocked** |

Scores express evidence coverage, not a guarantee of defect absence.

## Findings fixed in this audit

| ID | Severity | Finding | Remediation |
| --- | --- | --- | --- |
| FIN-IMM-01 | High | Transfer, quote, and refund upserts could rewrite parties, amounts, or currency when an existing identifier was replayed with conflicting data. | Application upserts now permit only exact immutable identity matches; migration 0018 enforces the same rule with PostgreSQL triggers. |
| FIN-IDEMP-02 | High | Mojaloop idempotency keys could be replayed against a different resource identifier. | Replays now fail when the stored resource identifier differs from the request resource. |
| FIN-REC-03 | Medium | Reconciliation totals could include failed or non-reserved refunds. | Reconciliation and overview aggregates now include only `PENDING_LEDGER`, `PENDING`, and `COMPLETED` reversals. |

## Validation evidence

| Check | Result |
| --- | --- |
| Full repository regression suite | 198 passed; 30 intentional environment-gated skips |
| New financial immutability contracts | 3 passed |
| Existing funds integrity contracts | 3 passed |
| TypeScript | Passed |
| Production build | Passed |
| Go formatting and compilation | Not run: the current sandbox has no Go toolchain |
| Replicated TigerBeetle, broker, and Temporal rehearsal | Not run: current sandbox lacks Docker, bridge networking, io_uring, and required memory |

## Remaining release gates

| Gate | Why it is required | Required evidence |
| --- | --- | --- |
| Real replicated financial rehearsal | Static and simulated tests cannot prove TigerBeetle consensus, broker acknowledgement, Temporal recovery, or cross-service fault handling. | Isolated non-production host with Docker, Go, io_uring, bridge networking, and at least 7 GiB available RAM. |
| Staging OIDC and mailbox rehearsal | User identity and verification delivery require the configured identity provider and non-production email service. | Private staging lifecycle URL, OIDC client, and Mailpit API. |
| Go test and static analysis | The service that owns financial dispatch must compile and run with its pinned dependency graph. | Go-capable build host and `go test ./...` for `services/go/mojaloop`. |
| Hosted runner recovery | Hosted validation remains independently useful for clean-room CI evidence. | Successful GitHub Actions run once runner availability permits. |

## Required production controls

The target environment must apply migrations 0017 and 0018 before enabling session security and immutable financial identity protections. The promotion verifier must pass with non-placeholder component credentials, MFA enforcement, and OPA health. Any reconciliation inconsistency, failed financial outbox entry, or unavailable ledger/broker/Temporal dependency must block settlement finalization and trigger investigation.
