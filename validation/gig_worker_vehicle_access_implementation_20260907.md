# Gig-Worker Vehicle Access Implementation Record

**Date:** 2026-09-07

## Delivered scope

This implementation adds an independent, clean-room vehicle-access module for verified gig workers. It supports low-cost used-vehicle offers, worker eligibility, asset evidence, time-bounded contracts, handover/return evidence, restricted lifecycle transitions, an operations workspace, and append-only operational events. It does **not** integrate with Turo, scrape Turo, perform lending, issue insurance, remote-unlock a vehicle, immobilize a vehicle, or settle ride-payment funds.

## Authoritative database schema

Migration `drizzle/0050_gig_worker_vehicle_access.sql` creates the `vehicle_access` schema with these authoritative records.

| Table | Purpose | Key protections |
|---|---|---|
| `fleet_provider` | Operator-approved vehicle provider/fleet identity. | Operator-only creation and active-state requirement for assets/offers. |
| `worker_eligibility` | Worker verification state, permitted work categories, verifier, and expiry. | Contract request requires `verified`, unexpired eligibility and category overlap with the asset. |
| `vehicle_asset` | Vehicle registration, hashed VIN, make/model/year, odometer, capacity, categories, compliance state. | Registration/VIN uniqueness; only evidence-complete intake assets can activate. |
| `asset_document_evidence` | Registration, roadworthiness, commercial cover, authority, and inspection evidence metadata. | SHA-256 digest, object-key validation, immutable trigger, and operator verifier. |
| `vehicle_offer` | Currency, weekly price, deposit, mileage, excess charge, minimum term, and availability. | Price snapshot is copied into the contract; offers require an available verified asset. |
| `access_contract` | Worker/asset/offer relationship, schedule, state, price snapshot, and transition timestamps. | PostgreSQL exclusion constraint blocks overlapping approved/active/return-pending asset windows. |
| `inspection_evidence` | Handover and return object metadata, digest, odometer, and actor evidence. | Append-only and state-gated; required before activation and closure. |
| `contract_event` | Ordered immutable lifecycle evidence. | Per-contract sequence and idempotency uniqueness; append-only trigger. |
| `outbox_event` | Bounded integration event record for future reviewed consumers. | Idempotent aggregate/event/key uniqueness. |

The database uses security-definer functions with `search_path = pg_catalog, vehicle_access`, revokes all table and function access from `PUBLIC`, and grants only function execution to the optional `vehicle_access_service` runtime role. The TypeScript service invokes functions only; it has no direct `INSERT` or `UPDATE` into vehicle-access tables.

## State machines

### Asset state

```text
intake --(five valid asset-evidence classes + operator activation)--> available
available --(operator approves contract)-------------------------> reserved
reserved --(handover inspection + operator handover)-------------> active_access
active_access --(worker begins return)---------------------------> return_pending
return_pending --(return inspection + operator close)------------> available
approved/active/return_pending --(operator safety suspend)-------> safety_hold
suspended contract --(operator begins safe return)---------------> return_pending
```

`maintenance_hold` and `retired` are reserved protected asset states for a later maintenance/recovery workflow; the present module never treats either state as discoverable or requestable.

### Contract state

```text
requested --(operator approve)-----------------------------------> approved
approved --(handover evidence + operator handover)---------------> active
active --(worker begin return)-----------------------------------> return_pending
return_pending --(return evidence + operator close)--------------> closed
requested/approved --(worker cancellation with reason)----------> cancelled
approved/active/return_pending --(operator suspension reason)----> suspended
suspended --(operator begins safe return)------------------------> return_pending
```

Every mutation records an immutable `contract_event` and an idempotent `outbox_event`. A handover is rejected without handover evidence; closure is rejected without return evidence; an unverified worker cannot create a request; a non-operator cannot approve, hand over, close, suspend, or start a safe return.

## Application integration

| Surface | Implemented function or route |
|---|---|
| PostgreSQL service layer | `server/_core/vehicleAccess.ts` provides typed wrappers for provider, eligibility, asset, evidence, offer, request, inspection, transition, and list functions. |
| tRPC API | `vehicleAccess` router in `server/routers.ts` exposes bounded worker operations and protected operator operations. |
| Client workspace | `client/src/pages/VehicleAccessOperations.tsx` lists active offers/contracts and supports request, inspection, worker actions, and operator transitions. |
| Route/navigation | `client/src/App.tsx` links and registers `/vehicle-access`. |
| Staging migration order | `validation/apply-field-service-developer-api-migrations.staging.example.sh` now includes `0050` after the preceding Developer API/webhook migrations. |

The current interface intentionally makes only worker-request, inspection, worker-return/cancel, and operator contract transitions prominent. Provider, worker-eligibility, asset, evidence, activation, and offer administration are exposed through protected tRPC calls for controlled operator workflows; they should be surfaced in a separately reviewed provisioning experience before a real fleet pilot.

## Local validation evidence

`tests/gig-worker-vehicle-access.config.test.ts` passed 4/4 checks. It verifies the schema states and protected transitions, absence of direct table writes in the service layer, tRPC registration, bounded operator actions, and client route/workspace wiring.

`scripts/testing/validate-gig-worker-vehicle-access-db.sh` passed against a uniquely named disposable PostgreSQL/PostGIS database. It creates a provider and asset, records all five required asset-evidence classes, activates the asset, creates an offer, proves an unverified worker request fails, verifies the worker, then completes:

```text
requested -> approved -> active -> return_pending -> closed
```

It also verifies the asset returns to `available`, records five contract events/outbox events, rejects worker self-approval, blocks direct table reads by an untrusted role, and rejects mutation of inspection and contract-event evidence. The retained execution output is `validation/gig_worker_vehicle_access_db_validation_20260907.txt`.

## Remaining external production prerequisites

This source implementation is not a production launch approval. Before an operational fleet or marketplace pilot, obtain jurisdiction-specific approval for commercial vehicle access/rental, insurance/protection, consumer terms, tax, privacy/telematics retention, emergency/roadside workflows, vehicle recovery, data protection, and dispute handling. Establish a secure object-storage evidence pipeline, a real provider/onboarding operation, maintenance and recall processes, support staffing, payment authorization/reconciliation without ride-fund coupling, production observability, backup/restore evidence, and multi-worker performance testing. No external deployment or credential was used in local validation.
