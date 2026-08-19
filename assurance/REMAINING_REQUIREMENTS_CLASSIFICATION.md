# Remaining Requirements Classification

## Purpose

This document distinguishes **implemented code**, **test-only simulation evidence**, and **real-environment evidence**. A simulation is never a substitute for settlement, broker, workflow, identity, or mailbox proof against the real deployed dependency.

## Implemented Code-Resolvable Work

| Area | Current implementation boundary | Verification retained in repository |
|---|---|---|
| Funds correctness | Integer minor-unit amount validation, fail-closed TigerBeetle configuration, ledger-first durable outbox ordering, authenticated Temporal bridge, destination fail-closed behavior, and serialized pending-refund reservation | Funds, idempotency, concurrency, environment, and migration regressions |
| Account lifecycle | Signup, verification, password reset, onboarding, invitations, tenant branding, role management, notification preferences, delivery history, CSV reporting, and tenant-scoped retention | Isolated PostgreSQL lifecycle rehearsal and UI/configuration regressions |
| Edge and policy configuration | Caddy/APISIX, Keycloak, Permify, credential rejection, LongCat sanitization and fallback policy | Configuration, security, policy, red-team, and dependency gates |

## Test-Only Simulation Evidence

The following cases are intentionally limited to isolated tests and must retain their explicit scope:

| Simulation | What it proves | What it cannot prove |
|---|---|---|
| PostgreSQL/network partitions and concurrent writers | Fail-closed application paths, idempotency contracts, and database concurrency behavior | Real ledger durability or external-switch reconciliation |
| Broker failure and duplicate delivery | Outbox policy, ordering, retry, and application-level deduplication contracts | Real Kafka, Fluvio, Dapr, or managed broker operation |
| Temporal compensation and restart cases | Workflow state-machine and compensation decisions | A live Temporal worker’s persistence, retry, and operator recovery behavior |
| Account lifecycle email sink | Authenticated dispatcher request semantics and lifecycle token handling | A real transactional provider’s delivery, spam, bounce, and mailbox behavior |

## Real-Environment-Only Gates

The release remains blocked until all of the following have evidence from an isolated non-production environment:

1. A replicated TigerBeetle cluster with funded controlled accounts completes settlement, duplicate replay, refund, reconciliation, partition, and restart recovery scenarios.
2. Real Kafka/Fluvio/Dapr/Temporal and the external-switch integration complete outage, recovery, poison-message, and compensation scenarios.
3. The production-shaped deployment topology proves TLS, OIDC redirects, WAF enforcement, policy decisions, and mail delivery to a staging-only mailbox.
4. The source-patched dependency advisories are replaced by upstream-fixed packages when available, or their compensating controls are re-reviewed.

> **Release claim:** simulations and local tests improve code confidence but do not establish production financial eligibility.
