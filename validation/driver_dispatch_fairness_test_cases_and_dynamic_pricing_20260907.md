# Driver Dispatch Fairness Test Cases and Dynamic-Pricing Boundary

**Source script:** `scripts/testing/validate-driver-dispatch-fairness-db.sh`
**Status:** The existing source implements a versioned per-zone commission policy capped at 15.00%, not a real-time commission-adjustment algorithm. The dynamic model below is a recommended forward implementation, not deployed pricing behavior.

## Exact commission-cap and disclosure test case

The disposable test database seeds a fare quote with `total_kobo = 20000` and `taxes_and_fees_kobo = 2000`, then publishes a `1200` basis-point policy (12.00%, beneath the schema maximum of 1,500 basis points) and issues a transparent offer.

```sql
SET ROLE switchos_service;
SELECT mobility.set_driver_dispatch_fairness_policy(
  1,
  '11111111-1111-4111-8111-111111111111',
  'fairness-v1',
  1200,
  3000,
  600,
  timestamptz '2026-09-07 08:00:00+00',
  timestamptz '2026-09-07 08:00:00+00'
) AS policy_id \gset

SELECT * FROM mobility.create_transparent_driver_offer(
  '77777777-7777-4777-8777-777777777777',
  '66666666-6666-4666-8666-666666666666',
  '55555555-5555-4555-8555-555555555555',
  2,
  1::smallint,
  0.5::numeric,
  '{"distance_m":500,"eta_seconds":120}'::jsonb,
  timestamptz '2026-09-07 08:05:00+00',
  500,
  120,
  70,
  timestamptz '2026-09-07 08:01:00+00'
);

DO $$
DECLARE v_net bigint; v_commission bigint; v_destination text;
BEGIN
  SELECT expected_driver_net_kobo,platform_commission_kobo,destination_address
    INTO v_net,v_commission,v_destination
    FROM mobility.list_driver_offer_disclosures(2,timestamptz '2026-09-07 08:01:01+00')
   WHERE offer_id='77777777-7777-4777-8777-777777777777';
  IF v_net <> 15840 OR v_commission <> 2160 OR v_destination <> 'Destination, Lagos' THEN
    RAISE EXCEPTION 'transparent economics calculation mismatch';
  END IF;
END;
$$;
```

This calculation verifies that the service uses commissionable revenue of `18,000` kobo (`20,000 − 2,000`), applies `12.00%` to derive `2,160` kobo, and discloses an expected driver net of `15,840` kobo. It tests a legal policy beneath the cap. The actual 15.00% cap is enforced separately by `CHECK (platform_commission_bp BETWEEN 0 AND 1500)` on both policy and disclosure, and the policy function repeats `p_commission_bp NOT BETWEEN 0 AND 1500` validation.

The script also verifies the acceptance-side safety property, not only issuance-side arithmetic:

```sql
INSERT INTO mobility.driver_offer(
  id,match_attempt_id,trip_id,driver_user_id,rank,score,score_explanation,offered_at,expires_at
) VALUES (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '99999999-9999-4999-8999-999999999999',
  '88888888-8888-4888-888888888888',
  2,1,0.5,'{}'::jsonb,
  timestamptz '2026-09-07 08:02:00+00',
  timestamptz '2026-09-07 08:06:00+00'
);
DO $$
BEGIN
  BEGIN
    PERFORM mobility.accept_driver_offer(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      2,
      'opaque-accept-0001',
      timestamptz '2026-09-07 08:02:01+00'
    );
    RAISE EXCEPTION 'opaque offer acceptance unexpectedly allowed';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
END;
$$;
```

## Exact reason-coded fair-decline test case

The test submits the same idempotency key twice and then asserts one persisted decline, an unchanged rematch decision, one outbox event, restored availability, and unchanged driver account/safety/eligibility state.

```sql
SELECT * FROM mobility.decline_driver_offer_fairly(
  '77777777-7777-4777-8777-777777777777',
  2,
  'pickup_distance_unprofitable',
  'fair-decline-0001',
  timestamptz '2026-09-07 08:01:30+00'
);
SELECT * FROM mobility.decline_driver_offer_fairly(
  '77777777-7777-4777-8777-777777777777',
  2,
  'pickup_distance_unprofitable',
  'fair-decline-0001',
  timestamptz '2026-09-07 08:01:31+00'
);
```

