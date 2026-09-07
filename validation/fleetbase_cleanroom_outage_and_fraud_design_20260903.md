# Clean-Room Logistics Platform Roadmap, Lagos Payment-Outage Runbook, and Driver-Fraud Detection Design

**Prepared:** 2026-09-03
**Scope:** Public feature and technology review of `fleetbase/fleetbase` at revision `d810cee000d42713942a2343264eb706b0b3a59a`; an independent implementation roadmap for DeliveryPlatform; payment-webhook failure recovery during Lagos telecom or gateway outages; and automated driver-fraud controls for surge periods.

> **Legal notice.** This is an engineering and operational assessment, not legal advice. The Fleetbase repository declares AGPL-3.0 and describes a commercial alternative. The AGPL’s network-interaction clause requires an operator of a modified covered work to offer users the corresponding source of that modified version.[1] A qualified software-licensing lawyer must determine whether a proposed relationship or implementation is derivative and whether a commercial licence is needed. The recommendation below is a **clean-room functional reimplementation**, not an adaptation, port, translation, copy, or compatibility clone.

## 1. What the Public Fleetbase Materials Describe

Fleetbase publicly describes a modular logistics and supply-chain operating system for last-mile delivery, food and beverage, courier, field-service, and enterprise logistics use cases.[2] Its public feature list includes configurable order workflows, live order/fleet mapping, service zones, APIs, realtime sockets/webhooks, telematics, IAM, configurable rules, dashboards, mobile apps, and extension-oriented product composition.[2] The public dependency declaration identifies a PHP/Laravel core and names routing and vehicle-routing integrations, Redis, sockets, storage, payments, and a separate console surface.[3]

Those public statements are valid sources of **product requirements and technology categories**. They are not a licence to reproduce Fleetbase source code, database schemas, API routes, extension packaging, user-interface layout, names, trademarks, documentation text, or non-public behavioural details.

| Public capability category | Independent DeliveryPlatform capability | Clean-room implementation boundary |
|---|---|---|
| Orders, jobs, workflow boards | Shipment/job aggregate, independently designed state machine, audit trail, Kanban/map operations UI | Define new entities, state names, API routes, and UI layouts from original product requirements. |
| Live maps, zones, tracking | PostgreSQL/PostGIS service zones, Go location ingest, Redis GEO presence, TypeScript/MapLibre console | Use OpenStreetMap-compatible data and independently designed zone/routing interfaces. |
| Dispatch and optimisation | Go real-time matching, Rust batch route/dispatch optimisation, constraints and explainability records | Implement our own scoring, lease, assignment, and optimisation models. |
| Routing / ETA | Rust routing adapter over independently selected OSRM, Valhalla, or commercial routing provider | Use documented public service APIs; do not reproduce Fleetbase adapters or defaults. |
| Webhooks, sockets, integrations | Python verified provider webhooks, transactional outbox, TypeScript realtime gateway | Create versioned event envelopes and endpoint contracts from first principles. |
| Telematics | Go device/location ingestion, signed device identity, fraud-quality projection | Adopt device-vendor APIs under their own licences and contracts. |
| IAM and multi-tenancy | Existing OIDC/RBAC/tenant isolation with policy-as-code and audited delegation | Design fresh roles, permissions, tenant hierarchy, and admin screens. |
| Dashboards and reports | TypeScript operations console and independently defined KPI schemas | Use our own dashboard taxonomy, layouts, and data models. |
| Mobile rider/driver applications | TypeScript/React Native applications with fresh UX, accessibility, and local safety features | Do not reproduce screenshots, copy, information architecture, or brand assets. |

## 2. Clean-Room Reimplementation Protocol

A technical resemblance at the business-feature level does not resolve copyright or licensing questions. The safest execution model separates public requirements research from implementation and maintains a provenance record.

