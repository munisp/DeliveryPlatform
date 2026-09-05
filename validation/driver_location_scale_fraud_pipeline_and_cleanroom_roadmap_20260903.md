# 10,000-Driver Location Scale Validation, Lagos Fraud Pipeline, and Independent Logistics Roadmap

**Prepared:** 2026-09-03  
**Scope:** DeliveryPlatform's independently designed Lagos ride-hailing extension. This document is not a claim of compatibility, parity, or affiliation with Fleetbase. It uses no Fleetbase implementation material.

## 1. Location ingestion and H3 spatial-query load harness

The repository now contains a repeatable, isolated load system for **10,000 logical drivers**. It seeds a disposable PostgreSQL/PostGIS database with 10,000 eligible Lagos driver presences, applies the ordered ride, H3, and durable location-event migrations, starts a disposable Redis instance and the real Go matching worker, then issues **10,000 versioned driver-location updates and 10,000 H3 spatial candidate queries concurrently**. It records every status and latency sample, PostgreSQL transaction/deadlock/lock metrics, durable event counts, H3 projection counts, and Redis GEO/H3 membership counts.

The driver represents 10,000 logical concurrent clients while using a configurable keep-alive socket cap. This distinction prevents the load generator itself from exhausting a local TCP listen queue before the worker can exercise database and Redis limits. Set `LOCATION_CONCURRENCY=10000` and `QUERY_CONCURRENCY=10000` to create 10,000 outstanding logical operations per endpoint; `HTTP_MAX_SOCKETS` bounds active local transport connections independently. This is representative of edge connection multiplexing/load-balancing rather than a claim that one pod should accept all public driver connections.

| Artifact | Purpose |
|---|---|
| `scripts/testing/run-driver-location-h3-load.sh` | Creates isolated PostgreSQL/PostGIS and Redis test dependencies, seeds 10,000 driver presences, starts the real Go service, samples PostgreSQL locks, then asserts all durable/cache outcomes. |
| `scripts/testing/run-driver-location-h3-load.mjs` | Bounded Node client generating signed internal HTTP event/query traffic with raw sample artifacts and latency summaries. |
| `scripts/testing/analyze-driver-location-h3-load.py` | Fail-closed analyser for HTTP outcomes, p50/p90/p95/p99, durable events, H3 projections, Redis memberships, lock waiters, rollbacks, and deadlocks. |
| `drizzle/0029_driver_location_event_stream.sql` | Idempotent durable event stream with `(driver_user_id, device_session_id, source_sequence)` uniqueness, accepted/rejected audit outcome, geographic point, and source-time guard. |

### Run command

```bash
cd /home/ubuntu/DeliveryPlatform
LOCATION_CONCURRENCY=10000 QUERY_CONCURRENCY=10000 HTTP_MAX_SOCKETS=512 \
  scripts/testing/run-driver-location-h3-load.sh
```

The script targets only loopback ports plus disposable local database and cache instances. It has no production host, provider, or customer data configuration.

### Verified run result

The controlled run processed 20,000 simultaneous logical operations using 10,000 location events and 10,000 spatial queries. Every location ingest returned **202**, every H3 query returned **200**, and there were **zero transport errors**. PostgreSQL persisted 10,000 accepted events and 10,000 H3 projections; Redis contained 10,000 GEO members and 10,000 H3 members after processing. PostgreSQL recorded zero deadlocks and zero rollbacks; the peak observed active-session count was 53 with zero observed lock waiters.

| Operation | Logical clients | Socket cap | HTTP success | p50 | p90 | p95 | p99 | Max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Versioned driver-location ingest | 10,000 | 512 | 10,000 / 10,000 | 15,012.564 ms | 17,626.305 ms | 17,912.150 ms | 18,063.253 ms | 18,180.373 ms |
| H3 spatial candidate query | 10,000 | 512 | 10,000 / 10,000 | 5,964.343 ms | 11,791.920 ms | 12,454.314 ms | 13,199.625 ms | 16,175.604 ms |

These latency figures are an **intentional single-host saturation result**, not a passenger-facing SLO. They include queue wait behind a 512-socket cap and a single Go process plus one local PostgreSQL/Redis instance. The throughput/sizing conclusion is not that the service can meet production SLOs at this load; it is that the implementation safely maintains durable/cached state without deadlocks or silent loss under a controlled 10,000-client stress case. Staging must establish service-level targets using deployed pod replicas, production-like database sizing, network latency, load balancing, and observability.

