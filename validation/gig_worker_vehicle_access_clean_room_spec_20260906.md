# Clean-Room Gig-Worker Vehicle Access: Business and Technical Specification

**Date:** 2026-09-06

## Request interpreted

The proposed product is **not a direct Turo integration**. It is an independently built, low-cost used-vehicle access service for verified gig workers who need a compliant vehicle to conduct ride-hailing, delivery, courier, and field-service work. The platform should combine vehicle supply, worker verification, scheduled access, inspection evidence, telematics consent, maintenance controls, and a controlled connection to the existing DeliveryPlatform driver eligibility and trip-dispatch features.

The intended user journey is: a worker is verified for a permitted work category; selects a low-cost used vehicle that is commercially eligible in the operating market; accepts clear terms, insurance/protection, mileage, pricing, and deposit rules; completes verified handover; uses the vehicle for authorized work; returns it with evidence; and receives a final reconciled charge/credit record. This is a **vehicle-access marketplace or managed fleet product**, not a consumer peer-to-peer recreation and not a Turo partnership.

## Public Turo observations used as product-neutral inputs

Turo publicly describes an app-based vehicle marketplace with local vehicle providers, booking, pickup/delivery, host communication, driver approval, protection options, roadside assistance, and vehicle/host reviews.[1] It also advertises vehicle rental for professional delivery work, including longer rentals and delivery/pickup convenience, but places location-specific restrictions on professional use.[2] Its published professional-use policy identifies consequences for violating prohibited-location rules, including suspension/removal and loss of protection for vehicle damage.[3]

Its public material also describes remote access patterns, pre/post-trip evidence, licence confirmation, GPS/telematics disclosure, and consent constraints for interior cameras/audio.[4] [5] [6] Its U.S. vehicle-listing rules show the kinds of controls a vehicle-access marketplace may need—legal registration, mechanical/safety standards, title history, age/mileage conditions, and policy-specific tracking—but those numerical thresholds are **Turo’s policies, not this platform’s policy**.[7]

> The design must be independently authored. Public business behaviors can inform requirements, but no Turo source code, private APIs, copied product copy, hidden workflow, or claim of partnership is used or proposed.

## Business model choices

The product should start with a deliberately narrower service than a broad consumer marketplace. “Low-cost” must be measured transparently as an all-in weekly or monthly cost, including approved mileage, protection/insurance charge, deposit/hold policy, taxes, scheduled maintenance allocation, pickup/delivery, and late/damage fees. A headline day rate alone is not a meaningful affordability metric for gig workers.

| Approach | Tradeoffs | Cost | Setup complexity |
|---|---|---|---|
| **Managed starter fleet**: platform or approved fleet partners supply inspected used cars under standard weekly work-access terms | Strongest consistency over maintenance, commercial eligibility, telematics, and handover. Requires vehicle capital, operations staff, insurance/protection arrangement, and repairs. | High supply capital and operating cost; predictable terms for workers. | High, but the safest private-beta starting point. |
| **Curated owner/fleet marketplace**: approved owners list commercially eligible used vehicles to verified workers | Asset-light and can expand supply faster. Requires owner verification, payout controls, standardized inspection, disputes, quality enforcement, and stronger insurance/legal operations. | Lower direct vehicle capital; higher marketplace risk/operations cost. | High; should follow a successful managed-fleet pilot. |
| **Lease-to-own or financed vehicle programme** | Can create long-term worker asset ownership. It introduces credit, consumer-lending, repossession, collections, affordability, and jurisdiction-specific regulatory responsibilities. | Potentially high loss/servicing cost. | Very high; exclude from the initial platform scope until separately licensed, capitalized, and governed. |

The first two approaches can coexist later, but they should use the same authoritative asset, inspection, contract, safety, and event model. The financing approach must remain a separate regulated product rather than a shortcut within ride earnings or dispatch logic.

## Product scope for a private beta

### Worker-facing capability

A verified worker needs to discover only vehicles that are eligible for their declared work category and location. The vehicle listing should show the all-in price breakdown, allowed work categories, included mileage, excess mileage rate, minimum term, deposit/hold terms, pickup geography, required documents, vehicle condition grade, availability, and support/roadside boundaries. The worker should be able to reserve, extend, report damage or breakdown, complete pickup/return checklists, view a redacted inspection record, and see itemized charges after reconciliation.

### Vehicle-provider and operations capability

An owner or fleet operator must register a vehicle, prove authority to offer it, attach registration/inspection/insurance/commercial-use evidence, declare the work categories it supports, set availability and price rules, record maintenance and recalls, choose an approved handover method, and accept or reject only eligible worker requests. Operations staff need exception queues for document expiry, failed inspection, safety hold, late return, geofence/telematics alert, breakdown, damage claim, and vehicle-recovery escalation. No direct mutable-table access should be granted to these user roles.

### Ride-hailing and delivery connection

