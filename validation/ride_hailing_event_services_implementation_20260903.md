# Ride-Hailing Event Services Implementation

**Date:** 2026-09-03  
**Scope:** Lagos private-beta dispatch matching and payment collection/payout processing  
**Status:** Implemented and validated in disposable PostgreSQL/PostGIS and Redis environments.

## Delivered Services

| Service | Language | Public or internal surface | Durable authority | Purpose |
|---|---:|---|---|---|
| `ride-matching-worker` | Go | Internal HTTP on port `8121` | PostgreSQL/PostGIS | Projects durable driver presence to Redis, selects verified candidates, creates short-lived offers atomically, and reaps expired offers. |
| `ride-payment-webhook` | Python/FastAPI | Provider callback on port `8122`; internal payout/reconciliation controls | PostgreSQL | Validates raw-body HMAC signatures, verifies provider state independently, posts an immutable ledger, creates payout instructions, and releases/settles eligible driver payouts. |

The implementation is registered in the Go/Python Kubernetes workload generator and in the GitHub Actions container-build matrix. It adds a real migration at `drizzle/0026_ride_hailing_dispatch.sql`; the migration image now uses a PostgreSQL 16 PostGIS base image.

## Matching Worker Contract and Safety Properties

The Go worker exposes a database-backed health check, `POST /events/driver-presence`, `POST /matches/attempts`, and `POST /events/reconcile-cache`. All mutating endpoints require `X-Internal-Service-Token` and reject missing or non-constant-time-equal values.

The matching path locks the trip at `SERIALIZABLE` isolation, verifies a requested or matching state, uses Redis `GEOSEARCH` only as a candidate accelerator, and applies durable PostgreSQL eligibility checks before it creates an offer. Redis is never used to decide trip assignment or money. The worker writes a match attempt, driver offer, trip event, and transactional outbox record in one database transaction. Driver presence moves to `offer_pending` only when the relevant update affects exactly one available durable row. This prevents a stale cache member from yielding a duplicate offer.

| Durable invariant | Enforcement |
|---|---|
| One active passenger assignment per driver | Existing partial unique guard plus `accept_driver_offer` transaction procedure. |
| One active driver assignment per trip | Existing partial unique guard and locked trip transition. |
| Redis cannot create an assignment | Redis only supplies bounded nearby IDs; PostgreSQL rechecks availability, eligibility, account state, safety state, location freshness, and integrity. |
| Stale cache updates cannot reactivate drivers | A projection event must contain the exact durable presence version. The worker rejects a mismatch. |
| Offer expiry restores availability safely | A `FOR UPDATE SKIP LOCKED` reaper expires only pending offers and restores a driver only when its active-offer ID still matches. |

## Payment Webhook and Payout Contract

The Python service caps raw webhook bodies at 1 MiB, selects the configured signature header, validates HMAC-SHA512 in constant time, stores the signed event idempotently, and verifies the payment from the provider's authenticated server API before mutating any payment state. A callback alone is insufficient to capture a payment.

On verified collection, the service validates provider reference, exact amount in kobo, and `NGN` currency against the immutable `mobility.provider_payment` record. It then posts balanced ledger entries for driver earnings, platform commission, and statutory/tax allocation; creates one payout instruction per trip; and writes an outbox event. Payout release requires all of the following: an elapsed hold, captured payment, active and safety-clear driver account, current eligibility, and a verified provider recipient. A provider transfer is submitted and independently verified before its payout state reaches `settled`.

| Payment control | Implemented behavior |
|---|---|
| Duplicate provider callback | Unique `(provider, provider_event_id)` insertion returns an idempotent success without reprocessing. |
| Forged or altered callback | Rejected before persistence when raw-body signature validation fails. |
| Amount/currency substitution | Rejected when authenticated provider verification differs from immutable platform payment data. |
| Chargeback signal | Blocks held, queued, or submitted driver payouts and emits an outbox event. |
| Payout destination substitution | Payouts reference only the `driver_payout_recipient` row already verified by the selected provider. |
| Ledger imbalance | Capture and payout transactions call `mobility.assert_balanced_ledger` before commit. |

## New Schema and Runtime Dependencies