## 2. Durable driver-location contract

The endpoint `POST /events/driver-location` accepts only an authenticated internal producer. It rejects malformed JSON, missing/invalid canonical UUID device-session IDs, invalid coordinates, inaccurate measurements outside the configured safe range, invalid integrity score, future timestamps beyond two minutes, and source timestamps older than ten minutes. It locks the driver's durable presence record, accepts only non-decreasing source times, updates the authoritative PostgreSQL/PostGIS location and version, then stores the full event with an accepted/rejected outcome.

After commit, the worker projects the current committed version into Redis GEO and a bounded H3-cell set. Projection conflicts retry against the current presence version. Cache projection failure does not alter the durable event; reconciliation can recreate the cache from PostgreSQL. H3, Redis GEO, and current cell membership are accelerators. They cannot grant dispatch eligibility or assign a passenger to a driver.

## 3. Automated fraud-detection and GPS-spoofing mitigation pipeline

> The fraud service is an evidence and risk-routing system. It must not permanently suspend a driver, withhold lawful earnings, or degrade passenger access solely from a model score. Human review, an appeal path, recorded reasons, and proportional responses are mandatory except for narrowly defined immediate safety controls.

### 3.1 Service topology and responsibility split

| Component | Language / runtime | Inputs | Durable output | Time budget |
|---|---|---|---|---|
| Driver location gateway | Go matching worker | Authenticated driver location events and app-integrity attestation supplied by the mobile gateway. | `mobility.driver_location_event`, current presence, H3/cache projection, outbox event. | Under the location event request budget; must not wait for ML. |
| Integrity rules evaluator | Go service or Go worker package | Location event, prior accepted point, device posture, current trip/offer state, zone/surge state. | Immutable `fraud.rule_evaluation` and outbox decision signal. | Target under 25 ms excluding database queue. |
| Event transport | Durable transactional outbox → Kafka/Dapr-compatible bus | Committed location, presence, trip, quote, payment, identity, and support events. | Schema-versioned events with idempotency key and correlation ID. | Asynchronous. |
| Feature and graph pipeline | Python | Event stream; approved, minimised device/identity/payout tokens; historical trips. | `fraud.feature_snapshot`, `fraud.relationship_edge`, `fraud.model_score`. | Seconds to minutes; cannot be an inline safety dependency. |
| Decision gateway | Go/Rust | Rule results, current model score, policy/version, case history. | `fraud.decision`, `fraud.case`, eligibility/payout hold outbox command. | Target under 50 ms after rule inputs exist. |
| Analyst workspace | TypeScript | Case evidence redacted by role; decision history; appeals. | Reviewed disposition, reason, reviewer identity, policy/model version. | Human workflow. |
| Governance and training | Python + governed analytics | Labelled analyst outcomes, appeal reversals, false positives. | Evaluated model artifact, bias/quality report, approved version record. | Offline; deployment only after approval. |

### 3.2 Event envelope and schema controls

All fraud-relevant messages must have `event_id`, `event_type`, `schema_version`, `occurred_at`, `received_at`, `producer`, `correlation_id`, `idempotency_key`, `subject_driver_id`, optional `trip_id`, optional `zone_id`, and an evidence reference. Producers sign or mutually authenticate transport. Consumers record processed event IDs in durable storage before executing non-idempotent outcomes; replays therefore regenerate no duplicate payout holds, suspensions, or review cases.

Raw latitude/longitude should be kept in the mobility event store under role-restricted access and short approved retention. The fraud feature store should use reduced precision/geohash/H3 cell where exact coordinates are not necessary. Device identifiers, document hashes, payment recipient references, and IP/network signals must be tokenised or keyed-hashed with rotation, access logging, and an approved Nigeria privacy/DPIA basis. The Nigeria Data Protection Commission publishes the current Nigeria Data Protection Act and implementation guidance; privacy counsel must confirm the programme’s lawful bases, impact assessment, retention, and individual-rights handling before beta collection.[1]

### 3.3 Deterministic GPS and account-integrity rules

