# Commerce, Field Services, and Developer API Implementation Inventory

**Implementation worktree:** `/home/ubuntu/DeliveryPlatform-commerce-field`
**Branch:** `feature/commerce-field-developer`
**Medusa reference:** MIT-core repository commit `bda24b97`; no Enterprise RBAC or SSO materials will be used.

## Exact E-commerce & Retail gaps in the current source

| Source file | Existing behavior | Gap that prevents production verification | Implementation target |
|---|---|---|---|
| `drizzle/0000_jittery_pride.sql` | Defines a generic `orders` table with `pending` through `refunded` states plus generic providers and drivers. | No cart, line-item, product-variant, inventory reservation, tax, promotion, sales-channel, payment authorization, merchant acceptance, fulfillment, return, or versioned event model. Money is stored as string fields in this legacy table. | Make Medusa core the commerce authority for catalog/cart/checkout/order/fulfillment state; use DeliveryPlatform only for delivery execution and immutable synchronization evidence. |
| `drizzle/0003_tigerbeetle_schema_audit.sql` | Provides provider catalog items, generic order tracking events, reviews, membership, and vertical metadata templates. | Catalog rows are not a commerce catalog; tracking events do not constitute an order/fulfillment workflow; templates do not define vertical operations. | Preserve these as legacy/analytics surfaces; introduce explicit commerce-external identifiers and delivery synchronization records. |
| `drizzle/0023_delivery_tracking_and_proof_of_delivery.sql` | Stores tenant-scoped delivery location and proof metadata with coordinate/MIME/digest checks. | The TypeScript write functions are not reached by a registered driver/service endpoint, and no delivery state is reconciled to an upstream commerce order. | Add authenticated delivery-webhook/event handling, idempotent Medusa order-event ingestion, fulfillment dispatch mapping, and customer-safe tracking reads. |
| `server/_core/deliveryTrackingStore.ts` | Provides parameterized writes and latest-location read. | `recordDeliveryLocation` and `recordProofOfDelivery` have no callers; proof upload authorization is disconnected from the API. | Wire bounded driver/service ingestion only after explicit API-key/role checks and durable delivery/commerce linkage. |
| `server/_core/index.ts` | Exposes only `GET /api/deliveries/:id/tracking`. | No public order, product, checkout, merchant, delivery-ingestion, or versioned developer API endpoints. | Add `/api/v1` key-authenticated APIs and a narrow internal Medusa event endpoint with HMAC verification. |
| `server/_core/localCommerceSuperGateway.ts` | Aggregates optional forecast, allocation, procurement, and Go-gateway planning. | It is advisory and cache-backed: it creates no cart/order/reservation/merchant acceptance/fulfillment record, and optional integrations return `null` when unavailable. | Keep it advisory; add a dedicated Medusa adapter rather than making it an order authority. |
| `server/lib/platformWorkspaces.ts` | Shows merchant, phone-ordering, and service-recovery summaries over generic tables. | Tableside and white-label workspace functions fail closed; merchant/phone views are analytical summaries, not order execution surfaces. | Add real commerce/field-service queries and UI surfaces backed by authoritative state. |
| `services/rust/dispatch-optimizer/src/main.rs` | Produces protected driver rankings, batches, ETA, and retail allocation recommendations. | It does not create authoritative assignments or advance order/fulfillment state. | Consume it as an advisory dispatch input after a commerce/field-service job is ready for dispatch; persist final decisions in PostgreSQL. |
| `services/go/local-commerce-gateway/main.go` | Persists planning events and publishes optional Dapr/Kafka/Fluvio/Temporal envelopes. | The event is a plan, not a commerce transaction; it has no idempotent Medusa event contract or fulfillment synchronization. | Add a narrow, signed Medusa event subscriber and inbound DeliveryPlatform adapter with deduplication and outbox records. |
| Repository-wide API discovery | Internal REST and tRPC routes exist. | No OpenAPI/Swagger contract, developer SDK, API key lifecycle, webhook subscriptions, version/deprecation rules, or integration sandbox. | Add developer-key, webhook, OpenAPI, and contract-test modules. |

## Target authority model

| Domain | Authoritative system | Synchronization rule |
|---|---|---|
| Product, variant, cart, checkout, tax, promotion, inventory, payment authorization, retail/food order, fulfillment | **Medusa core commerce** on PostgreSQL | DeliveryPlatform receives only signed, idempotent event projections; it does not write Medusa order facts directly. |
| Driver/technician availability, geospatial matching, delivery execution, field-service work order, completion proof, operational incident controls | **DeliveryPlatform PostgreSQL/PostGIS** | DeliveryPlatform emits durable outbox events to Medusa-compatible fulfillment synchronization only after local transaction commit. |
| Financial ledger, provider verification, payout, settlement reconciliation | **DeliveryPlatform payment/ledger controls and provider evidence** | Medusa payment state must not mutate the DeliveryPlatform ledger without verified provider events and balanced posting. |
| Redis | Cache, locks, queues only | Redis never decides money, final assignment, work-order transition, or commerce state. |

## Delivery plan

| Phase | Scope | Completion evidence |
|---|---|---|
| 1 | Add `field_service` schema, work order state machine, appointment, technician/service-area records, immutable events, proof records, and outbox. | Disposable PostgreSQL/PostGIS migration/privilege/lifecycle test. |
| 2 | Add TypeScript field-service service module, authenticated operator/technician APIs, versioned public APIs, and operations UI. | Unit, API-contract, TypeScript, and frontend build checks. |
| 3 | Add developer API clients/scopes, API-key hash/rotation/revocation, idempotency records, webhook endpoints/deliveries, OpenAPI contract, and event dispatcher. | Key/auth/idempotency/signature/delivery retry tests. |
| 4 | Add a Medusa v2 MIT-core service package, PostgreSQL/Redis deployment configuration, an event subscriber, and a bounded signed adapter. | Package install/build, configuration lint, signed event contract test, disposable integration against a local Medusa instance. |
| 5 | Add retail/restaurant fulfillment mapping, customer order tracking, merchant acceptance dispatch trigger, and food-specific preparation/handoff metadata. | End-to-end checkout event to delivery/field-service dispatch simulation with no direct money mutation. |
| 6 | Add CI jobs and migration/service test harnesses, then acquire runnable runner capacity and protected staging/provider evidence. | Runner-executed CI, non-production integration artifacts, and reviewed migration order. |

## Explicit exclusions

This plan does not copy or depend on Medusa Enterprise Edition RBAC or SSO materials. DeliveryPlatform continues to use its own existing authorization policy and OIDC arrangements. The work also does not claim a production integration with payment providers, maps, POS systems, storage, email/SMS, customer data, or a staging cluster until those non-production credentials and environments are supplied.

## References

[1]: https://github.com/medusajs/medusa/blob/develop/LICENSE "Medusa core license"

[2]: https://docs.medusajs.com/learn/introduction/architecture "Medusa architecture"

[3]: https://docs.medusajs.com/api/store "Medusa v2 Store API reference"
