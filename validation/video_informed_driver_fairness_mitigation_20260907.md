# Video-Informed Driver Fairness Mitigation

**Author:** Manus AI
**Date:** 2026-09-07
**Scope:** Isolated `feature/commerce-field-developer` worktree only. This document describes a clean-room platform implementation and does not imply any connection, partnership, certification, or code derivation involving Uber, Bolt, Turo, inDrive, or the video publisher.

## Verified problem statement

The linked video describes Nigerian e-hailing drivers leaving platforms because they perceive commissions of 25–30% as unsustainable, receive long low-value pickup offers, are not shown enough trip information before acceptance, and risk suspension after declining or cancelling uneconomic work. The speaker’s illustrative example is a 5 km, 12–14 minute pickup for an approximately ₦4,000 fare. These are statements made in the video, not independently audited market data.[1]

| Video-described problem | Implemented platform response | Boundary |
|---|---|---|
| Commission perceived as 25–30% | A versioned per-zone policy hard-caps `platform_commission_bp` at 1,500 (15.00%). The exact commission is snapshotted on every offer. | This cap is software enforcement, not a guarantee of an economically viable price in every city or vehicle class. |
| Long, uneconomic pickup | Each policy sets hard offer-issuance ceilings for pickup distance (250–5,000 m) and ETA (60–1,200 s). Offers above a zone’s live cap are not issued. | A cap requires reviewed per-zone operating parameters and accurate routing data. |
| Destination hidden until after acceptance | Every offer records and exposes the full destination address, destination distance, and duration before acceptance. A database trigger blocks acceptance without a disclosure. | The product must apply privacy, safety, and precise-location minimization policies before any live rollout. |
| Punitive cancellation/account blocking | A bounded reason-coded decline returns driver presence to `available`, records append-only evidence, and deliberately does not mutate account status, safety state, rating, or driver eligibility. | A decline is not a substitute for emergency response or fraud/safety processes based on separate evidence. |
| No visible economic breakdown | The driver sees gross rider fare, taxes/fees, commission rate and amount, and expected pre-trip driver proceeds. | Expected proceeds are a disclosure, not a payment or final settlement promise. |

## Implemented authoritative controls

Migration `drizzle/0051_driver_dispatch_fairness.sql` adds the following PostgreSQL-authoritative structures and functions.

| Object | Purpose |
|---|---|
| `mobility.driver_dispatch_fairness_policy` | Versioned, zone-specific commission and pickup caps. Only an administrator recognized by `public.users.role = 'admin'` can publish a policy through a security-definer function. |
| `mobility.driver_offer_disclosure` | Immutable offer record containing pickup effort, full destination, fare components, policy version, commission, and computed expected driver net. A check constraint recomputes the net from stored components. |
| `mobility.require_driver_offer_disclosure_before_accept` | A `BEFORE UPDATE` trigger that raises `23514` if an opaque pending offer is moved to `accepted`. |
| `mobility.create_transparent_driver_offer` | Invoked by the Go matching worker. It loads the trip/quote, selects a live policy, rejects excessive pickup distance/ETA, retains existing driver-location integrity and eligibility conditions, atomically reserves one available driver using `FOR UPDATE ... SKIP LOCKED`, inserts the offer and disclosure, and returns an issuance reason. |
| `mobility.driver_offer_decline` | Immutable reason-coded evidence, including a persisted `rematch_required` decision to make idempotent retries return the original outcome. |
| `mobility.decline_driver_offer_fairly` | Locks only the driver’s offer, rejects cross-driver action, changes `pending → declined`, restores `offer_pending → available`, writes one outbox event, and fences off duplicate requests with the original idempotency key. It does not change driver punishment-related state. |

The Go worker no longer creates a driver offer through a direct CTE. It calls `mobility.create_transparent_driver_offer(...)` inside the existing match transaction and passes the previously configured `LocationMinIntegrity` value into the function. This preserves the old integrity safeguard while adding policy and disclosure conditions. It also provides internal `GET /offers/disclosures?driver_user_id=…` and `POST /offers/decline` endpoints, both protected by the existing internal service token. The central application adds an authenticated tRPC router that binds offer reads and declines to `ctx.user.id`; only the protected operator procedure can publish a policy, and the database repeats the admin check.