| Rule ID | Evidence | Rule | Immediate action | Case action |
|---|---|---|---|---|
| `gps.impossible_velocity` | Consecutive accepted points, source time, accuracy. | Great-circle distance/time exceeds a conservative safety threshold after accuracy allowance. | Do not overwrite accepted presence with impossible point; set `step_up_verify`. | Open a high-priority case after policy threshold/repetition. |
| `gps.impossible_acceleration` | Consecutive speed values/time. | Acceleration exceeds configured road-vehicle threshold and is not explained by low-quality data. | Reject/hold location projection; preserve raw event. | Add evidence. |
| `gps.replay_or_reorder` | Device session + sequence + occurrence time. | Duplicate unique key or decreasing source timestamp. | Idempotent no-op / record rejected stale event. | Escalate only for sustained abuse. |
| `gps.mock_location_attested` | Mobile app integrity/attestation input. | Verified mock-location, root/jailbreak, emulator, or failed hardware-backed assertion under approved policy. | Remove from surge priority and require verification. | Expedited review; immediate availability removal only where safety policy authorises it. |
| `gps.coordinate_template` | H3 sequence + rounded coordinate pattern. | Repeated identical coordinate chains across unrelated trips beyond threshold. | Lower location integrity and increase sampling. | Graph/rules case. |
| `gps.route_inconsistent` | Pickup/route context, accepted locations, optional independent route/telemetry evidence. | Location trajectory cannot plausibly serve the committed trip. | Hold incentive acceleration; do not auto-charge or punish rider. | Review with trip evidence. |
| `account.shared_device` | Tokenised attestation/device ID, active session times. | Multiple driver accounts with overlapping active sessions on same trusted identifier. | Block concurrent activation. | Identity re-verification case. |
| `account.shared_payout_or_vehicle` | Tokenised provider recipient / vehicle ID. | Multiple accounts share payout/vehicle without approved ownership link. | Freeze recipient changes and surge incentive eligibility. | Finance/compliance review. |
| `surge.coordinated_behavior` | Time/window H3 cell, offer/cancel/accept events. | Suspicious cluster of accounts enters/exits an H3 cell around surge quote events with correlated cancellation behaviour. | No automated customer fare changes. | Queue graph cluster for analyst review. |

Thresholds must be configuration records with `policy_version`, city/zone/service-class scope, author, reviewer, approved effective time, expiry/review time, and offline evaluation evidence. They must not be hard-coded in clients. The low-confidence case should prefer a benign `review_required` / step-up outcome to reduce false positives.

### 3.4 Feature, graph, and model layer

The Python asynchronous service calculates versioned time-window features rather than making live irreversible decisions. Location features include speed, acceleration, heading change, source-time drift, accuracy distribution, H3 entropy, H3 dwell/discontinuity, cell-crossing frequency, cellular/network transition agreement where lawfully available, and event replay rate. Surge features include quote/offer acceptance/cancellation timing, distance to surge boundary, peer-normalised behaviour, and incentive claim rate.

The relationship graph has tokenised nodes for driver accounts, rider accounts, device/attestation IDs, vehicle IDs, payout recipient IDs, verified document fingerprints, optional coarsened network tokens, and event clusters. Edges carry relationship type, first/last seen time, evidence count, confidence, and retention class. The model should rank analyst queues using calibrated and monitored anomaly/graph features; it must not replace deterministic physical-impossibility checks, provider verification, or human review.

Models require a pre-deployment test set, temporal validation, class-imbalance controls, false-positive/false-negative reporting, drift alerting, explainability feature output, threshold approval, rollback version, and monthly/beta-stage fairness review. Each scored action stores the policy and model versions, input feature snapshot ID, anonymised evidence references, and reviewer override/appeal outcome.

### 3.5 Decision policy and operational actions

| Risk tier | Automated action | Never automated from model score alone | Required review |
|---|---|---|---|
| Low | Allow service; retain minimised evidence and normal sampling. | Suspension, payout withholding. | No review unless repeat pattern. |
| Medium | Step-up integrity refresh at next safe point; increase sample rate; flag for delayed review if repeated. | Passenger cancellation, financial penalty. | Review on repeat. |
| High | Freeze payout-recipient change; hold incentive payout; limit high-risk surge offer priority within approved policy; create case. | Permanent suspension/non-payment. | Analyst review before adverse account decision. |
| Critical deterministic safety event | Temporarily make driver unavailable through the durable eligibility path; preserve evidence. | Automatic permanent deactivation. | Safety analyst review and appeal route on expedited clock. |

If the graph/model pipeline is unavailable, deterministic event checks and the durable assignment/payment protections continue. The platform must emit a `fraud_pipeline_degraded` alert, create an operational ticket, and route uncertain events to `review_required`; it must never invent a risk score or silently auto-clear a high-risk case.