| Control | Required practice | Evidence |
|---|---|---|
| Functional specification | Create independent user stories from public documentation, customer interviews, regulatory requirements, and original product research. | Dated requirements with public-source citations. |
| Source-code boundary | Do not copy, translate, adapt, port, or line-by-line study Fleetbase source, tests, schemas, endpoints, UX assets, or extension manifests for implementation. | Team acknowledgement; repository access separation. |
| Naming and UX boundary | Do not use Fleetbase names, logos, screenshots, documentation prose, route naming, extension names, or interface layouts. | Design review and trademark review. |
| Architecture provenance | Select components based on open standards and independent benchmarks, not upstream implementation details. | Architecture decision records, benchmark reports, third-party licences. |
| Legal review | Review AGPL obligations, commercial alternative, trademarks, all dependencies, provider terms, and deployment model. | Written counsel decision before launch. |
| Engineering review | Require design review against independent specifications and run similarity/provenance checks before merge. | Pull-request checklist and release sign-off. |

## 3. Independent Target Architecture

The intended platform should be organised around durable, versioned business events rather than a monolithic logistics codebase. PostgreSQL/PostGIS remains the source of truth; Redis is an acceleration layer; and every state-changing service emits through a transactional outbox.

| Layer | Go | Rust | Python | TypeScript |
|---|---|---|---|---|
| Edge and realtime | Location/device ingest, matching control API, delivery webhooks | — | Payment-provider callback API and reconciliation controls | Rider, driver, merchant, and operations clients; realtime subscription gateway. |
| Operational core | Order/job orchestration, telematics validation, notification triggers | Routing, ETA, batching, capacity optimisation, pricing optimisation | Forecasting, fraud scoring, document review assistance, reconciliation workers | Operations console, workflow designer, dashboard/reporting UI. |
| Data and events | PostgreSQL/PostGIS access; Redis GEO projection; outbox publisher | Spatial/graph optimiser read models | Feature store and model service; durable fraud cases | Read models and visualisation only; no trust decisions in browser state. |
| Controls | Tenant authz, rate limits, idempotency, safety holds | Deterministic optimisation evidence | Model governance, review queues, anomaly explanation | Consent, notices, workflow approval screens, human-review interfaces. |

The geospatial baseline is PostgreSQL/PostGIS for durable boundaries, routing points, evidence, and query correctness; Redis GEO for bounded fresh-driver lookup; MapLibre for browser mapping; and a separately chosen routing/optimisation engine behind a documented adapter. This achieves the same broad operational category as public logistics platforms without coupling the product to their source code or licence.

### Delivery sequence

| Release | Independent scope | Success criterion |
|---|---|---|
| R1: Core dispatch | Service zones, location ingest, order/job state, live operations map, Go match worker, PostGIS/Redis correctness tests | One-city delivery and ride beta can create, match, track, complete, and recover a job. |
| R2: Fleet and field operations | Driver/vehicle compliance, shifts, capacity, routing/ETA adapter, proof of service, operational workflow boards | Audited operator workflow replaces manual spreadsheet control. |
| R3: Partner ecosystem | Public APIs, versioned webhooks, merchant portals, independently designed extensions/integration SDK | Third parties integrate through documented contracts without direct database access. |
| R4: Optimisation and intelligence | Rust optimisation, demand forecasts, fraud decision service, explainability, review queues | Measured improvement with no uncontrolled automated safety/financial adverse action. |

## 4. Lagos Payment Webhook: Failure Modes and Recovery

The payment service must treat the provider as the settlement authority and the platform ledger as the internal accounting authority. A callback is a signal, not proof of money movement. The selected provider’s current live contract must govern concrete retry intervals, IP rules, API semantics, and dispute handling. For example, Paystack documents HMAC-SHA512 callback signing, retry behaviour after a non-200 response, and payment/transfer success, failure, and reversal events.[4] Flutterwave documents signed callbacks, independent transaction verification, duplicate/retry handling, and a backup verification process for pending payments.[5]

### 4.1 State-machine invariant