The routed `/driver-offers` workspace shows pending offers to the authenticated driver with pickup burden, full destination, trip distance/duration, gross fare, taxes/fees, commission, expected proceeds, a pre-trip disclosure warning, and reason-coded decline buttons. It also includes an operator policy form. The browser interface is not the authorization boundary: the router and database verify the caller again.

## Business model and operating design

> The business objective is not to force low-cost work acceptance. It is to offer a transparent marketplace in which a driver can evaluate the expected economics and choose.

The appropriate commercial model is a **transparent matching fee**: publish a clear maximum commission in a zone policy; show its amount per offer; do not recover the fee through hidden compulsory driver charges; and retain a separately approved price-change process. A low-cost used-vehicle access contract, when applicable, remains a separate weekly vehicle-access agreement with its own snapshot price and evidence. It must not be silently deducted from a ride offer or used to bypass payment reconciliation.

Drivers may decline uneconomic work without automatic account or eligibility mutation. Operations should aggregate the immutable decline reasons by zone, time band, pickup distance, and policy version to identify where the fare rule, pickup radius, or supply balancing needs review. A high rate of `pickup_distance_unprofitable` is a dispatch/fare-policy signal, not proof of misconduct.

## Rollout and unresolved operational controls

The migration deliberately rejects acceptance of existing opaque pending offers. A safe rollout therefore requires dispatch to be paused, pre-existing pending offers to expire or be withdrawn/reissued through the transparent function, migration `0051` to be applied by the DDL identity, the token-authorized Go worker and central application to be deployed, at least one approved fairness policy to be inserted for every dispatch-enabled zone, and only then dispatch to be re-enabled. Deploying the migration before a live policy is configured fails closed: it declines to issue new offers rather than issue hidden-economics offers.

The following remain external operating requirements, not completed by source code: independent pricing and unit-economics review; consumer/driver contract and employment-status review; insurance and commercial-use compliance; legal review of destination disclosure and sensitive-location minimization; customer support and appeals; data retention and subject-access operations; real routing/ETA quality validation; payment authorization, payout, and reconciliation testing; metrics/alerts for policy availability, transparent-offer issuance, decline reason distribution, and fare discrepancies; and controlled staging/canary deployment. No production, staging, payment, vehicle, driver, or external platform was accessed or altered.

## Local validation evidence

The disposable PostgreSQL/PostGIS validator applied `0026_ride_hailing_dispatch.sql` and `0051_driver_dispatch_fairness.sql` to a uniquely named local database and confirmed the expected driver economics (`₦20,000` gross, `₦2,000` taxes/fees, `12.00%` commission, `₦2,160` commission, `₦15,840` expected proceeds). It confirmed an excess-pickup candidate was rejected, an opaque offer could not be accepted, a fair decline restored the driver to `available`, driver account/safety/eligibility state stayed `active`/`clear`/eligible, duplicate decline retry preserved the original `rematch_required` decision and emitted one outbox event, and an untrusted role could not read disclosures.

The focused TypeScript source-integration suite, TypeScript compiler, production bundle, Go race tests, shell syntax check, and database validator were run locally. This evidence validates source behavior only with disposable resources; it is not production capacity, market economics, routing accuracy, regulatory approval, or live user experience evidence.

## References

[1] [User-provided video: analysis of Nigerian driver complaints](https://youtu.be/wifB9kytBBY?si=cddqf7lQ6jc2apCS)

## Visual smoke check

The production-built application was served locally with a temporary preview-only host allowlist. The `/driver-offers` route rendered the driver-choice heading, the three zero-state metrics, the pre-trip disclosure notice, and the protected policy form through the sandbox proxy. The static preview intentionally did not include the API server or an authenticated session, so it showed the expected loading state and did not validate a live tRPC response or policy mutation. The temporary preview configuration was outside the repository and was removed after the check.
