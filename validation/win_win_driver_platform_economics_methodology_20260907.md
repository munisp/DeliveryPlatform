# Win-Win Driver and Platform Economics Methodology

**Author:** Manus AI
**As of:** 2026-09-07
**Basis:** The current source implements a 15.00% maximum commission, full offer economics/destination disclosure, pickup limits, and non-punitive reason-coded declines. The framework below is a **proposed pricing and operating methodology**; it is not live pricing logic, a profitability forecast, a financial guarantee, or individualized financial advice.

## Objective and non-negotiable rule

The platform should only dispatch a trip when three conditions can be met at the same time: the rider sees a transparent price, the driver sees a transparent and economically viable pre-trip offer, and the platform earns a positive, explicitly measured contribution after variable operating costs and any stated subsidy. If one condition fails, the appropriate action is not to hide information or force acceptance. It is to reprice transparently, reduce the pickup burden, consolidate demand, defer the trip, offer a scheduled/batched alternative, or decline to dispatch.

> **A platform fee is economically legitimate only when the driver can see it, the rider price remains credible, and the residual contribution covers the platform’s verified cost to deliver the service.**

## The per-trip contribution model

Every driver-facing offer should be evaluated in minor currency units with an immutable quote/disclosure snapshot. Use the following definitions.

| Variable | Definition | Data source / control |
|---|---|---|
| `F` | Rider quote before statutory pass-throughs | Versioned quote engine with quote expiry and audit snapshot |
| `T` | Taxes, regulated fees, tolls, and other pass-throughs | Jurisdiction rule table; display separately and never include in platform commission base |
| `E = F − T` | Commissionable/allocable trip revenue | Derived in the pricing transaction |
| `D_min` | Minimum economically viable driver proceeds for this offer | Published zone policy, driven by approved active-time, distance, and empty-pickup cost assumptions |
| `C_var` | Incremental platform cost: payment processing, maps/communications, support allocation, insurance/risk reserve, incentive funding, and chargeback/cancellation exposure | Finance-approved cost model with dated component versions |
| `CM_target` | Minimum positive platform contribution target | Board/management-approved policy by zone, product, and time band |
| `P` | Platform fee retained from `E` | `0 ≤ P ≤ 0.15 × E` in the current implemented cap |
| `S_pickup` | Explicit platform-funded pickup subsidy, if any | Quote/disclosure snapshot; never hidden in the commission rate |
| `D` | Expected pre-trip driver proceeds | `D = E − P + S_pickup` |
| `CM` | Platform contribution after variable costs and subsidy | `CM = E − D − C_var = P − S_pickup − C_var` |

A trip is economically eligible only if:

```text
D ≥ D_min
CM ≥ CM_target
P ≤ 15.00% × E
```

If `E + S_pickup` cannot satisfy the driver floor, variable cost, and contribution target beneath the published commission cap, the system must not solve the gap by hiding the destination, increasing the fee beyond its cap, or penalizing a decline. It should use a disclosed rider-fare adjustment within consumer-protection limits, a specific platform-funded subsidy budget, shorter pickup matching, batching/scheduled fulfillment, or a no-dispatch outcome.

## Dynamic fare and split methodology

### 1. Cost-aware rider quote

Calculate a transparent zone/product quote from durable, reviewable components:

```text
F = base
  + route_distance_component
  + route_time_component
  + pickup_compensation_component
  + supply_demand_component
  + disclosed_tolls_and_statutory_pass_throughs
```

The pickup component is essential. The video described a long pickup for a low-fare trip as a source of driver losses; the model must either compensate the empty leg or prevent the match once policy pickup limits are exceeded.[1] A demand/supply component may respond to aggregate zone-level conditions, but should be bounded by published multiplier/currency ceilings, expire quickly, and be shown in the rider quote before booking.

### 2. Driver floor first, not commission first

Calculate a driver floor from expected total productive time and vehicle movement, including the predicted empty pickup leg:

```text
D_min = active_time_floor × (pickup_minutes + trip_minutes)
      + distance_floor × (pickup_km + trip_km)
      + approved_vehicle_cost_adjustment
```

`approved_vehicle_cost_adjustment` can differ only by published vehicle/product category, not by a driver’s willingness to accept low-value work, decline history, protected characteristic, or opaque score. It should be recalibrated after independent finance review using observable fuel, maintenance, insurance, and vehicle-access costs. The National Bureau of Statistics’ monthly Transport Fare Watch is one example of a public baseline series for contextual review; it covers city, intercity, motorcycle, water, and air transport measures, but is too low-frequency to be a real-time pricing feed.[2] [3]

### 3. Platform fee as a residual inside an approved corridor

After computing `D_min`, select the platform fee in a corridor rather than using a static percentage for every situation:

```text
P_max      = min(E + S_pickup − D_min, 0.15 × E)
P_target   = C_var + CM_target + S_pickup
P          = P_target, only when P_target ≤ P_max
D          = E − P + S_pickup
CM         = E − D − C_var = P − S_pickup − C_var
```

