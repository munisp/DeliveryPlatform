# Dynamic Driver-Earnings Economics: SQL, Test Cases, and Target Readiness

**Author:** Manus AI
**Date:** 2026-09-07
**Scope:** Clean-room, PostgreSQL-authoritative driver-offer economics in the isolated `feature/commerce-field-developer` worktree.

## Implementation Status

The dynamic driver-earnings floor and pickup-subsidy allocator is now implemented in forward-only migration `drizzle/0052_driver_offer_economics.sql`. The former methodology-only gap has been closed in source: the matching worker invokes the PostgreSQL function, the TypeScript service retrieves worker-scoped economics disclosure, the tRPC router exposes a protected policy publisher, and the driver workspace renders the published floor and allocated subsidy before acceptance.

The implementation is ready for a **controlled non-production target-environment test** after migration and preflight. It is not safe or appropriate to use write-test fixtures in production, and the preflight script requires `ECONOMICS_TEST_ENVIRONMENT=local` or `staging` rather than production.

## Exact Authoritative Calculation

The migration replaces `mobility.create_transparent_driver_offer` and calculates the allocation after it locks the trip, fare quote, effective fairness policy, and effective economics policy.

```sql
v_commission := ((v_quote.total_kobo - v_quote.taxes_and_fees_kobo)
                 * v_fairness.platform_commission_bp) / 10000;
v_base_driver_net := v_quote.total_kobo - v_quote.taxes_and_fees_kobo - v_commission;
v_total_minutes := CEIL((p_pickup_eta_s + v_quote.quoted_duration_s)::numeric / 60)::bigint;
v_total_km := CEIL((p_pickup_distance_m + v_quote.quoted_distance_m)::numeric / 1000)::bigint;
v_operating_index_bp := CEIL((v_economics.fuel_cost_index_bp::numeric
                              * v_economics.maintenance_cost_index_bp::numeric) / 10000)::integer;
v_driver_floor := CEIL((
  v_total_minutes * v_economics.driver_time_floor_kobo_per_min
  + v_total_km * v_economics.driver_distance_floor_kobo_per_km
)::numeric * v_operating_index_bp / 10000)::bigint;
v_pickup_subsidy_candidate := CEIL(p_pickup_distance_m::numeric / 1000)::bigint
                              * v_economics.pickup_subsidy_kobo_per_km;
v_pickup_subsidy := LEAST(
  v_economics.max_pickup_subsidy_kobo,
  v_pickup_subsidy_candidate,
  GREATEST(0::bigint, v_driver_floor - v_base_driver_net)
);
v_expected_driver_net := v_base_driver_net + v_pickup_subsidy;
v_projected_contribution := v_commission
                            - v_pickup_subsidy
                            - v_economics.platform_variable_cost_kobo;

IF v_expected_driver_net < v_driver_floor THEN
  RETURN QUERY SELECT false, 'driver_earnings_floor_unmet';
  RETURN;
END IF;
IF v_projected_contribution < v_economics.platform_contribution_target_kobo THEN
  RETURN QUERY SELECT false, 'platform_contribution_target_unmet';
  RETURN;
END IF;
```

The subsidy is deliberately a gap-closer rather than a universal bonus. It is zero when the base net already meets the driver floor, and it cannot exceed either the zone policy cap or the costed pickup candidate. The platform contribution subtracts the subsidy once; it is never double-counted.

## Exact Fail-Closed Tests

The isolated validator `scripts/testing/validate-driver-offer-economics-db.sh` contains two independent rejection cases.

| Case | Policy condition | Required result | Durable assertion |
|---|---|---|---|
| Driver-floor rejection | A higher fuel/maintenance index makes the calculated driver floor exceed base net plus the capped subsidy. | `issued = false`, `reason = driver_earnings_floor_unmet` | No offer with ID `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa` exists. |
| Contribution-target rejection | The driver floor remains feasible but the policy contribution target is set to 653 kobo, one kobo higher than the calculated 652 kobo contribution. | `issued = false`, `reason = platform_contribution_target_unmet` | No offer with ID `eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee` exists. |

The relevant terminal test blocks are:

```sql
SET ROLE switchos_service;
SELECT * FROM mobility.create_transparent_driver_offer(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '99999999-9999-4999-8999-999999999999',
  '88888888-8888-4888-8888-888888888888',
  2, 1::smallint, 0.5::numeric, '{}'::jsonb,
  timestamptz '2026-09-07 08:06:00+00', 500, 120, 70,
  timestamptz '2026-09-07 08:02:01+00'
);
RESET ROLE;

SET ROLE switchos_service;
SELECT * FROM mobility.create_transparent_driver_offer(
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  2, 1::smallint, 0.5::numeric, '{}'::jsonb,
  timestamptz '2026-09-07 08:07:00+00', 500, 120, 70,
  timestamptz '2026-09-07 08:03:01+00'
);
RESET ROLE;
```

The observed validator output confirms both distinct reasons, followed by `driver_offer_economics_result=PASS`.

## Actual Matching-Worker Destination Simulation

`scripts/testing/simulate-driver-offer-economics-matching-worker.sh` starts the real Go matching-worker binary with a local Redis instance and a uniquely named disposable PostgreSQL/PostGIS database. It uses the real internal `/matches/attempts` route and seeds only synthetic route/destination data with `route_provider='simulation'` and `route_provider_version='destination-v1'`.

The successful case produced a pending transparent offer from the real worker with `base_net=1100`, `driver_floor=260`, `pickup_subsidy=0`, and `platform_contribution=100` kobo. The synthetic high-fuel-index destination case returned the real worker’s `unfulfilled` state with zero offers. This proves the actual worker-to-database code path, but it does not verify a third-party routing provider, a live price feed, customer traffic, or a production endpoint.

## Controlled Target-Environment Preflight

`check-driver-offer-economics-target-preflight.sh` is deliberately non-mutating. It requires separate read-only/DDL-inspection and runtime connection URLs, a dedicated non-production token, and an explicit `local` or `staging` environment. It verifies PostgreSQL 16+, PostGIS, `pgcrypto`, both economics tables, the subsidy disclosure column, function signatures, `PUBLIC` revocations, runtime table-read denial, and runtime function execute permission.

> The preflight is a deployment-test guard, not authorization to test production. It does not seed fixtures, call matching routes, change policy, or create an offer.

A controlled staging test must use a separately provisioned test tenant/zone/driver/rider and an approved, reversible change window. Before any target-environment test, operators must apply ordered migrations through `0052`, supply `DATABASE_URL`, `REDIS_URL`, `INTERNAL_SERVICE_TOKEN`, and `MATCH_MIN_LOCATION_INTEGRITY` only from the target secret system, validate the preflight with least-privilege identities, and preserve the test evidence. Fuel and maintenance policy values require documented commercial approval; the source code intentionally has no undocumented external price-feed dependency.

## Evidence Boundary

All evidence in this report is local and disposable. No staging or production database, vehicle, driver, payment rail, route provider, real fuel feed, or customer record was accessed or modified. Local success is not evidence of production profitability, legal/commercial approval, real-time market-data quality, payment settlement correctness, capacity, or operational readiness.