### 3.6 Monitoring and acceptance criteria

The fraud pipeline should report event lag, duplicate/replay rejection rate, rule latency, queue depth and age, location-event acceptance ratio, cache projection lag, model score distribution, analyst backlog age, step-up completion rate, appeal overturn rate, false-positive rate, payout hold amount/age, H3 cluster anomaly rate, and model-data drift. Run a weekly review in the private beta and a formal monthly governance review before scale expansion.

Acceptance tests must prove: duplicate event idempotency; stale event rejection; impossible-motion and mock-attestation routing; no Redis-only eligibility decision; degraded model path preserves deterministic safeguards; payout holds post only once; reviewer override/audit/appeal persistence; and deletion/retention workflow for approved privacy requests.

## 4. Independent clean-room logistics capability roadmap

Fleetbase’s public materials can be used only as high-level category awareness. The platform will deliver original functionality under independent requirements, API contracts, data models, naming, visual design, and test assets. It will not reproduce Fleetbase source code, endpoints, extension APIs, UX, docs, schema, brand, or behaviour. Fleetbase describes its public repository under AGPL-3.0 and provides a separate commercial alternative; legal counsel should validate any proposed interaction.[2] [3]

| Original capability programme | Current DeliveryPlatform state | Planned independent work | Release criterion |
|---|---|---|---|
| Operations work management | Implemented: tenant zones, jobs/stops, state policy, events, tracking positions, subscriptions, durable retries, authenticated TypeScript workspace. | Workflow-definition authoring, version review/approval, template import/export, and operator audit UI. | All changes are tenant-scoped, versioned, authorised, and integration-tested. |
| Live location and mapping | Implemented: PostGIS tracking stores plus Redis GEO/H3 acceleration. | Original map workspace, viewport query API, privacy-preserving playback, geofence/dwell events, and map-tile/routing provider abstraction. | Map never exposes unauthorised tenant/personnel locations; fallback and cost quotas tested. |
| Dispatch and route intelligence | Implemented: Go H3/Redis/PostGIS matching and Rust dispatch/pricing primitives. | Independent ETA/routing adapter, multi-stop constraints, capacity/skills/equipment matching, explainable manual override, and simulation tooling. | All assignments retain durable explanations, fairness/safety policy, and replayable decisions. |
| Partner/API integration | Implemented: authenticated central APIs and signed durable outbound HTTPS events. | Original API-key/OIDC client registration, scoped authorisation, OpenAPI documentation, schema-version registry, inbound partner webhooks, and developer sandbox. | Key rotation, replay protection, quota, and signature test suite pass. |
| Telematics and device integrity | Implemented: durable driver location event stream and current device-session sequencing. | Original mobile/hardware adapters, device lifecycle, attestation/device binding, consent, offline retry, and support tooling. | Device loss, replay, spoofing, consent, and retention tests pass. |
| Planning and optimisation | Existing Rust pricing/dispatch and Python forecasting/procurement services. | Original time-window/capacity planner, demand/supply forecast actions, scenario comparisons, and operator approval workflow. | Forecast/action provenance, rollback, and no synthetic fallback data. |
| Analytics and reporting | Existing analytics/control surfaces. | Original configurable dashboard widgets, scheduled governed report exports, SLA/performance reporting, and data quality controls. | All metrics trace to documented durable sources and freshness checks. |
| Mobile stakeholder experiences | Existing delivery/driver components and PWA foundation. | Original passenger, driver, dispatcher, merchant, and partner journeys with offline/safety/accessibility support. | End-to-end real APIs, accessibility and device test matrix, no mock live data. |
| Financial operations | Implemented payment webhook, ledger, payout controls. | Original invoicing/reconciliation console, dispute workflows, client statements, tax configuration governance, and provider failover. | Balanced ledger, replay-safe settlement, and auditor/export evidence. |

## References

[1]: https://ndpc.gov.ng/wp-content/uploads/2025/07/NDP-ACT-GAID-2025-MARCH-20TH.pdf "Nigeria Data Protection Commission: Nigeria Data Protection Act General Application and Implementation Directive"
[2]: https://github.com/fleetbase/fleetbase/blob/main/LICENSE.md "Fleetbase repository licence: GNU Affero General Public License v3.0"
[3]: https://github.com/fleetbase/fleetbase#license--copyright "Fleetbase public licensing overview"
