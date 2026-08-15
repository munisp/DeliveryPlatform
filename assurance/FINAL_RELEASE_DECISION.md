# Final Release Decision — Hosted CI Update

**Decision:** **NO-GO — production release remains blocked by live financial-infrastructure and recovery evidence gaps.**

**Current candidate:** `1bc6ee423187dd2fe7e89c007216726c1676025d` on `main` and `origin/main`.

**Hosted evidence:** GitHub Actions run [`31888076799`](https://github.com/munisp/DeliveryPlatform/actions/runs/31888076799), triggered from `1bc6ee4`, completed successfully after the GitHub App permission and Actions budget gates were resolved. The run passed its three jobs: Red-Team & Security Tests, Dependency Vulnerability Scan, and Disposable PostgreSQL Integration & Rollback Rehearsal.

This decision distinguishes verified repository and disposable-database controls from unproven live ledger, broker, Temporal, switch, and deployment behavior. A successful hosted disposable-PostgreSQL gate is not represented as proof of production funds settlement.

## Verified controls

| Control | Current evidence | Result | Interpretation |
|---|---|---:|---|
| Hosted security/red-team suite | GitHub Actions run `31888076799`, Red-Team & Security Tests | **Passed** | The configured LongCat security, circuit-breaker, silent-mockware, and edge-security suite passed on a GitHub-hosted runner. |
| Hosted database integration | GitHub Actions run `31888076799`, Disposable PostgreSQL Integration & Rollback Rehearsal | **Passed** | The CI job applied migrations and deterministic seed data, ran database-backed integration and concurrency suites, and rehearsed rollback using an isolated snapshot clone. |
| Hosted dependency gate | GitHub Actions run `31888076799`, Dependency Vulnerability Scan | **Passed** | The gate rejects every High/Critical advisory except the two explicitly source-verified `image-size@1.2.1` parser findings; their version-exact pnpm patch and deterministic ICNS/JXL/HEIF regression are required. |
| Exact monetary representation | `services/go/mojaloop/money.go`, migration `0006` and Go tests | **Passed locally and in CI source build** | Active Mojaloop transfer, quote, refund, fee, packet, persistence, and outbox values use validated integer minor units rather than `float64` arithmetic. |
| Ledger-first durable outbox | `funds_outbox.go` and real PostgreSQL integration test | **Passed locally and in CI database suite** | Transfer/refund records, workflow records, and destination-specific outbox intents share a transaction. TigerBeetle is a required predecessor; Kafka/Temporal intents cannot be claimed before durable ledger delivery. |
| Idempotent loyalty and campaign control | Database-backed integration plus 100-way concurrency suite | **Passed locally and in hosted database suite** | Loyalty redemption and campaign allocation are guarded by real PostgreSQL transactions with verified concurrent bounds. |
| Schema ownership | migrations `0006`/`0007`, schema-contract integration test and rollback rehearsal | **Passed locally and in hosted database suite** | Mojaloop runtime DDL was replaced by a fail-closed migration-contract check; upgrade and rollback rehearsals are retained. |
| Credential handling | Node and Go environment/constructor regressions | **Passed** | Production paths reject missing and known-placeholder internal-service credentials. |
| TigerBeetle client boundary | Official Go client adapter and Go race/static checks | **Passed at source level** | Mojaloop requires explicit cluster, replica, ledger, and account-map configuration and no longer seeds payer funds or falls back to PostgreSQL as a ledger. [1] |

## Dependency disposition

The prior production audit contained **16 High** findings. The remediated graph uses project-pinned pnpm 10.34 resolution, removes the unused Streamdown graph, applies compatibility-reviewed PostCSS/Nanoid overrides, and includes a reproducible version-exact parser patch for `image-size@1.2.1`.

The hosted audit deliberately **does not suppress** High/Critical results. It fails if any unapproved High/Critical advisory is present. It accepts only the two documented `image-size` advisory IDs after verifying the patched ICNS parser and the resolved JXL/HEIF zero-box traversal guard. Raw package-manager audit output may continue to name those two upstream-unfixed advisories because the upstream version identifier is unchanged; this is a compensating source-control measure, not a claim that the raw audit is empty.

## Remaining release blockers

| Priority | Blocker | Why production release remains blocked | Minimum verified closure |
|---|---|---|---|
| Critical | Real TigerBeetle settlement proof | The adapter and outbox compile, but no controlled replicated TigerBeetle cluster and treasury-funded account set has been exercised. | Run account creation, insufficient-funds, duplicate replay, transfer/refund, reconciliation, client-restart, and partition recovery scenarios against an isolated replicated cluster. |
| Critical | Production funds topology | The reviewed compose stack is not a complete Mojaloop/TigerBeetle production topology. | Deploy a separately reviewed manifest with replicated ledger nodes, Mojaloop, configuration management, readiness checks, backups, recovery runbooks, and operator controls. |
| High | Real downstream middleware faults | PostgreSQL outbox state and ordering are verified, but Kafka, Fluvio, Dapr, OpenSearch, and external-switch failures have not been exercised against the real services. | Run broker unavailability, duplicate delivery, poison-message/dead-letter, recovery, and reconciliation tests against real dependencies. |
| High | Temporal recovery and compensation | Persisted workflow/outbox records exist, but durable execution and compensation require validation against a live Temporal service. | Start workers against a real Temporal service and test retry, crash/restart, compensation, and operator recovery paths. |
| High | Source-patched upstream advisories | Two `image-size` advisories remain reported by upstream tooling because no patched upstream package release is available. | Keep the version-exact patch and regression gate, monitor upstream release/advisory status, and replace the patch with an upstream release as soon as it is available. |

## Release decision and next sequence

The hosted CI gate is now operational and green. The GitHub App has Actions and Workflows read/write permission, and the Actions account budget permits the gate to execute with stop-usage protection. The next release attempt should provision the real financial topology, execute the live ledger/broker/Temporal recovery matrix, retain artifacts, and then update this decision.

> **Production eligibility:** **No-Go.** Repository and disposable-database readiness improved substantially and hosted CI is verified, but the candidate remains **0/100 eligible for a production funds release** until the two Critical live-financial blockers are closed and the listed High recovery gates have real-service evidence.

## References

[1]: https://docs.tigerbeetle.com/coding/clients/go/ "TigerBeetle Go client documentation"
