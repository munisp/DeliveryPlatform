# P0–P2 Commerce, Field-Service, and Developer Platform Status

**Repository:** `munisp/DeliveryPlatform` isolated implementation branch
**Branch:** `feature/commerce-field-developer`
**Implementation commit:** `7ae9423` — `feat(platform): harden commerce field service P0-P2`
**Date:** 2026-09-06

## Executive status

The source-implementable P0–P2 controls added in this change are committed locally. They provide database-authoritative technician proof capture, a provider-scoped public work-order collection API, signed Medusa event verification coverage, a manually dispatched runner-routing smoke workflow, and a self-hosted label selector in the new commerce controls workflow. The code does **not** establish production readiness because the Medusa service still has unresolved upstream production dependency advisories, no self-hosted runner has been registered, and no real non-production integration credentials or external operational evidence have been supplied.

## Exact public developer API contract

The implementation publishes an OpenAPI 3.1 document at `GET /api/v1/openapi.json`. Every public endpoint requires `X-API-Key`. All public write endpoints require `Idempotency-Key` matching `^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`.

| Method | Path | Required scope | Request contract | Successful response |
|---|---|---:|---|---|
| `GET` | `/api/v1/openapi.json` | None | None | The exact versioned OpenAPI 3.1 document served from `server/_core/developerOpenApi.ts`. |
| `GET` | `/api/v1/field-service/work-orders` | `field_service:read` | `limit` integer `1..100`, optional ISO-8601 `updatedBefore` timestamp | `{ "workOrders": [WorkOrderSummary] }` scoped to the API client's provider. |
| `POST` | `/api/v1/field-service/work-orders` | `field_service:write` | `WorkOrderCreate` JSON plus `Idempotency-Key` | `201 { "id": "uuid", "status": "requested" }`; duplicate same-body keys replay durable result. |
| `GET` | `/api/v1/field-service/work-orders/{id}` | `field_service:read` | UUID path value | Privacy-minimized `WorkOrderSummary` only if it belongs to the API client's provider. |

`WorkOrderCreate` is an object with `customerId` (positive integer), `serviceAreaId` (UUID), `title` (3–180 chars), `description` (3–5,000 chars), and `serviceAddress` (3–500 chars). Optional fields are `latitude` (`-90..90`), `longitude` (`-180..180`), `priority` (`low`, `normal`, `high`, or `urgent`), `scheduledStartAt`, `scheduledEndAt` (date-time), and `sourceOrderId` (positive integer). Unknown properties are rejected.

`WorkOrderSummary` contains `id` (UUID), `reference`, `state` (`requested`, `scheduled`, `assigned`, `en_route`, `on_site`, `completed`, or `cancelled`), `priority`, `scheduled_start_at`, `scheduled_end_at`, and `updated_at`. It intentionally does not disclose customer contact, address, technician identity, or proof object keys.

> The authoritative, machine-readable OpenAPI schema is the complete source in `server/_core/developerOpenApi.ts`; it is served unchanged by the application endpoint.

## P0–P2 source controls committed

| Priority | Implemented control | Main source files | Evidence |
|---|---|---|---|
| P0 | Repository-safe Actions recovery path: manual runner smoke workflow and label-matched self-hosted selector for the commerce controls workflow. | `.github/workflows/self-hosted-runner-smoke.yml`; `.github/workflows/commerce-field-developer-controls.yml` | YAML was syntax checked; remote execution remains blocked until a real runner is registered. |
| P0 | Signed Medusa ingress regression coverage, including valid, prefixed, malformed, mismatch, and raw-body alteration cases. | `server/_core/medusaCommerce.ts`; `tests/medusa-commerce-signature.test.ts` | Focused Vitest suite: 2/2 passed. |
| P1 | Technician-only arrival/signature/equipment proof capture with input bounds, locked assigned-order state, durable idempotency, immutable proof/event records, and outbox publication. | `drizzle/0047_field_service_proof_and_public_collection.sql`; `server/_core/fieldService.ts`; `server/routers.ts`; `client/src/pages/FieldServiceOperations.tsx` | Disposable PostgreSQL/PostGIS harness passed; UI uses the authenticated tRPC mutation. |
| P2 | Provider-scoped public collection endpoint and exact OpenAPI update. | `drizzle/0047_field_service_proof_and_public_collection.sql`; `server/_core/developerApi.ts`; `server/_core/index.ts`; `server/_core/developerOpenApi.ts` | Disposable developer API harness passed with API-key scope/provider isolation and collection result. |

## Validation results