The existing primary worktree already contains a PostgreSQL/PostGIS `mobility.vehicle` model, `mobility.driver_profile`, compliance evidence, and `mobility.driver_eligibility` projection. The vehicle-access module should **not replace** those objects or write payment state from a vehicle booking. Instead, a completed eligibility check may project an active access-contract vehicle into the driver eligibility workflow; expiry, suspension, recall, or unresolved damage must remove that eligibility through a restricted transition. Trip dispatch and payment remain governed by their own state machines and financial controls.

| Existing capability | Reuse boundary | New clean-room capability required |
|---|---|---|
| `mobility.driver_profile` and compliance evidence | Reuse verified worker identity and commercial-driver eligibility inputs. | Add work-category eligibility and contract-specific verification policy. |
| `mobility.vehicle` and active-vehicle eligibility projection | Reuse only as the final operational vehicle assigned to a driver for a trip. | Add asset ownership, fleet/provider authority, access contract, handover/return, inspection, maintenance, and pricing layers. |
| Driver device/location controls | Reuse safety and driver session principles. | Add vehicle telematics consent, device provenance, access-control commands, and retention policies. |
| Payment/settlement controls | Reuse reconciled, idempotent financial boundaries. | Add a distinct vehicle-access charge ledger/reference and provider payout reconciliation; never use ride trip funds as an implicit credit line. |
| Field-service work orders | Reuse operational workflow patterns for maintenance tasks. | Add vehicle-specific preventive maintenance, repair, recall, and immobilization states. |

## Proposed PostgreSQL-authoritative data model

Create a separate `vehicle_access` schema. PostgreSQL/PostGIS is the authority; Redis or telematics caches are accelerators only. A first migration sequence should include the following entities.

| Entity | Core fields and invariants |
|---|---|
| `fleet_provider` | Legal entity/owner profile, verified state, payout readiness, support contacts, and immutable verification events. One provider must be authorized before offering a vehicle. |
| `vehicle_asset` | VIN/hash, registration, make/model/year, odometer, ownership/authority state, commercial-use category, inspection state, maintenance state, immobilization state, and geospatial home/service areas. VIN and registration are uniquely constrained according to jurisdiction policy. |
| `vehicle_document_evidence` | Restricted storage reference, issuer, issue/expiry, verification decision, immutable digest, and revocation reason. It must cover registration, title/ownership authority, inspection, commercial insurance/protection, roadworthiness, and any market-specific permit. |
| `vehicle_offer` | Provider-owned price plan, currency, weekday/weekend/week/month rates, included mileage, excess rate, deposit/hold rule, minimum/maximum duration, allowed work categories, availability, and effective period. Historical price versions must remain immutable once booked. |
| `worker_vehicle_application` | Worker, requested offer, eligibility decision, risk/compliance decision, decision evidence, expiration, and idempotency key. It must not use opaque automated denial as the sole basis for an adverse decision. |
| `vehicle_access_contract` | Worker, asset, offer version, start/end, authorized work categories, state, price snapshot, pickup/return locations, extension/cancellation terms, and external financial references. One asset cannot have overlapping active contracts. |
| `handover_session` | Identity check state, pre-condition checklist, key/device access command reference, before/after odometer/fuel/charge, proof capture references, and who/what authorized release. No key code or raw credential is stored. |
| `asset_inspection` and `inspection_evidence` | Timestamped interior/exterior/odometer/fuel/charge condition, media object keys, SHA-256 digest, reviewer, and immutable event trail. |
| `vehicle_telematics_consent` and `vehicle_telematics_event` | Explicit notice/consent version, permitted purposes, device identity, received/observed time, location/odometer/diagnostic values, integrity signal, and retention policy. Interior video/audio must require explicit separate consent and jurisdiction review. |
| `maintenance_work_order` | Asset, defect/recall, severity, service provider, cost reference, immobilization requirement, state, and immutable event/outbox record. A safety-critical maintenance state blocks new handovers. |
| `vehicle_access_event` and `outbox_event` | Append-only transition evidence and bounded integration events. Event publishing must be idempotent and not mutate financial authority. |

## Required state machines

A vehicle should have an operational state separate from a worker contract. Suggested asset states are `intake`, `inspection_pending`, `available`, `reserved`, `handover_pending`, `active_access`, `return_pending`, `maintenance_hold`, `safety_hold`, `recovery_hold`, `retired`, and `disposed`. Suggested contract states are `application_pending`, `approved`, `reserved`, `handover_verified`, `active`, `extension_pending`, `return_inspection_pending`, `closed`, `cancelled`, `suspended`, `default_review`, and `disputed`.

The important rule is that **only restricted PostgreSQL transition functions** can change these states. Each transition must bind an actor, a policy version, an idempotency key where appropriate, preconditions, and an append-only event. For example, `handover_verified → active` requires a current driver approval, an eligible vehicle, valid contract, verified required documents, completed pre-inspection, confirmed location, and an approved access-release action. `active → suspended` must immediately propagate a driver-eligibility removal if the same vehicle is used for ride dispatch.

## Telematics and remote-access architecture