`created → authorisation_pending → capture_pending → captured → settlement_pending → settled` is the only normal money path. `failed`, `reversed`, `chargeback_open`, and `review_required` are terminal or controlled exception paths. The customer ride is not marked paid, driver earnings are not payable, and a merchant balance is not made available until a provider-authenticated verification confirms the immutable reference, amount, currency, and success state.

| Failure mode | Detect | Immediate automated action | Human recovery and customer outcome |
|---|---|---|---|
| Lagos mobile-data / device outage after rider payment attempt | Client lacks confirmation; pending platform payment; no verified callback | Keep payment `capture_pending`; save idempotency key and client reference; show “payment pending—do not retry unless prompted.” | Reconcile by provider reference once connectivity returns; refund/void only after provider verification. |
| Provider API DNS/TLS/connect timeout | Circuit-breaker failure rate; elevated verification timeout metric | Acknowledge a valid signed event only after durable event receipt; queue verification; suspend payout releases for unresolved payments. | Retry with bounded exponential backoff; provider-support escalation if SLA threshold is crossed; no manual “paid” override. |
| Gateway returns 5xx / ambiguous transfer response | Submit attempt lacks definitive provider transfer ID | Mark payout `submitted_unknown`; use the same idempotency reference; prohibit a second transfer. | Query transfer status until terminal; escalate with provider reference; settle or fail exactly once. |
| Webhook never arrives | `capture_pending` age exceeds configured threshold | Reconciliation worker queries only known pending provider references on a bounded schedule. | Transition only from authenticated verification; support contacts rider with neutral pending language. |
| Duplicate / reordered callback | Unique `(provider, provider_event_id)` or reference conflict | Return idempotent acknowledgement; do not repeat ledger posting, refund, or payout creation. | Retain event evidence and reconciliation result. |
| Regional telecom outage affects callback ingress | Synthetic external probes fail by region; provider dashboard shows delivery failures | Keep ingress highly available across zones; fail closed on signature error; do not rely on rider callback. | Provider retries plus pending-reference reconciliation recover the final state; communicate incident status. |
| Provider webhook signature/key rotation mismatch | Signature rejection spike after provider change window | Stop state changes from rejected callbacks; page security/finance on-call. | Coordinate secret rotation under dual-secret acceptance window; verify callbacks from provider dashboard before re-enabling. |
| Gateway or bank payout outage | Transfer pending/failed/reversed events; provider transfer query | Freeze new automated payout submissions if failure threshold crosses the approved circuit-breaker; preserve held earnings. | Reconcile recipient/reference/amount; requeue only through a dual-approved recovery command after provider confirms no successful original transfer. |
| Chargeback/dispute after payout | Provider dispute/reversal event; ledger exception | Block unsent payout; mark driver account/earnings under review; preserve trip and device evidence. | Finance and safety review; recover according to approved contractual process, never by silently re-debiting a driver. |

### 4.2 Regional incident procedure

| Time window | Engineering and finance action | Customer and driver communication |
|---|---|---|
| 0–5 minutes | Declare payment incident; start provider, DNS, ingress, queue, and telecom synthetic checks; freeze payouts only if verification or transfer integrity is impaired. | Use in-app status: “Payment confirmation is delayed. Do not make a duplicate payment.” |
| 5–30 minutes | Enable provider API circuit breaker; retain signed callbacks; queue verifications; throttle reconciliation; record affected references and begin provider support case. | Support may confirm a trip completed but must not state that payment is settled until verification. |
| 30–120 minutes | Reconcile all pending references in priority order; publish internal incident cadence; keep payout hold in place for unresolved/reversed cases. | Send targeted resolution or still-pending messages, never expose bank or provider details. |
| Recovery | Require two consecutive healthy verification windows; drain the durable queue; match provider settlement report to immutable ledger; release eligible payouts only after reconciliation. | Notify riders/drivers of final result, refund/receipt as applicable, and support channel. |
| Post-incident | Produce ledger difference report, duplicate-event report, missed-callback report, provider timeline, and action plan. | Provide regulator/provider complaint routing required by contract and law. CBN’s public guide describes first contacting the regulated institution and escalation when unresolved; counsel should validate the current customer-facing process for the selected provider.[6] |