| Validation | Result |
|---|---|
| Field-service disposable PostgreSQL/PostGIS lifecycle, proof, idempotency, append-only, and least-privilege harness | Passed: `field_service_result=PASS`. |
| Developer API disposable PostgreSQL/PostGIS API key, provider scope, idempotency, collection, webhook-delivery, and least-privilege harness | Passed: `developer_api_result=PASS`. |
| TypeScript type check | Passed: `pnpm run check`. |
| Focused Medusa HMAC signature tests | Passed: 1 test file, 2 tests. |
| Production web/server build | Passed: `pnpm run build`. |
| Formatting, shell syntax, and whitespace checks | Passed after formatting the changed files. |
| Isolated root test suite (without credential-dependent browser/native discovery paths) | Passed earlier in this branch: 39 files, 192 tests; 30 intentional skips. |

## Findings that are not source-completable

| Blocker | Current state | Required next evidence |
|---|---|---|
| Medusa production dependencies | `npm audit --omit=dev --audit-level=high` reports 67 High and 9 Moderate findings, with no Critical finding. The attempted supported audit-fix path did not provide a safe non-breaking remediation. | A supported upstream Medusa dependency release, independently tested upgrade, clean production audit, and security review. The service must remain deployment-blocked until then. |
| Remote GitHub Actions | PR jobs still fail before runner assignment. The fallback workflow is committed on this isolated branch, but no label-matched runner exists. | Register a dedicated ephemeral runner, merge the smoke workflow to the default branch, dispatch it, capture a runner-assigned successful run, then rerun PR checks. |
| Medusa event integration | Signed ingress and durable idempotent persistence are implemented; no real Medusa test environment, store secret, or delivery endpoint was supplied. | Non-production Medusa/PostgreSQL/Redis environment, one store-specific secret reference, emitted event replay evidence, and negative signature/retry tests over HTTP. |
| Evidence objects | Database stores object keys and digests; it deliberately does not accept arbitrary bytes in the application database. | Object storage policy, pre-signed upload service, malware scanning, retention/deletion policy, and mobile camera/device verification evidence. |
| Operational/public launch controls | Provider sandbox, payment/tax, identity, mapping/traffic, staffing, insurance/regulatory, monitoring, backup/PITR, CNI, and multi-pod resilience are not established by local code. | Approved environment-specific integration and operational evidence. |

## Source-level e-commerce and retail gaps now remaining

The core retail/food handoff is implemented as a signed, idempotent Medusa event to a DeliveryPlatform fulfillment request, with a human operations console. The remaining gap is not a missing database primitive: it is the unproven external operating system around it. A production deployment must bind a real Medusa store to managed or self-hosted PostgreSQL and Redis, supply store-specific HMAC secrets by reference, provide secure object storage, configure actual courier dispatch capacity, and pass the clean dependency gate. Payment capture, tax, inventory reservation, refund and return policies stay in the commerce/payment systems and require provider contracts and sandbox evidence before a claim of full commerce production verification is valid.

## Recommended next implementation sequence

| Priority | Next implementation item | Completion condition |
|---|---|---|
| P0 | Restore actual Actions execution using the label-matched runner smoke workflow. | Smoke job has non-empty runner assignment and executed steps; security and commerce controls execute on a scoped commit. |
| P0 | Remove or securely replace Medusa's audited dependency graph. | Production dependency audit has no unapproved High/Critical findings, with a reproducible lockfile and release review. |
| P1 | Add object-storage upload authorization, scanning, and retention worker for technician proof. | Proof upload is bound to the assigned work order, scan result is auditable, unsafe content cannot become completion evidence. |
| P1 | Run an authenticated HTTP Medusa event replay against an isolated stack. | Valid event ingests exactly once; invalid/replayed/altered events fail safely; fulfilment operations show the durable request. |
| P2 | Publish an SDK generated from the served OpenAPI contract and contract-test it in CI. | Versioned client passes provider-isolation/idempotency compatibility tests against disposable database state. |
| P2 | Add webhook delivery SLOs and a dead-letter review console. | Retry budget, signature evidence, terminal failures, operator replay, and alert thresholds are observable and access-controlled. |

## Reference source files

- `server/_core/developerOpenApi.ts`
- `server/_core/index.ts`
- `server/_core/developerApi.ts`
- `server/_core/medusaCommerce.ts`
- `server/_core/fieldService.ts`
- `server/routers.ts`
- `client/src/pages/FieldServiceOperations.tsx`
- `drizzle/0047_field_service_proof_and_public_collection.sql`
- `scripts/testing/validate-field-service-db.sh`
- `scripts/testing/validate-developer-api-db.sh`
- `.github/workflows/commerce-field-developer-controls.yml`
- `.github/workflows/self-hosted-runner-smoke.yml`
- `services/medusa/commerce-core/package.json`
