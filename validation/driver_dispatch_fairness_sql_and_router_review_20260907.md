# Driver Dispatch Fairness: Exact SQL and tRPC Review

**Source files:** `drizzle/0051_driver_dispatch_fairness.sql`, `server/_core/driverDispatchFairness.ts`, and `server/routers.ts`.
**Scope:** Local, uncommitted implementation in the isolated commerce worktree as of 2026-09-07.

## 15.00% commission cap

The schema applies the maximum commission twice: on the live zone policy and in the immutable offer disclosure.

```sql
CREATE TABLE IF NOT EXISTS mobility.driver_dispatch_fairness_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id uuid NOT NULL REFERENCES mobility.service_zone(id) ON DELETE RESTRICT,
  version text NOT NULL CHECK (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$'),
  platform_commission_bp integer NOT NULL CHECK (platform_commission_bp BETWEEN 0 AND 1500),
  max_pickup_distance_m integer NOT NULL CHECK (max_pickup_distance_m BETWEEN 250 AND 5000),
  max_pickup_eta_s integer NOT NULL CHECK (max_pickup_eta_s BETWEEN 60 AND 1200),
  destination_disclosure text NOT NULL DEFAULT 'full' CHECK (destination_disclosure = 'full'),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  approved_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  UNIQUE (zone_id, version)
);

CREATE TABLE IF NOT EXISTS mobility.driver_offer_disclosure (
  offer_id uuid PRIMARY KEY REFERENCES mobility.driver_offer(id) ON DELETE RESTRICT,
  policy_id uuid NOT NULL REFERENCES mobility.driver_dispatch_fairness_policy(id) ON DELETE RESTRICT,
  pickup_distance_m integer NOT NULL CHECK (pickup_distance_m >= 0),
  pickup_eta_s integer NOT NULL CHECK (pickup_eta_s >= 0),
  destination_address text NOT NULL CHECK (length(destination_address) BETWEEN 3 AND 1000),
  destination_distance_m integer NOT NULL CHECK (destination_distance_m >= 0),
  destination_duration_s integer NOT NULL CHECK (destination_duration_s >= 0),
  gross_fare_kobo bigint NOT NULL CHECK (gross_fare_kobo >= 0),
  taxes_and_fees_kobo bigint NOT NULL CHECK (taxes_and_fees_kobo >= 0),
  platform_commission_bp integer NOT NULL CHECK (platform_commission_bp BETWEEN 0 AND 1500),
  platform_commission_kobo bigint NOT NULL CHECK (platform_commission_kobo >= 0),
  expected_driver_net_kobo bigint NOT NULL CHECK (expected_driver_net_kobo >= 0),
  disclosure_version text NOT NULL CHECK (length(disclosure_version) BETWEEN 3 AND 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (gross_fare_kobo >= taxes_and_fees_kobo),
  CHECK (expected_driver_net_kobo = gross_fare_kobo - taxes_and_fees_kobo - platform_commission_kobo)
);
```

The policy-publishing function repeats the range validation and requires a database-recognized administrator.

```sql
IF NOT mobility.is_driver_dispatch_operator(p_actor) THEN
  RAISE EXCEPTION 'driver dispatch operator role required' USING ERRCODE = '42501';
END IF;
IF p_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$'
   OR p_commission_bp NOT BETWEEN 0 AND 1500
   OR p_max_pickup_distance_m NOT BETWEEN 250 AND 5000
   OR p_max_pickup_eta_s NOT BETWEEN 60 AND 1200
   OR p_effective_from < p_now THEN
  RAISE EXCEPTION 'invalid driver fairness policy' USING ERRCODE = '22023';
END IF;
```

The transparent-offer function computes commission from the fare net of taxes and fees, rather than applying a fee to stated pass-throughs. It then stores the computation and the policy rate in the disclosure.

```sql
v_commission := ((v_quote.total_kobo - v_quote.taxes_and_fees_kobo)
                 * v_policy.platform_commission_bp) / 10000;

INSERT INTO mobility.driver_offer_disclosure(
  offer_id,policy_id,pickup_distance_m,pickup_eta_s,destination_address,destination_distance_m,
  destination_duration_s,gross_fare_kobo,taxes_and_fees_kobo,platform_commission_bp,
  platform_commission_kobo,expected_driver_net_kobo,disclosure_version,created_at
) VALUES (
  p_offer,v_policy.id,p_pickup_distance_m,p_pickup_eta_s,v_trip.destination_address,
  v_quote.quoted_distance_m,v_quote.quoted_duration_s,v_quote.total_kobo,v_quote.taxes_and_fees_kobo,
  v_policy.platform_commission_bp,v_commission,
  v_quote.total_kobo - v_quote.taxes_and_fees_kobo - v_commission,v_policy.version,p_now
);
```

Finally, the trigger rejects acceptance without the durable disclosure.

```sql
IF NEW.state = 'accepted'::mobility.offer_state
   AND OLD.state = 'pending'::mobility.offer_state
   AND NOT EXISTS (SELECT 1 FROM mobility.driver_offer_disclosure WHERE offer_id = NEW.id) THEN
  RAISE EXCEPTION 'transparent driver offer disclosure required before acceptance' USING ERRCODE = '23514';
END IF;
```

## Reason-coded fair decline