The platform should use vendor-neutral adapters for permitted OEM APIs, approved aftermarket devices, and secure lockbox/handover workflows. No device command should be directly exposed from a client application. The service must issue short-lived, scoped commands such as `unlock_for_handover` or `immobilize_when_parked`, record vendor request IDs and results, and apply strict human/operator approval for high-impact recovery actions.

Public Turo materials show the practical need for identity verification, time-bounded key release, vehicle condition evidence, remote access, and tracking disclosure.[4] [5] [6] For this platform, the requirements should be stricter: worker identity must be confirmed before access; an unlock action must be bound to a contract, verified location, and time window; telematics collection must be visible to the worker; interior audio/video must be disabled by default; and recovery actions require documented authority, legal review, and safety checks.

## Integration boundaries

There is no verified public Turo developer API or webhook contract in the reviewed official materials. Therefore the platform should not scrape Turo listings, automate Turo accounts, ingest unofficial Turo events, or claim an integration. Any future commercial partnership would require a written agreement and documented supported interface.

The independent vehicle-access module can integrate internally with DeliveryPlatform via signed, versioned outbox events, for example:

```text
vehicle_access.contract.activated
vehicle_access.contract.suspended
vehicle_access.asset.maintenance_hold
vehicle_access.inspection.completed
vehicle_access.contract.closed
```

A mobility consumer may use an `activated` event to run a restricted eligibility projection only after verifying that the worker, asset, policy, and commercial-use evidence meet local requirements. It must never use a vehicle-access event to mark ride payments settled, release funds, or bypass the payment webhook and settlement-reconciliation controls.

## Private-beta acceptance criteria

| Domain | Minimum evidence before limited launch |
|---|---|
| Commercial legality and protection | Jurisdiction-by-jurisdiction written legal, licensing, insurance/protection, tax, consumer terms, and data/privacy review. No inferred portability from Turo’s U.S. policy. |
| Asset quality | Documented intake inspection, title/authority proof, roadworthiness, recall check, scheduled maintenance, and clean vehicle-condition evidence for every vehicle. |
| Worker safety and access | Verified worker identity/licence/compliance, photographed handover/return, time/location-bound key release, support/roadside process, and recovery safeguards. |
| Financial integrity | Itemized contract price snapshots, authorization/hold and charge rules, dispute workflow, idempotent provider payout records, and no direct mutation of ride-payment authority. |
| Telematics privacy | Purpose limitation, notice/consent, retention/deletion schedule, access logs, interior-camera/audio controls, and regulatory review. |
| Platform resilience | Append-only evidence, SQL least privilege, idempotent outbox, signed webhook delivery, retry/dead-letter monitoring, backup/restore tests, and multi-worker load evidence. |

## Phased clean-room roadmap

| Phase | Scope | Explicitly excluded |
|---|---|---|
| P0: controlled managed-fleet pilot | Asset registry, document evidence, fixed weekly offers, verified worker application, contract/handover/return state machines, inspection evidence, maintenance holds, and manual operations review. | Lending, dynamic credit decisions, autonomous immobilization, public owner marketplace, and automated collections. |
| P1: ride/delivery eligibility connection | Restricted eligibility projection into `mobility.driver_eligibility`, safe telematics ingestion, provider payout reconciliation, contract extensions, operational dashboards, and dead-letter monitoring. | Unverified OEM commands, price discrimination, or ride-payment cross-subsidy. |
| P2: curated marketplace expansion | Approved third-party fleet/owner supply, price-versioning, availability, provider self-service, dispute console, and demand/supply analytics. | Direct Turo data integration, scraping, or a claim of feature parity. |
| P3: separately governed financial products | Only after legal, capital, underwriting, collections, and consumer-protection controls are independently approved. | Silent financing through driver earnings. |

## Evidence limits

This document is an independent product/technical specification, not legal, insurance, tax, or lending advice; it is not a readiness determination. The current codebase does not yet implement the `vehicle_access` schema, worker-access contracts, controlled key release, fleet operations, provider payout reconciliation, or dead-letter monitoring described above. These are proposed scoped increments, not completed features.

## References

[1] [Turo: How Turo works](https://turo.com/us/en/car-rental/united-states/how-turo-works)

[2] [Turo: Rent a car for delivery gigs](https://turo.com/us/en/car-rental/united-states/professional-use)

[3] [Turo Support: Professional uses policy](https://help.turo.com/en_us/professional-uses-policy-HJmiAoQfyg)

[4] [Turo Support: Vehicle tracking and technology policy](https://help.turo.com/tracking-and-technology-devices-SkF48Nl49)

[5] [Turo Support: Checking in a guest and checking out](https://help.turo.com/checking-in-a-guest-H1gsHEg4c)

[6] [Turo Support: Technology for remote vehicle access](https://help.turo.com/en_us/technology-for-contactless-vehicle-access-BycSSE_cn)

[7] [Turo Support: Vehicle eligibility in the United States](https://help.turo.com/en_us/vehicles-we-accept-rylmrNl45)