### 4.3 Required operating controls

The platform needs multi-zone ingress, provider status monitoring, independent pending-payment reconciliation, encrypted event retention, strict webhook IP/signature controls where provider guidance supports them, idempotency keys for every collection and transfer, provider reference lookup tooling, a payout kill switch, daily provider-to-ledger reconciliation, and two-person approval for payout recovery or reversal. The outage plan must be rehearsed in the actual provider sandbox and production-like environment.

## 5. Automated Driver-Fraud Detection During Surge Pricing

The fraud system is an **evidence and decision-support system**, not an automatic guilt engine. It must avoid making irreversible suspension, non-payment, pricing, or safety decisions solely from a model score. It should combine deterministic safeguards with statistical and graph signals, use a human review queue for adverse decisions, and log the features, thresholds, model version, analyst action, and outcome.

### 5.1 Five-layer design

| Layer | Responsibility | Technology and storage |
|---|---|---|
| 1. Ingestion and normalization | Consume signed location, device, app-integrity, trip, offer, payment, driver, and rider events; reject malformed/replayed events. | Go ingest; Kafka/Dapr-compatible event stream if adopted; PostgreSQL event store; Redis only for live windows. |
| 2. Rules | Immediately identify impossible velocity, stale/replayed coordinates, mock-location indicators, non-eligible device state, duplicate device identity, or invalid surge transitions. | Go/Rust deterministic rule service with versioned policy tables and explainable reasons. |
| 3. Features and modelling | Build time-window features and relationship graph; score anomalous locations, collusive clusters, and surge manipulation. | Python feature/ML service; PostgreSQL feature snapshots; open-source model registry; graph worker. |
| 4. Decision orchestration | Combine rules and model outputs into `allow`, `step_up_verify`, `hold_offer`, `review_required`, or `temporary_safety_hold`. | Go decision gateway with policy version and immutable case/outbox event. |
| 5. Feedback and governance | Use confirmed cases, appeals, false positives, and analyst decisions to calibrate thresholds and models. | Python training pipeline, review console in TypeScript, audit data in PostgreSQL. |

### 5.2 Data signals

All device and relationship signals must be necessary, documented, secured, access-controlled, and retained only for an approved period under the NDPC/DPIA programme. Hash or tokenise stable identifiers where feasible; do not expose raw fraud features to drivers, riders, or unauthorised operators.

| Threat | Real-time signals | Batch / graph signals | Default response |
|---|---|---|---|
| GPS spoofing | Mock-location/app-attestation flag; impossible acceleration/velocity; timestamp drift; repeated exact coordinates; GPS accuracy degradation; heading/route inconsistency; movement while device is stationary; location-jump without network transition | Same device pattern across trips; geospatial entropy collapse; repeated coordinate templates; historical integrity-score drift | Step-up location/device attestation; remove from matching only when a safety-critical hard rule is triggered; otherwise review. |
| Surge-area manipulation | Enter/exit surge zone around quote/accept event; repeated high-cancellation sequence; unusual trip start/end clustering; device location disagreement with pickup proof | Zone-level anomalous cancellation/acceptance cluster; correlated drivers entering same micro-zone; abnormal surge capture rate relative to peers | Block new quote manipulation; preserve fare quote and event history; review cluster. |
| Rider-driver collusion | Repeated pairings; same device/browser/phone token; shared payment instrument or payout destination; instant accept/cancel cycles; zero-distance pickup; recurring exact routes | Bipartite graph community density, shared recipient/bank/device/vehicle/document nodes, coordinated timing, shared IP/coarse network evidence | Hold incentive/payout; do not deny passenger service solely on a graph score; route to fraud review. |
| Multi-account driver fraud | Shared device attestation ID, SIM/app token, document/liveness reuse, vehicle reuse, payout recipient reuse, overlapping online sessions | Connected-component expansion across device/recipient/document/vehicle graph; account-creation burst; reviewer-confirmed identity links | Prevent concurrent activation; require identity re-verification and human review. |
| Account takeover / credential sharing | New device + unusual geo + new payment recipient + rapid profile change | Historical device/region pattern deviation | Freeze recipient changes and sensitive actions; step-up authentication. |