The dispatcher can proceed only if `D ≥ D_min` and `CM ≥ CM_target`. This avoids the false promise that a lower percentage is automatically sustainable: a very low fare may fail platform contribution even at a low take rate, while a high fare may support a lower percentage or a driver pickup subsidy. Every selected `P`, `D`, `C_var` version, subsidy, and eligibility decision must be placed into the immutable offer/settlement evidence chain.

### 4. Explicit subsidy and utilization levers

When a strategically important corridor cannot meet both floors, the platform may use a budgeted `S_pickup`; its source and maximum must be visible in the unit-economics ledger. Funding it from a broad opaque reduction in driver share defeats the purpose. More durable levers are pooled/scheduled rides, repeat-corridor matching, business contracts with minimum-volume commitments, rider subscriptions, return-trip pairing, vehicle maintenance purchasing, and a verified low-cost vehicle-access program. These improve utilization or reduce cost; they should not be represented as a fare split if the driver does not receive their benefit.

## Dynamic signals and update frequencies

| Signal | Recommended cadence | How it may influence the model | Prohibited use |
|---|---|---|---|
| Observed pickup/trip ETA and distance | Per quote, from the verified route provider | `D_min`, pickup ceiling, rider time component | Falsifying ETA or using an unreviewed route estimate as a fee justification |
| Aggregate supply/demand ratio and queue age | 5–15 minutes by zone | Bounded supply-demand adjustment and dispatch pacing | Individual driver punishment or post-decline discrimination |
| Fuel and maintenance cost index | Weekly; emergency override only with formal approval | Vehicle-cost adjustment and zone fare-floor review | Opaque real-time surcharge without a public component label |
| Payment, support, mapping, and risk costs | Monthly finance close | `C_var`, `CM_target` review | Passing through unverified costs as taxes/fees |
| Decline-reason distribution and pickup loss rate | Daily/weekly | Policy pickup cap, fare floor, zone service design | Automatic suspension, rating reduction, or eligibility change |
| Public transport/fuel benchmark series | Monthly/quarterly context | Policy calibration and customer-affordability review | Real-time quote input, because of reporting lag |

## Governance and customer/driver protection

A two-key change process should be required: finance proposes a dated cost/policy version; operations and an authorized product/compliance approver publish it. The current implementation already requires an administrator to publish a versioned per-zone dispatch policy and persists its version in each offer disclosure. The proposed extension should retain that property and add a pricing-policy effective time, change ticket/reference, impact simulation, rollback state, and per-zone maximum multiplier.

The system should publish the rider quote components and driver offer components before acceptance. It should emit daily metrics for driver net per active hour, driver net per total kilometer, pickup-to-trip distance ratio, paid-trip acceptance, decline reasons, rider cancellation, completed-trip contribution, subsidy use, dispute rate, and policy-version changes. Monitor distributions by zone/time/product and only use protected and lawful operational segmentation. Human review is required for persistent deterioration, policy changes, or any safety-linked decline pattern.

## Vehicle-access linkage

The vehicle-access module must remain a separate contract. Its `price_snapshot` contains weekly vehicle price, deposit, included kilometers, and excess-kilometer terms. A driver who uses a vehicle-access asset should see a separate weekly affordability statement built from realized—not promised—earnings, vehicle contract terms, maintenance/insurance responsibilities, and any optional fleet incentive. A ride offer must never implicitly deduct weekly vehicle rent, deposit, or repair cost. The platform should not issue credit or guarantee affordability without the required lending, insurance, and jurisdiction-specific review.

## Phased measurement plan

| Phase | Scope | Success test | Stop condition |
|---|---|---|---|
| Shadow calculation | Compute `D_min`, `CM`, and pickup subsidy on historical completed trips; do not alter quotes | Formula reconciliation to settlement and no unexplained negative contribution | Missing cost data, inconsistent settlement, or privacy governance gap |
| Operator review | Per-zone policy dashboard and manual approval | Every published policy has bounded caps, reason, version, and rollback record | Commission/pickup change cannot be explained to driver and rider |
| Limited transparent pilot | One city/zone/product with full disclosure and decline protection | No opaque acceptances; measured driver/consumer outcomes improve without negative contribution breach | Safety, payment, material complaint, or policy-invariant breach |
| Controlled expansion | Independent control group and pre-registered measurement | Sustained contribution and driver outcomes, with reviewed data quality | Unreviewed expansion, hidden policy change, or segment harm signal |

## Sources and evidence limits

The linked video is the source for the stated complaints about high commission, hidden destination, long pickup burden, and punishment for cancellation; it is not independent market measurement.[1] The National Bureau of Statistics documents Transport Fare Watch as a recurring series, and the March 2026 catalog entry identifies a monthly time series from January 2016 through March 2026.[2] [3]

This is research and operating-methodology analysis only, not personalized financial advice.

## References

[1] [User-provided video: analysis of Nigerian driver complaints](https://youtu.be/wifB9kytBBY?si=cddqf7lQ6jc2apCS)

[2] [Nigeria National Bureau of Statistics: Transport Fare Watch, May 2023](https://www.nigerianstat.gov.ng/elibrary/read/1241346)

[3] [Transport Fare Watch, March 2026 catalog entry, sourced to Nigeria National Bureau of Statistics](https://nigeria.opendataforafrica.org/xyzrrzd/transport-fare-watch)
