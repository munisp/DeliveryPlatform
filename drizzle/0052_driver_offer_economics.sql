-- Dynamic driver earnings-floor and pickup-subsidy allocation.
-- Forward-only dependency: 0026_ride_hailing_dispatch.sql, 0051_driver_dispatch_fairness.sql.
-- The database remains authoritative for offer economics. Redis and application memory are projections only.

CREATE TABLE IF NOT EXISTS mobility.driver_offer_economics_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id uuid NOT NULL REFERENCES mobility.service_zone(id) ON DELETE RESTRICT,
  version text NOT NULL CHECK (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$'),
  driver_time_floor_kobo_per_min bigint NOT NULL CHECK (driver_time_floor_kobo_per_min BETWEEN 1 AND 1000000),
  driver_distance_floor_kobo_per_km bigint NOT NULL CHECK (driver_distance_floor_kobo_per_km BETWEEN 1 AND 10000000),
  fuel_cost_index_bp integer NOT NULL CHECK (fuel_cost_index_bp BETWEEN 5000 AND 30000),
  maintenance_cost_index_bp integer NOT NULL CHECK (maintenance_cost_index_bp BETWEEN 5000 AND 30000),
  pickup_subsidy_kobo_per_km bigint NOT NULL CHECK (pickup_subsidy_kobo_per_km BETWEEN 0 AND 10000000),
  max_pickup_subsidy_kobo bigint NOT NULL CHECK (max_pickup_subsidy_kobo BETWEEN 0 AND 1000000000),
  platform_variable_cost_kobo bigint NOT NULL CHECK (platform_variable_cost_kobo BETWEEN 0 AND 1000000000),
  platform_contribution_target_kobo bigint NOT NULL CHECK (platform_contribution_target_kobo BETWEEN 0 AND 1000000000),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  approved_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  UNIQUE (zone_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS mobility_driver_offer_economics_policy_one_live_idx
  ON mobility.driver_offer_economics_policy (zone_id)
  WHERE effective_to IS NULL;

ALTER TABLE mobility.driver_offer_disclosure
  ADD COLUMN IF NOT EXISTS pickup_subsidy_kobo bigint NOT NULL DEFAULT 0
    CHECK (pickup_subsidy_kobo >= 0);
ALTER TABLE mobility.driver_offer_disclosure
  DROP CONSTRAINT IF EXISTS driver_offer_disclosure_check1;
ALTER TABLE mobility.driver_offer_disclosure
  DROP CONSTRAINT IF EXISTS driver_offer_disclosure_expected_driver_net_kobo_check;
ALTER TABLE mobility.driver_offer_disclosure
  ADD CONSTRAINT driver_offer_disclosure_expected_driver_net_kobo_check
  CHECK (
    expected_driver_net_kobo = gross_fare_kobo
      - taxes_and_fees_kobo
      - platform_commission_kobo
      + pickup_subsidy_kobo
  );

CREATE TABLE IF NOT EXISTS mobility.driver_offer_economics (
  offer_id uuid PRIMARY KEY REFERENCES mobility.driver_offer(id) ON DELETE RESTRICT,
  policy_id uuid NOT NULL REFERENCES mobility.driver_offer_economics_policy(id) ON DELETE RESTRICT,
  base_driver_net_kobo bigint NOT NULL CHECK (base_driver_net_kobo >= 0),
  driver_earnings_floor_kobo bigint NOT NULL CHECK (driver_earnings_floor_kobo >= 0),
  pickup_subsidy_kobo bigint NOT NULL CHECK (pickup_subsidy_kobo >= 0),
  platform_variable_cost_kobo bigint NOT NULL CHECK (platform_variable_cost_kobo >= 0),
  platform_contribution_target_kobo bigint NOT NULL CHECK (platform_contribution_target_kobo >= 0),
  projected_platform_contribution_kobo bigint NOT NULL,
  fuel_cost_index_bp integer NOT NULL CHECK (fuel_cost_index_bp BETWEEN 5000 AND 30000),
  maintenance_cost_index_bp integer NOT NULL CHECK (maintenance_cost_index_bp BETWEEN 5000 AND 30000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (pickup_subsidy_kobo <= driver_earnings_floor_kobo),
  CHECK (projected_platform_contribution_kobo >= -1000000000)
);

CREATE INDEX IF NOT EXISTS mobility_driver_offer_economics_policy_created_idx
  ON mobility.driver_offer_economics (policy_id, created_at DESC);

CREATE OR REPLACE FUNCTION mobility.set_driver_offer_economics_policy(
  p_actor integer,
  p_zone uuid,
  p_version text,
  p_driver_time_floor_kobo_per_min bigint,
  p_driver_distance_floor_kobo_per_km bigint,
  p_fuel_cost_index_bp integer,
  p_maintenance_cost_index_bp integer,
  p_pickup_subsidy_kobo_per_km bigint,
  p_max_pickup_subsidy_kobo bigint,
  p_platform_variable_cost_kobo bigint,
  p_platform_contribution_target_kobo bigint,
  p_effective_from timestamptz DEFAULT clock_timestamp(),
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, mobility
AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT mobility.is_driver_dispatch_operator(p_actor) THEN
    RAISE EXCEPTION 'driver dispatch operator role required' USING ERRCODE = '42501';
  END IF;
  IF p_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$'
     OR p_driver_time_floor_kobo_per_min NOT BETWEEN 1 AND 1000000
     OR p_driver_distance_floor_kobo_per_km NOT BETWEEN 1 AND 10000000
     OR p_fuel_cost_index_bp NOT BETWEEN 5000 AND 30000
     OR p_maintenance_cost_index_bp NOT BETWEEN 5000 AND 30000
     OR p_pickup_subsidy_kobo_per_km NOT BETWEEN 0 AND 10000000
     OR p_max_pickup_subsidy_kobo NOT BETWEEN 0 AND 1000000000
     OR p_platform_variable_cost_kobo NOT BETWEEN 0 AND 1000000000
     OR p_platform_contribution_target_kobo NOT BETWEEN 0 AND 1000000000
     OR p_effective_from < p_now THEN
    RAISE EXCEPTION 'invalid driver offer economics policy' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM mobility.service_zone WHERE id = p_zone AND active = true FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active service zone required' USING ERRCODE = '23514';
  END IF;

  UPDATE mobility.driver_offer_economics_policy
     SET effective_to = p_effective_from
   WHERE zone_id = p_zone AND effective_to IS NULL;

  INSERT INTO mobility.driver_offer_economics_policy(
    zone_id, version, driver_time_floor_kobo_per_min, driver_distance_floor_kobo_per_km,
    fuel_cost_index_bp, maintenance_cost_index_bp, pickup_subsidy_kobo_per_km,
    max_pickup_subsidy_kobo, platform_variable_cost_kobo, platform_contribution_target_kobo,
    effective_from, approved_by_user_id, created_at
  ) VALUES (
    p_zone, p_version, p_driver_time_floor_kobo_per_min, p_driver_distance_floor_kobo_per_km,
    p_fuel_cost_index_bp, p_maintenance_cost_index_bp, p_pickup_subsidy_kobo_per_km,
    p_max_pickup_subsidy_kobo, p_platform_variable_cost_kobo, p_platform_contribution_target_kobo,
    p_effective_from, p_actor, p_now
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION mobility.create_transparent_driver_offer(
  p_offer uuid,
  p_match_attempt uuid,
  p_trip uuid,
  p_driver integer,
  p_rank smallint,
  p_score numeric,
  p_score_explanation jsonb,
  p_expires_at timestamptz,
  p_pickup_distance_m integer,
  p_pickup_eta_s integer,
  p_min_location_integrity integer,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (issued boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, mobility
AS $$
DECLARE
  v_trip mobility.ride_trip%ROWTYPE;
  v_quote mobility.fare_quote%ROWTYPE;
  v_fairness mobility.driver_dispatch_fairness_policy%ROWTYPE;
  v_economics mobility.driver_offer_economics_policy%ROWTYPE;
  v_commission bigint;
  v_base_driver_net bigint;
  v_driver_floor bigint;
  v_pickup_subsidy_candidate bigint;
  v_pickup_subsidy bigint;
  v_expected_driver_net bigint;
  v_projected_contribution bigint;
  v_available boolean;
  v_total_minutes bigint;
  v_total_km bigint;
  v_operating_index_bp integer;
BEGIN
  IF p_rank < 1 OR p_pickup_distance_m < 0 OR p_pickup_eta_s < 0
     OR p_min_location_integrity NOT BETWEEN 0 AND 100
     OR p_expires_at <= p_now OR jsonb_typeof(p_score_explanation) <> 'object' THEN
    RAISE EXCEPTION 'invalid transparent offer input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_trip FROM mobility.ride_trip WHERE id = p_trip FOR SHARE;
  IF NOT FOUND OR v_trip.state NOT IN ('matching', 'driver_offered') THEN
    RETURN QUERY SELECT false, 'trip_not_matchable';
    RETURN;
  END IF;

  SELECT * INTO v_quote FROM mobility.fare_quote WHERE id = v_trip.fare_quote_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fare quote not found for trip' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_fairness
    FROM mobility.driver_dispatch_fairness_policy
   WHERE zone_id = v_trip.zone_id
     AND effective_from <= p_now
     AND (effective_to IS NULL OR effective_to > p_now)
   ORDER BY effective_from DESC
   LIMIT 1
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'fairness_policy_unavailable';
    RETURN;
  END IF;

  SELECT * INTO v_economics
    FROM mobility.driver_offer_economics_policy
   WHERE zone_id = v_trip.zone_id
     AND effective_from <= p_now
     AND (effective_to IS NULL OR effective_to > p_now)
   ORDER BY effective_from DESC
   LIMIT 1
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'economics_policy_unavailable';
    RETURN;
  END IF;

  IF p_pickup_distance_m > v_fairness.max_pickup_distance_m THEN
    RETURN QUERY SELECT false, 'pickup_distance_above_policy_limit';
    RETURN;
  END IF;
  IF p_pickup_eta_s > v_fairness.max_pickup_eta_s THEN
    RETURN QUERY SELECT false, 'pickup_time_above_policy_limit';
    RETURN;
  END IF;
  IF v_quote.total_kobo < v_quote.taxes_and_fees_kobo THEN
    RAISE EXCEPTION 'fare quote tax components exceed total' USING ERRCODE = '23514';
  END IF;

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

  SELECT EXISTS (
    SELECT 1
      FROM mobility.driver_presence p
      JOIN mobility.driver_eligibility e ON e.driver_user_id = p.driver_user_id
      JOIN mobility.driver_profile d ON d.user_id = p.driver_user_id
     WHERE p.driver_user_id = p_driver
       AND p.state = 'available'
       AND p.location_valid_until > p_now
       AND p.integrity_score >= p_min_location_integrity
       AND e.eligible = true
       AND e.eligible_until > p_now
       AND d.account_state = 'active'
       AND d.safety_state = 'clear'
     FOR UPDATE OF p SKIP LOCKED
  ) INTO v_available;
  IF NOT v_available THEN
    RETURN QUERY SELECT false, 'driver_unavailable';
    RETURN;
  END IF;

  INSERT INTO mobility.driver_offer(
    id, match_attempt_id, trip_id, driver_user_id, rank, score,
    score_explanation, offered_at, expires_at
  ) VALUES (
    p_offer, p_match_attempt, p_trip, p_driver, p_rank, p_score,
    p_score_explanation || jsonb_build_object(
      'fairness_policy_version', v_fairness.version,
      'economics_policy_version', v_economics.version,
      'pickup_distance_m', p_pickup_distance_m,
      'pickup_eta_s', p_pickup_eta_s,
      'driver_earnings_floor_kobo', v_driver_floor,
      'pickup_subsidy_kobo', v_pickup_subsidy,
      'projected_platform_contribution_kobo', v_projected_contribution
    ), p_now, p_expires_at
  ) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'offer_conflict';
    RETURN;
  END IF;

  UPDATE mobility.driver_presence
     SET state = 'offer_pending', active_offer_id = p_offer, offer_expires_at = p_expires_at,
         version = version + 1, updated_at = p_now
   WHERE driver_user_id = p_driver AND state = 'available';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'driver availability changed during offer issuance' USING ERRCODE = '40001';
  END IF;

  INSERT INTO mobility.driver_offer_disclosure(
    offer_id, policy_id, pickup_distance_m, pickup_eta_s, destination_address,
    destination_distance_m, destination_duration_s, gross_fare_kobo, taxes_and_fees_kobo,
    platform_commission_bp, platform_commission_kobo, pickup_subsidy_kobo,
    expected_driver_net_kobo, disclosure_version, created_at
  ) VALUES (
    p_offer, v_fairness.id, p_pickup_distance_m, p_pickup_eta_s, v_trip.destination_address,
    v_quote.quoted_distance_m, v_quote.quoted_duration_s, v_quote.total_kobo,
    v_quote.taxes_and_fees_kobo, v_fairness.platform_commission_bp, v_commission,
    v_pickup_subsidy, v_expected_driver_net, v_fairness.version, p_now
  );

  INSERT INTO mobility.driver_offer_economics(
    offer_id, policy_id, base_driver_net_kobo, driver_earnings_floor_kobo, pickup_subsidy_kobo,
    platform_variable_cost_kobo, platform_contribution_target_kobo,
    projected_platform_contribution_kobo, fuel_cost_index_bp, maintenance_cost_index_bp, created_at
  ) VALUES (
    p_offer, v_economics.id, v_base_driver_net, v_driver_floor, v_pickup_subsidy,
    v_economics.platform_variable_cost_kobo, v_economics.platform_contribution_target_kobo,
    v_projected_contribution, v_economics.fuel_cost_index_bp,
    v_economics.maintenance_cost_index_bp, p_now
  );

  RETURN QUERY SELECT true, 'issued';
END;
$$;

CREATE OR REPLACE FUNCTION mobility.list_driver_offer_economics(
  p_driver integer,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (
  offer_id uuid,
  driver_earnings_floor_kobo bigint,
  pickup_subsidy_kobo bigint,
  base_driver_net_kobo bigint,
  economics_policy_version text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, mobility
AS $$
  SELECT economics.offer_id,
         economics.driver_earnings_floor_kobo,
         economics.pickup_subsidy_kobo,
         economics.base_driver_net_kobo,
         policy.version
    FROM mobility.driver_offer_economics economics
    JOIN mobility.driver_offer offer ON offer.id = economics.offer_id
    JOIN mobility.driver_offer_economics_policy policy ON policy.id = economics.policy_id
   WHERE offer.driver_user_id = p_driver
     AND offer.state = 'pending'
     AND offer.expires_at > p_now
   ORDER BY offer.expires_at ASC
   LIMIT 10;
$$;

REVOKE ALL ON TABLE mobility.driver_offer_economics_policy, mobility.driver_offer_economics FROM PUBLIC;
REVOKE ALL ON FUNCTION mobility.set_driver_offer_economics_policy(integer, uuid, text, bigint, bigint, integer, integer, bigint, bigint, bigint, bigint, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION mobility.list_driver_offer_economics(integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION mobility.create_transparent_driver_offer(uuid, uuid, uuid, integer, smallint, numeric, jsonb, timestamptz, integer, integer, integer, timestamptz) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'switchos_service') THEN
    GRANT USAGE ON SCHEMA mobility TO switchos_service;
    GRANT EXECUTE ON FUNCTION mobility.set_driver_offer_economics_policy(integer, uuid, text, bigint, bigint, integer, integer, bigint, bigint, bigint, bigint, timestamptz, timestamptz) TO switchos_service;
    GRANT EXECUTE ON FUNCTION mobility.list_driver_offer_economics(integer, timestamptz) TO switchos_service;
    GRANT EXECUTE ON FUNCTION mobility.create_transparent_driver_offer(uuid, uuid, uuid, integer, smallint, numeric, jsonb, timestamptz, integer, integer, integer, timestamptz) TO switchos_service;
  END IF;
END $$;
