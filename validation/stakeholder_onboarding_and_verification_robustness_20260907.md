# Stakeholder Onboarding and Verification Robustness Review

**Author:** Manus AI
**Date:** 2026-09-07
**Scope:** Source review of the DeliveryPlatform primary and isolated commerce worktrees. This document assesses implemented controls; it does not represent a completed background check on any person or organization.

## Summary Assessment

The platform has meaningful **internal eligibility, evidence, safety, and least-privilege controls** for ride, vehicle-access, field-service, and developer workflows. It does not yet have a production-connected identity/KYC/KYB, criminal-record, driving-record, insurance, sanctions, licence-registry, corporate-registry, or provider-of-record integration. Accordingly, stakeholder onboarding is internally controlled but **not sufficiently externally verified for an unconditional public deployment**.

> Background screening is consequential personal-data processing. It must be purpose-limited, consented where required, legally reviewed for the deployment jurisdiction, sourced from an approved provider, retention-limited, access-controlled, auditable, and subject to a correction/appeal process where applicable.

## Implemented Stakeholder Controls

| Stakeholder | Implemented internal controls | Robustness | Missing external or operational evidence |
|---|---|---|---|
| Rider/customer | Account lifecycle, authenticated access patterns, idempotent trip requests, safety incidents and share links. | Moderate internal control. | No external identity-verification provider integration or consumer-risk workflow evidenced. |
| Driver/gig worker | Active `driver_profile`, active vehicle, current `driver_eligibility`, location-integrity threshold, transparent pre-acceptance economics, non-punitive reason-coded decline, safety controls. | Strong dispatch-time gate. | No driving-licence, criminal-record, identity, sanctions, right-to-work, commercial insurance, or live vehicle-registry verification provider connected. |
| Vehicle-access worker | Operator-created eligibility record with work categories/expiry; contract requests enforce verified/non-expired category; inspection and contract evidence. | Strong internal workflow gate. | Eligibility evidence is operator-attested; no external employment, identity, credit, insurance, or driving-record attestation. |
| Vehicle/fleet provider | Operator-controlled provider/asset intake, required document hashes, inspection, roadworthiness, ownership authority, commercial cover, maintenance/suspension state. | Strong evidence and lifecycle controls. | Document evidence is not verified against an insurer, registrar, lender, or inspection authority. |
| Field technician | Field-service technician, service area, appointment, proof, immutable evidence and provider-scoped work-order controls. | Moderate operational control. | No external trade-credential, employment, identity, or safety-screening adapter found. |
| Merchant/store | Medusa signed event ingress and DeliveryPlatform-authoritative fulfillment transition. | Moderate integration integrity. | No merchant/KYB, tax, beneficial-owner, or sanction-screening implementation found. |
| Developer/integration partner | One-time-show API secrets, hashed/scoped/revocable keys, idempotency, signed outbound webhooks, endpoint controls. | Strong technical access control. | No contractual/KYB onboarding or partner risk review workflow found. |
| Operator/administrator | Role-gated database security-definer transitions, protected API procedures, configured MFA requirement in production, audit/outbox records. | Strong authorization boundary. | No HR screening, privileged-access recertification cadence, or external identity provider assertion is validated by the reviewed source. |

## What the Source Enforces at Decision Time

Dispatch does not rely only on onboarding assertions. `mobility.create_transparent_driver_offer` checks current driver profile, active vehicle, `driver_eligibility`, location freshness/integrity, zone rules, active fairness policy, and active economics policy before it attempts a lease-like presence reservation. `vehicle_access.request_contract` rechecks worker eligibility, permitted category, expiry, active asset availability, effective offer, term bounds, and non-overlapping allocation. Vehicle activation requires valid registration, roadworthiness, commercial-cover, ownership-authority, and inspection evidence. These are robust **internal-state gates**.

The limits are equally material. A valid document hash proves which object was recorded, not that its contents are authentic, current, or issued by a recognized authority. An operator role check proves the workflow actor is authorized in the platform, not that the external fact being approved is accurate. A security-definer function can enforce integrity and least privilege but cannot independently perform real-world investigation.

## Required Production-Grade External Verification Extension

For each selected external verifier, create a provider-specific adapter rather than a generic `background_check=true` flag. The adapter must use the provider’s approved sandbox and current contract, capture consent/reference/purpose/retention metadata, validate callback signatures over raw bytes, store provider and transaction identifiers, use idempotent inbox/outbox records, retain non-secret decision evidence, time out and retry safely, quarantine ambiguous results, and allow authorized human review/appeal. The external adapter must only propose an evidence status; PostgreSQL transition functions remain the final authority for eligibility, suspension, and reactivation.

A complete rollout needs a jurisdiction-specific data-protection impact assessment, terms/consent wording, retention/deletion policy, vendor due diligence, access review, fraud/appeal procedures, incident response, and a controlled provider sandbox test. None of those can be truthfully replaced by a local simulator.

## Current Readiness Conclusion

The platform is robust at **enforcing internal states once trusted evidence is recorded**, but it is not yet robust enough to claim verified onboarding or background investigation of all stakeholders. The high-priority gap is not another unrestricted database role or client-side form; it is a lawful, provider-specific verification architecture and operating process connected to selected jurisdictions and counterparties.