### 5.3 Feature and scoring contract

Each event should produce a **feature snapshot** keyed by `event_id`, `driver_id`, `trip_id`, `zone_id`, `policy_version`, and `model_version`. A sample formula is deliberately interpretable:

`risk = 0.35 × location_integrity + 0.25 × account_linkage + 0.20 × surge_behavior + 0.10 × payment_anomaly + 0.10 × prior_case_signal`.

The exact weights must be empirically calibrated on labelled outcomes and may not be used as a final adverse-action policy by themselves. Rules take precedence for cryptographic or physically impossible conditions; model output ranks review priority. Every case must show raw event references and human-readable reasons, such as “location jump of 8.2 km in 12 seconds” rather than an unexplained score.

| Risk band | Automated action | Human requirement |
|---|---|---|
| 0–39: low | Allow activity and record feature snapshot. | None. |
| 40–69: medium | Increase sampling, require silent device integrity refresh or next-safe-point verification; no payout acceleration. | Review if repeated within policy window. |
| 70–84: high | Hold incentive or payout release, prevent recipient change, open case, and limit high-risk surge offers if policy allows. | Analyst review before any suspension. |
| 85–100 or hard safety rule | Temporary safety hold, remove from Redis availability through the durable eligibility path, preserve evidence. | Expedited human review, appeal path, and written decision. |

### 5.4 Surge-period operations

During surge, the fraud system should run per-event rules inline with a strict latency budget and publish richer feature work asynchronously. It must use backpressure: when model or graph services degrade, deterministic safety rules continue, uncertain cases become `review_required`, and the platform must never invent a risk score or auto-clear a case because a downstream model is unavailable.

The fraud dashboard must show zone-level fraud-signal rate, review backlog age, step-up success rate, false-positive rate, payout holds, shared-device graph growth, GPS integrity distribution, and the percentage of surge quotes under a fraud-control action. A weekly fairness review should compare false-positive and adverse-action rates across relevant operational cohorts, with appropriate privacy and legal review.

## 6. Automation and Hosting Alternatives

| Approach | Trade-offs | Cost | Setup complexity |
|---|---|---|---|
| Inline rules plus durable outbox workers | Lowest latency and strongest deterministic controls; graph/ML signals arrive later and cannot be the sole safety control. | Uses existing service infrastructure; operational cost depends on database/stream scale. | Moderate. Requires policy tables, event schemas, review queue, and monitoring. |
| Dedicated streaming fraud platform | Better replay, graph computation, feature freshness, and long-horizon model training; adds topic governance, schema compatibility, monitoring, and on-call burden. | Higher infrastructure and data-science operating cost. | High. Requires durable stream, feature store, model registry, and governance. |

Either approach needs an always-running event and review service; it must not depend on ad hoc scheduled analysis or local process memory. The private beta should begin with the first approach and documented human review before a larger streaming platform is justified by measured fraud volume.

## References

[1]: https://github.com/fleetbase/fleetbase/blob/main/LICENSE.md "Fleetbase repository licence: GNU Affero General Public License v3.0"
[2]: https://github.com/fleetbase/fleetbase#readme "Fleetbase public README and feature overview"
[3]: https://github.com/fleetbase/fleetbase/blob/main/api/composer.json "Fleetbase public API dependency declaration"
[4]: https://paystack.com/docs/payments/webhooks/ "Paystack webhook documentation"
[5]: https://developer.flutterwave.com/docs/webhooks "Flutterwave webhook documentation"
[6]: https://www.cbn.gov.ng/FinInc/FinLit/LodgeComplaint.html "CBN complaint lodgement guide"
