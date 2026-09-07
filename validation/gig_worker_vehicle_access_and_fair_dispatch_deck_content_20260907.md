# Gig-Worker Vehicle Access and Fair Dispatch

## Cover

**Gig-Worker Vehicle Access & Fair Dispatch**

A clean-room architecture for transparent offers, safe vehicle access, and positive contribution economics

2026-09-07

## Slide 1

### The operating problem: hidden economics destroy supply trust

- The user-provided video describes high commission, long low-value pickup, hidden destination, and punitive cancellation as reasons drivers leave platforms.[1]
- A transparent platform must make each trip economically legible before acceptance.
- The correct response to an unviable trip is reprice, shorten pickup, subsidize transparently, batch/schedule, or do not dispatch.

## Slide 2

### Vehicle access makes productive assets available safely

- A managed, inspected asset can help a verified worker access passenger, delivery, courier, and field-service work.
- PostgreSQL is authoritative for provider, asset, evidence, offer, contract, inspection, event, and outbox state.
- Vehicle contract terms are snapshotted; ride payments remain entirely separate.

## Slide 3

### Contract and asset states prevent unsafe allocation

- Asset activation requires five evidence categories: registration, roadworthiness, commercial cover, ownership authority, and inspection.
- One asset cannot have overlapping approved, active, or return-pending contracts.
- Handover and return require immutable inspection evidence; suspension moves the asset into a safety hold and controlled return.

## Slide 4

### Fair offers are transparent before acceptance

- The dispatch policy stores a maximum 15.00% platform commission and bounded pickup distance/ETA by zone.
- An offer disclosure persists full destination, route burden, gross fare, taxes/fees, commission, and expected driver proceeds.
- A database trigger rejects an attempt to accept an opaque offer.

## Slide 5

### A fair decline restores availability, not punishment

- The worker can decline with a constrained operational reason: pickup economics, fare, destination, safety, vehicle constraint, or other.
- The database verifies offer ownership, locks the offer, writes one immutable decline record, and restores driver availability.
- The decline transition does not mutate rating, account state, safety state, or driver eligibility.

## Slide 6

### Win-win economics starts with two hard floors

- **Driver floor:** expected proceeds must cover published active-time, distance, pickup, and vehicle-category costs.
- **Platform floor:** contribution after driver proceeds, explicit subsidy, and verified variable cost must be positive.
- The maximum commission cap is a guardrail; it is not a universal profit guarantee.

## Slide 7

### Dynamic prices should be observable, bounded, and explained

- Quote components: base, route distance/time, pickup compensation, bounded supply-demand adjustment, and disclosed pass-throughs.
- Inputs update at appropriate frequencies: route at quote time; zone supply 5–15 minutes; finance cost model monthly; public transport benchmarks only for periodic calibration.[2] [3]
- Never vary prices or eligibility based on an individual worker’s prior decline history or opaque scoring.

## Slide 8

### Pick the fee only after protecting driver economics

- `E = rider quote − pass-throughs`; `D = E − platform fee + pickup subsidy`.
- Dispatch only when `D ≥ driver floor`, platform contribution meets its target, and fee remains within the published cap.
- If the equation fails, use a disclosed subsidy, reprice within limits, reduce pickup, batch/schedule, or decline the trip.

## Slide 9

### Governance keeps dynamic policy credible

- Finance proposes dated cost versions; operations and authorized approval publish versioned zone policies with rollback.
- Measure pickup-to-trip ratio, driver net per active hour/kilometre, decline reasons, rider cancellation, contribution, subsidy, disputes, and policy changes.
- Test in shadow mode first; expand only after settlement reconciliation, data-quality, safety, and affordability review.

## Slide 10

### Implementation status and evidence boundary

- Implemented locally: migrations `0050` and `0051`, PostgreSQL restricted functions, matching-worker enforcement, authenticated application routes, driver/operator interfaces, and disposable validation.
- Local checks: 45 test files / 222 tests passed; TypeScript, production build, Go race test, schema validator, and visual route smoke check passed.
- Not production evidence: regulatory/insurance approval, real vehicles, live payment/payout, real routing accuracy, user acceptance, or commercial economics.

## Slide 11

### Decision: build trust as an operating advantage

- Keep vehicle access, dispatch offers, and payment settlement as separate authoritative domains.
- Compete on transparent choice, a credible driver floor, operational efficiency, and honest platform contribution.
- Begin with a controlled single-zone shadow calculation and reviewed policy—not a market-wide commission change.

## References

[1] [User-provided video: analysis of Nigerian driver complaints](https://youtu.be/wifB9kytBBY?si=cddqf7lQ6jc2apCS)

[2] [Nigeria National Bureau of Statistics: Transport Fare Watch, May 2023](https://www.nigerianstat.gov.ng/elibrary/read/1241346)

[3] [Transport Fare Watch, March 2026 catalog entry, sourced to Nigeria National Bureau of Statistics](https://nigeria.opendataforafrica.org/xyzrrzd/transport-fare-watch)