```bash
if sudo -u postgres psql -X -At -d "$DB_NAME" -c "SELECT state::text FROM mobility.driver_offer WHERE id='77777777-7777-4777-8777-777777777777'" | grep -qx 'declined'; then :; else echo "driver_fairness_result=FAIL reason=decline_not_persisted" >&2; exit 1; fi
if sudo -u postgres psql -X -At -d "$DB_NAME" -c "SELECT state::text FROM mobility.driver_presence WHERE driver_user_id=2" | grep -qx 'available'; then :; else echo "driver_fairness_result=FAIL reason=driver_not_restored_available" >&2; exit 1; fi
if sudo -u postgres psql -X -At -d "$DB_NAME" -c "SELECT count(*) FROM mobility.driver_offer_decline WHERE offer_id='77777777-7777-4777-8777-777777777777'" | grep -qx '1'; then :; else echo "driver_fairness_result=FAIL reason=decline_not_idempotent" >&2; exit 1; fi
if sudo -u postgres psql -X -At -d "$DB_NAME" -c "SELECT rematch_required FROM mobility.driver_offer_decline WHERE offer_id='77777777-7777-4777-8777-777777777777'" | grep -qx 't'; then :; else echo "driver_fairness_result=FAIL reason=idempotent_rematch_outcome_not_preserved" >&2; exit 1; fi
if sudo -u postgres psql -X -At -d "$DB_NAME" -c "SELECT count(*) FROM mobility.outbox_event WHERE event_type='ride.driver_offer_declined' AND aggregate_id='55555555-5555-4555-8555-555555555555'" | grep -qx '1'; then :; else echo "driver_fairness_result=FAIL reason=duplicate_decline_event" >&2; exit 1; fi
```

## Current behavior versus proposed dynamic adjustment

The current migration is intentionally a **versioned policy** system. A commission rate is published per zone and applied to all matching offers in that policy’s effective interval. It has no fuel-price feed, no real-time driver-cost calculation, no rider surge/multiplier algorithm, and no automatic percentage adjustment. This is a safety and governance choice: unreviewed external cost feeds or individual acceptance history cannot silently alter a fare or split.

A safe future real-time pricing implementation should derive only a limited set of per-quote figures in the authoritative pricing transaction:

```text
F = rider quote before statutory pass-throughs
T = taxes, tolls, and regulated pass-throughs
E = F − T
S = explicit, budgeted pickup subsidy
D_min = approved driver floor for predicted pickup + trip time and distance
C_var = versioned variable platform cost for the product and zone
CM_target = approved minimum platform contribution
P_cap = 0.15 × E
P_max = min(E + S − D_min, P_cap)
P_target = C_var + CM_target + S
```

The quote is feasible only when `P_target ≤ P_max`. In that case the platform can set `P = P_target`, yielding:

```text
D = E − P + S
CM = E − D − C_var = P − S − C_var
```

Therefore, higher verified fuel/maintenance cost raises the approved `D_min`, reducing `P_max`; increased payment/maps/support/risk cost raises `C_var`, increasing `P_target`. The platform either raises the **transparent rider quote** within a published rider ceiling, funds an explicit time-bounded subsidy, finds a shorter pickup, batches/schedules work, or declines to dispatch. It must not increase commission above 15.00%, hide a change in a tax/fee line, or depress individual driver economics after a decline.

Fuel should not be treated as a noisy per-second signal. The current recommendation is a finance-approved fuel/maintenance index updated weekly; an emergency override requires a two-key approval, effective time, maximum duration, written reason, rollback value, and later reconciliation. Monthly public transport benchmark series can calibrate the policy but are too lagged for real-time rider quotes.[1] [2] Route distance/ETA can update per quote, and aggregate zone supply/demand can update every 5–15 minutes with bounded, pre-published limits. A driver’s personal decline history, protected characteristics, or opaque score must never be an input to the fare, commission, eligibility, or queue order.

## Sources and limits

The user-provided video is the source of the reported driver complaints. The National Bureau of Statistics Transport Fare Watch is cited only as a periodic contextual series. No live fuel price, city demand data, driver earnings data, vehicle cost, commission target, or market-rate forecast was used. This is research and operating-methodology analysis only, not personalized financial advice.

## References

[1] [Nigeria National Bureau of Statistics: Transport Fare Watch, May 2023](https://www.nigerianstat.gov.ng/elibrary/read/1241346)

[2] [Transport Fare Watch, March 2026 catalog entry, sourced to Nigeria National Bureau of Statistics](https://nigeria.opendataforafrica.org/xyzrrzd/transport-fare-watch)
