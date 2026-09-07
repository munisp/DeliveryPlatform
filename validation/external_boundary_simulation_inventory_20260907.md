# External-Boundary Simulation Inventory

**Author:** Manus AI
**Date:** 2026-09-07
**Scope:** Defined integration contracts found in the isolated DeliveryPlatform worktree. This is a source inventory, not a claim that every third party has been certified or that every regulatory obligation is automatable.

## Inventory Principle

The platform must distinguish its durable internal authority from boundary adapters. PostgreSQL holds trips, offers, financial evidence, vehicle-access evidence, webhook delivery state, and policy versions. Provider messages, routes, identity claims, map data, and partner APIs are untrusted input until their contract-specific verification succeeds. This keeps an external outage or malformed callback from becoming the authority for dispatch, money, or safety state.

## Defined Technical Boundaries

| Boundary | Current source contract | Local simulation or validation | Evidence status |
|---|---|---|---|
| Ride destination/routing input | `ride_trip` and `fare_quote` carry a provider/versioned route result; the Go worker calls `mobility.create_transparent_driver_offer`. | `simulate-driver-offer-economics-matching-worker.sh` starts the actual Go worker, local Redis, and disposable Postgres; tests a synthetic destination that issues and another that fails closed. | Passed locally; no live route provider contacted. |
| Developer outbound webhooks | HMAC-SHA-256 body signing, token-bound delivery claim and completion, durable jittered retry/dead letter. | `test-developer-webhook-retry-backoff.sh` uses loopback receiver/network reset and disposable Postgres. | Passed locally; no external subscriber evidence. |
| Medusa commerce ingress | HMAC verification over raw body and idempotent commerce event ingestion. | `tests/medusa-commerce-signature.test.ts` exercises valid, malformed, mismatched, and altered-body signatures. | Passed locally; no Medusa production deployment. |
| Payment gateway verification/payout | Python payment webhook service verifies provider facts before mutation; financial tests use provider fakes. | Existing payment test suite has fake provider collection, transfer, outage, quarantine, idempotency, and concurrency cases when its isolated database is supplied. | Existing local contract coverage; no provider sandbox credential/certification. |
| External HTTP service health | OIDC, APISIX, OpenAppSec, Permify, Dapr, Fluvio, OpenSearch, and configured business services. | `tests/external-integration-probes.contract.test.ts` runs loopback servers implementing the exact health/discovery paths. | Passed locally. |
| Dispatch/procurement/inventory health | `DISPATCH_OPTIMIZER_URL`, `PROCUREMENT_PLANNER_SERVICE_URL`, `INVENTORY_CONTROL_SERVICE_URL`. | Added to `getLiveIntegrationStatus` and the loopback probe contract test. | Passed locally at health-contract level only. |
| SMS/voice and notifications | Provider URLs appear in configuration; notification/voice services maintain their own boundary contracts. | Existing unit/integration tests cover configured paths where present. | Not a carrier/provider certification. |
| Identity/KYC/insurance/compliance | OIDC endpoint is technically probed; regulated eligibility and insurance evidence are controlled as internal records. | No generic third-party KYC or insurance API is assumed. | Provider and jurisdiction specific; not simulable without signed contracts. |

## Non-Simulable Requirements

Regulations, licences, insurance terms, driver/vehicle eligibility decisions, carrier contracts, tax treatment, payment-provider certification, actual route quality, customer consent, and commercial prices are not generic HTTP destinations. A local simulator cannot certify them. Each needs the responsible legal, compliance, insurance, provider, or commercial counterparty to supply a jurisdiction-specific contract and non-production test environment.

## Test-Target Readiness Controls

The non-mutating `check-driver-offer-economics-target-preflight.sh` requires an explicit `local` or `staging` environment and refuses other labels. It checks the database function contract, extensions, `PUBLIC` revocations, runtime table-read denial, runtime function execution, and matching-worker secret/configuration presence. The ordered migration example now includes `0052_driver_offer_economics.sql`.

> No fixture-writing script in this repository is permitted to target production. Controlled staging must use separately created test data and a least-privilege runtime identity.