The ordered migration enables `postgis`, `pgcrypto`, and `citext`; creates the `mobility` ride, offer, presence, event, provider-payment, settlement, ledger, outbox, recipient, and payout tables; and provides the atomic `accept_driver_offer` procedure. PostgreSQL must permit approved extensions or have PostGIS pre-enabled by the managed database platform.

The Go worker requires `DATABASE_URL`, `REDIS_URL`, and a unique `INTERNAL_SERVICE_TOKEN` of at least 32 characters. The Python service requires the same database and internal-token controls plus `PAYMENT_PROVIDER_NAME`, `PAYMENT_WEBHOOK_SECRET`, `PAYMENT_PROVIDER_API_KEY`, provider verification/transfer URLs, and an explicit `PAYOUTS_ENABLED=true|false`. These values are declared in template-only secret contracts and must be synchronized by External Secrets; no credentials are committed.

A template-only ingress resource is included for the exact `/webhooks/payments` route. It requires a real hostname, TLS secret, ingress class, payment-provider callback allowlist, and provider registration before it is applied.

## Validation Evidence

| Check | Result |
|---|---|
| TypeScript validation | Passed: `pnpm check`. |
| Go matching worker compilation and race target | Passed: `go test -race ./...`. |
| Python webhook compilation | Passed: `python3 -m compileall -q services/python/payment-webhook`. |
| Signed payment integration | Passed: 2 tests. Invalid signature was rejected before persistence; valid collection was idempotent, balanced, and settled one payout. |
| Real matching worker integration | Passed against disposable PostgreSQL/PostGIS and Redis. Presence projected, one candidate was selected, trip reached `driver_offered`, one offer was pending, driver presence reached `offer_pending`, and the available-driver GEO set reached zero members. |
| Kubernetes package validation | Passed: 25 manifest files; 16 Deployments, HPAs, and PDBs. |
| Kubernetes security validation | Passed: 16 runtime identities, 7 NetworkPolicies, 4 ExternalSecrets, and namespace-scoped CI RBAC. |
| GitHub Actions workflow validation | Passed: required build, test, scan, migration, secret, and rollout controls present. |
| Static production gates | Passed: 0 insecure random APIs, TODO/FIXME markers, frontend console logs, unstructured Rust/Python stdout logs, mock/stub markers, and likely empty handlers. |
| Diff integrity | Passed: `git diff --check`. |

## Deployment Alternatives

| Option | Deployment shape | Advantages | Trade-offs |
|---|---|---|---|
| **A. Current implementation** | Separate Kubernetes Deployments for the Go matcher and Python webhook service; PostgreSQL/PostGIS, Redis, provider HTTPS APIs, and transactional outbox. | Lowest additional infrastructure; strict database authority; direct fit with existing manifests and CI/CD. | HTTP trigger calls must be supplied by the location/trip workflow; outbox publisher must be operated for downstream push/notification delivery. |
| **B. Broker-driven extension** | Keep these services but add a managed Kafka/Dapr consumer for location, trip, and payment events. | Higher throughput, replayable event streams, stronger decoupling of mobile/location ingest from matching. | Requires topic governance, schema registry/compatibility, consumer lag monitoring, replay tooling, and a separate production-operating model. |

Both approaches retain PostgreSQL as the source of truth and must use the selected CBN-licensed provider's real API contracts. No deployment option should be activated for real passengers or funds until Lagos/Nigeria regulatory, insurance, privacy, payment-provider, and production launch gates have been signed off.

## Files

| Artifact | Purpose |
|---|---|
| `services/go/ride-matching-worker/main.go` | Durable Go matching and Redis projection implementation. |
| `services/python/payment-webhook/service.py` | Verified payment, ledger, and payout domain implementation. |
| `services/python/payment-webhook/main.py` | FastAPI webhook and internal control router. |
| `drizzle/0026_ride_hailing_dispatch.sql` | Ordered PostgreSQL/PostGIS mobility and payment migration. |
| `scripts/testing/run-ride-matching-worker-integration.sh` | Disposable real-process PostgreSQL/PostGIS/Redis integration harness. |
| `scripts/testing/run-payment-webhook-integration.sh` | Disposable PostgreSQL payment, ledger, and payout integration harness. |
| `deploy/kubernetes/python-services/ride-payment-webhook-ingress.template.yaml` | Explicit TLS/host-gated provider callback ingress template. |