The allowed reasons are stored as a database enum, not open-ended application text.

```sql
CREATE TYPE mobility.driver_offer_decline_reason AS ENUM (
  'pickup_distance_unprofitable',
  'pickup_time_unprofitable',
  'fare_insufficient',
  'destination_unsuitable',
  'safety_preference',
  'vehicle_constraint',
  'other'
);
```

The decline function locks the driver-owned offer, preserves idempotent behavior, releases only the matching driver presence, writes the immutable reason, and emits one outbox event. It intentionally does not mutate any punitive profile state.

```sql
SELECT * INTO v_offer FROM mobility.driver_offer WHERE id = p_offer FOR UPDATE;
IF NOT FOUND OR v_offer.driver_user_id <> p_driver THEN
  RAISE EXCEPTION 'offer not found for driver' USING ERRCODE = 'P0002';
END IF;
IF v_offer.state = 'declined' AND v_offer.response_idempotency_key = p_idempotency_key THEN
  SELECT decline_record.rematch_required INTO v_rematch_required
    FROM mobility.driver_offer_decline AS decline_record
   WHERE decline_record.offer_id = p_offer;
  RETURN QUERY SELECT v_offer.trip_id, v_offer.state, COALESCE(v_rematch_required, false);
  RETURN;
END IF;
IF v_offer.state <> 'pending' OR v_offer.expires_at <= p_now THEN
  RAISE EXCEPTION 'offer is no longer eligible for decline' USING ERRCODE = '23514';
END IF;

UPDATE mobility.driver_offer
   SET state='declined',responded_at=p_now,response_idempotency_key=p_idempotency_key
 WHERE id=p_offer;
UPDATE mobility.driver_presence AS presence
   SET state='available',active_offer_id=NULL,offer_expires_at=NULL,version=presence.version+1,updated_at=p_now
 WHERE presence.driver_user_id=p_driver AND presence.active_offer_id=p_offer AND presence.state='offer_pending';

SELECT count(*) INTO v_pending_count
  FROM mobility.driver_offer AS pending_offer
 WHERE pending_offer.trip_id=v_offer.trip_id
   AND pending_offer.state='pending'
   AND pending_offer.expires_at > p_now;
v_rematch_required := v_pending_count = 0;
INSERT INTO mobility.driver_offer_decline(offer_id,trip_id,driver_user_id,reason,rematch_required,idempotency_key,created_at)
VALUES(p_offer,v_offer.trip_id,p_driver,p_reason,v_rematch_required,p_idempotency_key,p_now);
INSERT INTO mobility.outbox_event(aggregate_type,aggregate_id,event_type,payload)
VALUES(
  'ride_trip',v_offer.trip_id,'ride.driver_offer_declined',
  jsonb_build_object('trip_id',v_offer.trip_id,'offer_id',p_offer,'driver_user_id',p_driver,
    'reason',p_reason::text,'rematch_required',v_rematch_required)
);
-- Deliberately no change to driver_profile, driver_eligibility, rating, or suspension state.
RETURN QUERY SELECT v_offer.trip_id, 'declined'::mobility.offer_state, v_rematch_required;
```

## tRPC authorization boundary

The application router validates input before calling the typed PostgreSQL service. The driver never supplies an actor ID; the router binds it to `ctx.user!.id` under `authenticatedProcedure`.

```ts
listMyOffers: authenticatedProcedure
  .input(z.object({ limit: z.number().int().min(1).max(10).optional() }).optional())
  .query(({ ctx, input }) =>
    listDriverOfferDisclosures({
      driverUserId: ctx.user!.id,
      limit: input?.limit ?? 10,
    }),
  ),

declineOffer: authenticatedProcedure
  .input(
    z.object({
      offerId: z.string().uuid(),
      reason: z.enum([
        "pickup_distance_unprofitable",
        "pickup_time_unprofitable",
        "fare_insufficient",
        "destination_unsuitable",
        "safety_preference",
        "vehicle_constraint",
        "other",
      ]),
      idempotencyKey: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
    }),
  )
  .mutation(({ ctx, input }) =>
    declineDriverOfferFairly({ driverUserId: ctx.user!.id, ...input }),
  ),
```

Policy publication is restricted at the tRPC boundary and then independently repeated in the security-definer database function.

```ts
setPolicy: protectedProcedure
  .input(
    z.object({
      zoneId: z.string().uuid(),
      version: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/),
      commissionBp: z.number().int().min(0).max(1500),
      maxPickupDistanceM: z.number().int().min(250).max(5000),
      maxPickupEtaS: z.number().int().min(60).max(1200),
      effectiveFrom: z.string().datetime().optional(),
    }),
  )
  .mutation(({ ctx, input }) =>
    setDriverDispatchFairnessPolicy({ actorUserId: ctx.user!.id, ...input }),
  ),
```

The router is not the sole authorization mechanism. The database functions use restricted `search_path = pg_catalog, mobility`, `PUBLIC` is revoked from the tables/functions, and only the runtime role obtains execute grants.

## Evidence boundary

The dedicated disposable PostgreSQL/PostGIS harness validated the cap, economics calculation, opaque-offer acceptance rejection, ownership bound decline, idempotency, preserved rematch decision, non-punitive driver state, and restricted disclosure access. The source is uncommitted and no production or staging database has applied this migration.
