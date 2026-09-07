-- Transparent, non-punitive driver offer economics and fair-decline controls.
-- Forward-only extension of the existing mobility ride-dispatch schema.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS mobility;

DO $$ BEGIN
  CREATE TYPE mobility.driver_offer_decline_reason AS ENUM (
    'pickup_distance_unprofitable',
    'pickup_time_unprofitable',
    'fare_insufficient',
    'destination_unsuitable',
    'safety_preference',
    'vehicle_constraint',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

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
CREATE UNIQUE INDEX IF NOT EXISTS mobility_driver_dispatch_fairness_policy_one_live_idx
  ON mobility.driver_dispatch_fairness_policy (zone_id)
  WHERE effective_to IS NULL;

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
CREATE INDEX IF NOT EXISTS mobility_driver_offer_disclosure_policy_idx
  ON mobility.driver_offer_disclosure (policy_id, created_at DESC);

CREATE OR REPLACE FUNCTION mobility.require_driver_offer_disclosure_before_accept()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, mobility AS $$
BEGIN
  IF NEW.state = 'accepted'::mobility.offer_state
     AND OLD.state = 'pending'::mobility.offer_state
     AND NOT EXISTS (SELECT 1 FROM mobility.driver_offer_disclosure WHERE offer_id = NEW.id) THEN
    RAISE EXCEPTION 'transparent driver offer disclosure required before acceptance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS mobility_driver_offer_transparency_before_accept ON mobility.driver_offer;
CREATE TRIGGER mobility_driver_offer_transparency_before_accept
  BEFORE UPDATE OF state ON mobility.driver_offer
  FOR EACH ROW EXECUTE FUNCTION mobility.require_driver_offer_disclosure_before_accept();

CREATE TABLE IF NOT EXISTS mobility.driver_offer_decline (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id uuid NOT NULL UNIQUE REFERENCES mobility.driver_offer(id) ON DELETE RESTRICT,
  trip_id uuid NOT NULL REFERENCES mobility.ride_trip(id) ON DELETE RESTRICT,
  driver_user_id integer NOT NULL REFERENCES mobility.driver_profile(user_id) ON DELETE RESTRICT,
  reason mobility.driver_offer_decline_reason NOT NULL,
  rematch_required boolean NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (driver_user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS mobility_driver_offer_decline_trip_time_idx
  ON mobility.driver_offer_decline (trip_id, created_at DESC);

CREATE OR REPLACE FUNCTION mobility.is_driver_dispatch_operator(p_user_id integer)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, mobility AS $$
  SELECT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id AND role = 'admin');
$$;

CREATE OR REPLACE FUNCTION mobility.set_driver_dispatch_fairness_policy(
  p_actor integer,
  p_zone uuid,
  p_version text,
  p_commission_bp integer,
  p_max_pickup_distance_m integer,
  p_max_pickup_eta_s integer,
  p_effective_from timestamptz DEFAULT clock_timestamp(),
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, mobility AS $$
DECLARE v_id uuid;
BEGIN
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
  PERFORM 1 FROM mobility.service_zone WHERE id = p_zone AND active = true FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active service zone required' USING ERRCODE = '23514'; END IF;
  UPDATE mobility.driver_dispatch_fairness_policy
     SET effective_to = p_effective_from
   WHERE zone_id = p_zone AND effective_to IS NULL;
  INSERT INTO mobility.driver_dispatch_fairness_policy(
    zone_id,version,platform_commission_bp,max_pickup_distance_m,max_pickup_eta_s,
    destination_disclosure,effective_from,approved_by_user_id,created_at
  ) VALUES (
    p_zone,p_version,p_commission_bp,p_max_pickup_distance_m,p_max_pickup_eta_s,
    'full',p_effective_from,p_actor,p_now
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
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, mobility AS $$
DECLARE
  v_trip mobility.ride_trip%ROWTYPE;
  v_quote mobility.fare_quote%ROWTYPE;
  v_policy mobility.driver_dispatch_fairness_policy%ROWTYPE;
  v_commission bigint;
  v_available boolean;
BEGIN
  IF p_rank < 1 OR p_pickup_distance_m < 0 OR p_pickup_eta_s < 0
     OR p_min_location_integrity NOT BETWEEN 0 AND 100
     OR p_expires_at <= p_now OR jsonb_typeof(p_score_explanation) <> 'object' THEN
    RAISE EXCEPTION 'invalid transparent offer input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_trip
    FROM mobility.ride_trip
   WHERE id = p_trip
   FOR SHARE;
  IF NOT FOUND OR v_trip.state NOT IN ('matching','driver_offered') THEN
    RETURN QUERY SELECT false, 'trip_not_matchable';
    RETURN;
  END IF;
  SELECT * INTO v_quote
    FROM mobility.fare_quote
   WHERE id = v_trip.fare_quote_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fare quote not found for trip' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_policy
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
  IF p_pickup_distance_m > v_policy.max_pickup_distance_m THEN
    RETURN QUERY SELECT false, 'pickup_distance_above_policy_limit';
    RETURN;
  END IF;
  IF p_pickup_eta_s > v_policy.max_pickup_eta_s THEN
    RETURN QUERY SELECT false, 'pickup_time_above_policy_limit';
    RETURN;
  END IF;
  IF v_quote.total_kobo < v_quote.taxes_and_fees_kobo THEN
    RAISE EXCEPTION 'fare quote tax components exceed total' USING ERRCODE = '23514';
  END IF;
  v_commission := ((v_quote.total_kobo - v_quote.taxes_and_fees_kobo) * v_policy.platform_commission_bp) / 10000;

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
    id,match_attempt_id,trip_id,driver_user_id,rank,score,score_explanation,offered_at,expires_at
  ) VALUES (
    p_offer,p_match_attempt,p_trip,p_driver,p_rank,p_score,
    p_score_explanation || jsonb_build_object(
      'fairness_policy_version',v_policy.version,
      'pickup_distance_m',p_pickup_distance_m,
      'pickup_eta_s',p_pickup_eta_s
    ),p_now,p_expires_at
  ) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'offer_conflict';
    RETURN;
  END IF;

  UPDATE mobility.driver_presence
     SET state = 'offer_pending',active_offer_id = p_offer,offer_expires_at = p_expires_at,
         version = version + 1,updated_at = p_now
   WHERE driver_user_id = p_driver AND state = 'available';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'driver availability changed during offer issuance' USING ERRCODE = '40001';
  END IF;

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
  RETURN QUERY SELECT true, 'issued';
END;
$$;

CREATE OR REPLACE FUNCTION mobility.list_driver_offer_disclosures(
  p_driver integer,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (
  offer_id uuid,trip_id uuid,expires_at timestamptz,pickup_distance_m integer,pickup_eta_s integer,
  destination_address text,destination_distance_m integer,destination_duration_s integer,
  gross_fare_kobo bigint,taxes_and_fees_kobo bigint,platform_commission_bp integer,
  platform_commission_kobo bigint,expected_driver_net_kobo bigint,disclosure_version text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, mobility AS $$
  SELECT o.id,o.trip_id,o.expires_at,d.pickup_distance_m,d.pickup_eta_s,d.destination_address,
         d.destination_distance_m,d.destination_duration_s,d.gross_fare_kobo,d.taxes_and_fees_kobo,
         d.platform_commission_bp,d.platform_commission_kobo,d.expected_driver_net_kobo,d.disclosure_version
    FROM mobility.driver_offer o
    JOIN mobility.driver_offer_disclosure d ON d.offer_id = o.id
   WHERE o.driver_user_id = p_driver AND o.state = 'pending' AND o.expires_at > p_now
   ORDER BY o.expires_at ASC
   LIMIT 10;
$$;

CREATE OR REPLACE FUNCTION mobility.decline_driver_offer_fairly(
  p_offer uuid,
  p_driver integer,
  p_reason mobility.driver_offer_decline_reason,
  p_idempotency_key text,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (trip_id uuid, state mobility.offer_state, rematch_required boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, mobility AS $$
DECLARE v_offer mobility.driver_offer%ROWTYPE; v_pending_count integer; v_rematch_required boolean;
BEGIN
  IF p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN
    RAISE EXCEPTION 'invalid offer-decline idempotency key' USING ERRCODE = '22023';
  END IF;
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
END;
$$;

REVOKE ALL ON TABLE mobility.driver_dispatch_fairness_policy,mobility.driver_offer_disclosure,mobility.driver_offer_decline FROM PUBLIC;
REVOKE ALL ON FUNCTION mobility.require_driver_offer_disclosure_before_accept() FROM PUBLIC;
REVOKE ALL ON FUNCTION mobility.is_driver_dispatch_operator(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION mobility.set_driver_dispatch_fairness_policy(integer,uuid,text,integer,integer,integer,timestamptz,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION mobility.create_transparent_driver_offer(uuid,uuid,uuid,integer,smallint,numeric,jsonb,timestamptz,integer,integer,integer,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION mobility.list_driver_offer_disclosures(integer,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION mobility.decline_driver_offer_fairly(uuid,integer,mobility.driver_offer_decline_reason,text,timestamptz) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='switchos_service') THEN
    GRANT USAGE ON SCHEMA mobility TO switchos_service;
    GRANT EXECUTE ON FUNCTION mobility.create_transparent_driver_offer(uuid,uuid,uuid,integer,smallint,numeric,jsonb,timestamptz,integer,integer,integer,timestamptz) TO switchos_service;
    GRANT EXECUTE ON FUNCTION mobility.list_driver_offer_disclosures(integer,timestamptz) TO switchos_service;
    GRANT EXECUTE ON FUNCTION mobility.decline_driver_offer_fairly(uuid,integer,mobility.driver_offer_decline_reason,text,timestamptz) TO switchos_service;
    GRANT EXECUTE ON FUNCTION mobility.set_driver_dispatch_fairness_policy(integer,uuid,text,integer,integer,integer,timestamptz,timestamptz) TO switchos_service;
  END IF;
END $$;
