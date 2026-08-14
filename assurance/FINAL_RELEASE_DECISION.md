# DeliveryPlatform Release Decision

**Decision:** **NO-GO — production release remains blocked.**

**Candidate:** `d557a40fa73e2a0834b91acbe7e01ced5c0af553` on local `main`.

**Remote baseline:** `origin/main` at `f4ca785b1e71be68422d6aba315c400c9a5e0486`.

This decision is deliberately release-blocking. It does not treat source review, local unit testing, a passing build, mocked/simulated tests, or unexecuted workflow configuration as substitutes for financial-infrastructure evidence.

## Decision basis

The candidate improves the platform materially: it makes both Node and Mojaloop internal credentials fail closed, moves the previously non-atomic loyalty/referral idempotency transitions inside their PostgreSQL transactions, and replaces a PostgreSQL-based fake `TigerBeetleClient` (including automatic payer funding) with the official TigerBeetle Go client. The new ledger adapter requires an explicit cluster ID, replica addresses, ledger ID, and account map, and Mojaloop will not start with a nil ledger client or missing ledger configuration. The deployment runbook records the exact no-default configuration boundary. [1]

Those controls do **not** establish that funds can safely move in production. The candidate still represents monetary values as `float64`, treats a remote Mojaloop switch submission failure as a warning after a local ledger movement, lacks a destination-specific transactional outbox, and does not start its persisted Temporal workflows. Furthermore, the declared platform compose stack does not deploy a Mojaloop service or a TigerBeetle cluster. A real ledger and middleware scenario suite has therefore not run.

## Evidence matrix

| Gate | Evidence | Result | Release interpretation |
|---|---|---|---|
| Type safety | `pnpm run check` in the final local gate matrix | **Passed** | Necessary local code-quality evidence only. |
| Production build | `pnpm run build` in the final local gate matrix | **Passed** | Necessary artifact-build evidence only. |
| Node credential fail-closed behavior | `tests/env.security.test.ts` | **Passed: 3 tests** | Production startup rejects absent and known placeholder internal-service credentials. |
| Go credential and ledger fail-closed behavior | `go mod verify`, `go vet ./...`, `go test -race ./...` | **Passed** | The Go module compiles, passes static/race checks, rejects a nil ledger and missing TigerBeetle configuration. |
| Loyalty idempotency repair | Isolated PostgreSQL regression and prior database-backed suite | **Passed locally** | The repaired loyalty/referral transaction boundary has real PostgreSQL evidence; process-kill/restart proof remains absent. |
| Loyalty redemption race | 100-way isolated PostgreSQL test | **Passed locally** | Recorded evidence is 10 accepted `100`-point redemptions, 90 rejections, and a final zero balance. |
| Campaign allocation race | 100-way isolated PostgreSQL test | **Passed locally** | Recorded final allocation does not exceed 100 percent. |
| Migration rollback rehearsal | Sanitized cloned snapshot procedure | **Passed locally** | Reversible migration evidence exists for the assessed snapshot procedure. |
| Hosted database/security gate | `.github/workflows/security-redteam.yml` | **Not run** | GitHub App API access returns `HTTP 403 Resource not accessible by integration`; local evidence cannot replace it. |
| TigerBeetle real-cluster suite | Replicated TigerBeetle cluster and funded settlement accounts | **Not run** | No reachable cluster or controlled account set was supplied. |
| Full funds deployment topology | `deploy/platform/docker-compose.stack.yml` | **Not present** | The stack has no Mojaloop or TigerBeetle service and is not funds-release evidence. |
| Production dependency audit | `pnpm audit --prod --audit-level=high` | **Failed** | 39 findings: 16 High, 18 Moderate, and 5 Low. |

## Unresolved release blockers

| Priority | Blocker | Why it blocks release | Minimum verified closure |
|---|---|---|---|
| Critical | Exact money representation | `float64` is used through transfer, quote, refund, fee, and reconciliation paths. | Enforce a documented currency/exponent policy and integer minor units at API, persistence, ledger, and event boundaries; test boundary and overflow cases. |
| Critical | Truthful external-switch outcome | A switch submission failure is logged after ledger movement and the workflow may still report success. | Persist a durable state machine and outbox intent before remote effects; reconcile unknown outcomes and test restart recovery. |
| Critical | Real TigerBeetle proof | The adapter compiles but has not contacted a real cluster or controlled funded accounts. | Run account creation, insufficient-funds, duplicate replay, partial/full refund, reconciliation, client restart, and partition tests against an isolated replicated cluster. |
| Critical | Missing funds deployment topology | The declared stack omits Mojaloop and TigerBeetle. | Review and deploy a real manifest with replicated ledger nodes, Mojaloop, managed configuration, readiness checks, backup/recovery, and operator runbooks. |
| High | Durable middleware delivery | Kafka, Fluvio, Dapr, and OpenSearch publication lacks destination-specific atomic outbox and caller errors are often discarded. | Implement transactional outbox records, idempotent dispatch, retry/dead-letter policy, and real broker fault tests. |
| High | Temporal recovery/compensation | No service code starts pending persisted workflows, and no executable compensation is proven. | Implement durable workflow dispatch and compensation activities; run against a real Temporal service. |
| High | Hosted CI unavailable | The workflow-bearing candidate cannot be pushed/dispatched with the current integration grant. | Grant the GitHub integration **Actions workflows: Read and write**, push the candidate, dispatch hosted CI, and retain logs/artifacts. |
| High | Dependency vulnerabilities | The production audit reports 16 High findings. | Complete a compatibility-reviewed Expo/React Native remediation, test all targets, and rerun until no High/Critical finding remains. |
| High | Schema ownership | Services perform runtime DDL outside reviewed migrations. | Move all required schema changes into migrations and validate upgrade/rollback on the real stack. |
| High | Simulator-only resilience evidence | Kafka, Temporal, and chaos suites are predominantly in-memory simulations. | Keep them as unit coverage only and add real dependency fault-injection gates. |

## Required activation sequence

The next release attempt must follow this order. First, a repository administrator must grant the GitHub integration **Actions workflows: Read and write**. Then push the pending local commits `40a71ae`, `4960149`, `d6194c8`, `1c7ede4`, and `d557a40` to `main`. This enables the disposable PostgreSQL security workflow to run as designed.

Second, provision the real financial topology through a separately reviewed deployment manifest. The service must receive non-placeholder internal credentials and the explicit TigerBeetle variables described in [`services/go/mojaloop/TIGERBEETLE_RUNBOOK.md`](../services/go/mojaloop/TIGERBEETLE_RUNBOOK.md). Account provisioning and funding must remain treasury-controlled; the software must never assign an automatic balance.

Third, remediate the critical monetary, remote-effect, outbox, Temporal, and schema-ownership issues above. Finally, rerun the real database, ledger, broker, Temporal, edge, and hosted CI gates. Only a green result with retained artifacts for every critical gate can support a new production-release decision.

> **Readiness score:** no production-approval score is assigned because release-critical controls are unproven or incomplete. In release-governance terms, the candidate is **0/100 eligible for production release** until every Critical blocker is closed and the High dependency/hosted-CI gates are accepted by the release authority.

## References

[1]: https://docs.tigerbeetle.com/coding/clients/go/ "TigerBeetle Go client documentation"
