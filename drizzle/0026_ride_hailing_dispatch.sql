-- Ride-hailing dispatch, matching, payment, and payout schema.
-- Scope: Lagos private beta. PostgreSQL 16+ with PostGIS and pgcrypto.


CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS mobility;

DO $$ BEGIN
  CREATE TYPE mobility.trip_state AS ENUM (
    'quote_created', 'requested', 'matching', 'driver_offered',
    'driver_reserved', 'driver_en_route', 'driver_arrived',
    'pickup_verified', 'in_progress', 'completed_pending_payment',
    'completed', 'cancelled', 'unfulfilled', 'payment_failed',
    'payment_review', 'safety_paused', 'disputed', 'refunded'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mobility.driver_presence_state AS ENUM (
    'pending_compliance', 'offline', 'available', 'offer_pending',
    'reserved', 'en_route', 'arrived', 'on_trip', 'post_trip', 'suspended'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mobility.offer_state AS ENUM ('pending', 'accepted', 'declined', 'expired', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mobility.compliance_state AS ENUM ('pending', 'verified', 'expired', 'rejected', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mobility.payment_state AS ENUM (
    'created', 'authorisation_pending', 'authorised', 'capture_pending',
    'captured', 'settlement_pending', 'settled', 'failed', 'cancelled',
    'refund_pending', 'refunded', 'chargeback_open', 'chargeback_lost'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mobility.payout_state AS ENUM (
    'not_required', 'held', 'queued', 'submitted', 'settled', 'failed', 'reversed', 'blocked'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A service zone is immutable once referenced by a quote. Revisions create a new row/version.
CREATE TABLE IF NOT EXISTS mobility.service_zone (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_code text NOT NULL CHECK (city_code = 'LAG'),
  zone_code text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  display_name text NOT NULL,
  boundary geometry(MultiPolygon, 4326) NOT NULL,
  active boolean NOT NULL DEFAULT false,
  dispatch_enabled boolean NOT NULL DEFAULT false,
  policy_version text NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE (city_code, zone_code, version),
  CHECK (ST_IsValid(boundary)),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX IF NOT EXISTS mobility_service_zone_boundary_gix
  ON mobility.service_zone USING gist (boundary);
CREATE UNIQUE INDEX IF NOT EXISTS mobility_service_zone_one_active_idx
  ON mobility.service_zone (city_code, zone_code)
  WHERE active = true;

-- A driver is linked to the existing public.users integer identity record.
CREATE TABLE IF NOT EXISTS mobility.driver_profile (
  user_id integer PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
  legal_name text NOT NULL,
  display_name text NOT NULL,
  rider_visible_rating numeric(3,2),
  account_state text NOT NULL CHECK (account_state IN ('pending', 'active', 'suspended', 'deactivated')),
  safety_state text NOT NULL CHECK (safety_state IN ('clear', 'review', 'hold', 'blocked')),
  payout_state text NOT NULL CHECK (payout_state IN ('pending', 'verified', 'blocked')) DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (rider_visible_rating IS NULL OR rider_visible_rating BETWEEN 1.00 AND 5.00)
);

CREATE TABLE IF NOT EXISTS mobility.vehicle (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_user_id integer NOT NULL REFERENCES mobility.driver_profile(user_id) ON DELETE RESTRICT,
  registration_number citext NOT NULL,
  make text NOT NULL,
  model text NOT NULL,
  manufacture_year integer NOT NULL CHECK (manufacture_year BETWEEN 1990 AND 2100),
  colour text NOT NULL,
  passenger_capacity smallint NOT NULL CHECK (passenger_capacity BETWEEN 1 AND 8),
  vehicle_class text NOT NULL CHECK (vehicle_class IN ('beta_standard')),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (registration_number)
);
CREATE UNIQUE INDEX IF NOT EXISTS mobility_vehicle_one_active_per_driver_idx
  ON mobility.vehicle (driver_user_id) WHERE active = true;

-- Object keys point to encrypted, restricted document storage. Never store raw document bytes here.
CREATE TABLE IF NOT EXISTS mobility.compliance_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind text NOT NULL CHECK (subject_kind IN ('driver', 'vehicle', 'operator')),
  subject_key text NOT NULL,
  evidence_type text NOT NULL CHECK (evidence_type IN (
    'national_driver_license', 'lasdri_certificate', 'driver_badge', 'identity_check',
    'background_screening', 'vehicle_registration', 'roadworthiness', 'vehicle_inspection',
    'commercial_motor_insurance', 'passenger_liability_cover', 'operator_permit', 'training'
  )),
  verifier text NOT NULL,
  external_reference text,
  document_object_key text,
  issued_at timestamptz,
  expires_at timestamptz,
  state mobility.compliance_state NOT NULL DEFAULT 'pending',
  verified_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  verified_at timestamptz,
  rejection_or_revocation_reason text,
  immutable_digest bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR issued_at IS NULL OR expires_at > issued_at),
  UNIQUE (subject_kind, subject_key, evidence_type, external_reference)
);
CREATE INDEX IF NOT EXISTS mobility_compliance_evidence_active_idx
  ON mobility.compliance_evidence (subject_kind, subject_key, evidence_type, expires_at)
  WHERE state = 'verified';

-- Matching reads this projection; compliance review is performed outside the hot matching path.
CREATE TABLE IF NOT EXISTS mobility.driver_eligibility (
  driver_user_id integer PRIMARY KEY REFERENCES mobility.driver_profile(user_id) ON DELETE CASCADE,
  active_vehicle_id uuid REFERENCES mobility.vehicle(id) ON DELETE SET NULL,
  eligible boolean NOT NULL DEFAULT false,
  eligible_until timestamptz,
  exclusion_code text,
  policy_version text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((eligible AND active_vehicle_id IS NOT NULL) OR NOT eligible)
);
CREATE INDEX IF NOT EXISTS mobility_driver_eligibility_ready_idx
  ON mobility.driver_eligibility (eligible_until, driver_user_id)
  WHERE eligible = true;

-- Driver device sessions allow sequence monotonicity and immediate revocation.
CREATE TABLE IF NOT EXISTS mobility.driver_device_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_user_id integer NOT NULL REFERENCES mobility.driver_profile(user_id) ON DELETE CASCADE,
  device_public_key_fingerprint text NOT NULL,
  app_version text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_sequence_no bigint NOT NULL DEFAULT 0,
  UNIQUE (driver_user_id, device_public_key_fingerprint, issued_at),
  CHECK (expires_at > issued_at)
);
CREATE INDEX IF NOT EXISTS mobility_driver_device_session_live_idx
  ON mobility.driver_device_session (driver_user_id, expires_at)
  WHERE revoked_at IS NULL;

-- Append-only location table. In production create daily/monthly partitions in the scheduler.
CREATE TABLE IF NOT EXISTS mobility.driver_location_sample (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  driver_user_id integer NOT NULL REFERENCES mobility.driver_profile(user_id) ON DELETE RESTRICT,
  device_session_id uuid NOT NULL REFERENCES mobility.driver_device_session(id) ON DELETE RESTRICT,
  sequence_no bigint NOT NULL CHECK (sequence_no > 0),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  point geography(Point, 4326) NOT NULL,
  accuracy_m real,
  bearing_deg real,
  speed_mps real,
  source text NOT NULL CHECK (source IN ('foreground_gps', 'background_gps', 'reconciled')),
  integrity_score smallint NOT NULL CHECK (integrity_score BETWEEN 0 AND 100),
  quality_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (driver_user_id, device_session_id, sequence_no),
  CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
  CHECK (speed_mps IS NULL OR speed_mps >= 0),
  CHECK (bearing_deg IS NULL OR bearing_deg >= 0 AND bearing_deg < 360)
);
CREATE INDEX IF NOT EXISTS mobility_driver_location_sample_point_gix
  ON mobility.driver_location_sample USING gist (point);
CREATE INDEX IF NOT EXISTS mobility_driver_location_sample_driver_time_idx
  ON mobility.driver_location_sample (driver_user_id, received_at DESC);

-- Hot authoritative current location/presence. Redis mirrors this row after a committed update.
CREATE TABLE IF NOT EXISTS mobility.driver_presence (
  driver_user_id integer PRIMARY KEY REFERENCES mobility.driver_profile(user_id) ON DELETE CASCADE,
  state mobility.driver_presence_state NOT NULL DEFAULT 'pending_compliance',
  zone_id uuid REFERENCES mobility.service_zone(id) ON DELETE SET NULL,
  last_point geography(Point, 4326),
  last_location_at timestamptz,
  location_valid_until timestamptz,
  accuracy_m real,
  integrity_score smallint NOT NULL DEFAULT 0 CHECK (integrity_score BETWEEN 0 AND 100),
  geo_cell text,
  active_trip_id uuid,
  active_offer_id uuid,
  offer_expires_at timestamptz,
  reservation_expires_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (state = 'available' AND active_trip_id IS NULL AND active_offer_id IS NULL)
    OR state <> 'available'
  )
);
CREATE INDEX IF NOT EXISTS mobility_driver_presence_available_geo_gix
  ON mobility.driver_presence USING gist (last_point)
  WHERE state = 'available';
CREATE INDEX IF NOT EXISTS mobility_driver_presence_available_zone_idx
  ON mobility.driver_presence (zone_id, location_valid_until DESC)
  WHERE state = 'available';

CREATE TABLE IF NOT EXISTS mobility.fare_rule_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id uuid NOT NULL REFERENCES mobility.service_zone(id) ON DELETE RESTRICT,
  version text NOT NULL,
  currency char(3) NOT NULL DEFAULT 'NGN',
  base_kobo bigint NOT NULL CHECK (base_kobo >= 0),
  per_km_kobo bigint NOT NULL CHECK (per_km_kobo >= 0),
  per_minute_kobo bigint NOT NULL CHECK (per_minute_kobo >= 0),
  minimum_kobo bigint NOT NULL CHECK (minimum_kobo >= 0),
  cancellation_kobo bigint NOT NULL CHECK (cancellation_kobo >= 0),
  demand_cap_basis_points integer NOT NULL CHECK (demand_cap_basis_points BETWEEN 10000 AND 100000),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  approved_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (zone_id, version),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS mobility_fare_rule_one_live_idx
  ON mobility.fare_rule_version (zone_id) WHERE effective_to IS NULL;

CREATE TABLE IF NOT EXISTS mobility.fare_quote (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  zone_id uuid NOT NULL REFERENCES mobility.service_zone(id) ON DELETE RESTRICT,
  fare_rule_id uuid NOT NULL REFERENCES mobility.fare_rule_version(id) ON DELETE RESTRICT,
  route_provider text NOT NULL,
  route_provider_version text NOT NULL,
  quoted_distance_m integer NOT NULL CHECK (quoted_distance_m >= 0),
  quoted_duration_s integer NOT NULL CHECK (quoted_duration_s >= 0),
  base_kobo bigint NOT NULL CHECK (base_kobo >= 0),
  distance_kobo bigint NOT NULL CHECK (distance_kobo >= 0),
  time_kobo bigint NOT NULL CHECK (time_kobo >= 0),
  demand_kobo bigint NOT NULL CHECK (demand_kobo >= 0),
  taxes_and_fees_kobo bigint NOT NULL CHECK (taxes_and_fees_kobo >= 0),
  total_kobo bigint NOT NULL CHECK (total_kobo >= 0),
  disclosure_version text NOT NULL,
  calculation jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (total_kobo = base_kobo + distance_kobo + time_kobo + demand_kobo + taxes_and_fees_kobo)
);
CREATE INDEX IF NOT EXISTS mobility_fare_quote_rider_created_idx
  ON mobility.fare_quote (rider_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mobility.ride_trip (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  state mobility.trip_state NOT NULL DEFAULT 'quote_created',
  zone_id uuid NOT NULL REFERENCES mobility.service_zone(id) ON DELETE RESTRICT,
  fare_quote_id uuid NOT NULL REFERENCES mobility.fare_quote(id) ON DELETE RESTRICT,
  pickup geography(Point, 4326) NOT NULL,
  destination geography(Point, 4326) NOT NULL,
  pickup_address text NOT NULL,
  destination_address text NOT NULL,
  pickup_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  destination_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  assigned_driver_user_id integer REFERENCES mobility.driver_profile(user_id) ON DELETE RESTRICT,
  assigned_vehicle_id uuid REFERENCES mobility.vehicle(id) ON DELETE RESTRICT,
  requested_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  cancellation_actor text,
  cancellation_code text,
  state_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'completed' OR completed_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS mobility_ride_trip_rider_recent_idx
  ON mobility.ride_trip (rider_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mobility_ride_trip_driver_active_idx
  ON mobility.ride_trip (assigned_driver_user_id, updated_at DESC)
  WHERE state IN ('driver_reserved', 'driver_en_route', 'driver_arrived', 'pickup_verified', 'in_progress', 'completed_pending_payment');
CREATE INDEX IF NOT EXISTS mobility_ride_trip_pickup_gix ON mobility.ride_trip USING gist (pickup);

CREATE TABLE IF NOT EXISTS mobility.match_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES mobility.ride_trip(id) ON DELETE CASCADE,
  wave_no smallint NOT NULL CHECK (wave_no > 0),
  algorithm_version text NOT NULL,
  candidate_query_snapshot jsonb NOT NULL,
  candidate_count integer NOT NULL CHECK (candidate_count >= 0),
  state text NOT NULL CHECK (state IN ('open', 'offering', 'reserved', 'exhausted', 'cancelled', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (trip_id, wave_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS mobility_match_attempt_one_open_idx
  ON mobility.match_attempt (trip_id) WHERE state IN ('open', 'offering');

CREATE TABLE IF NOT EXISTS mobility.driver_offer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_attempt_id uuid NOT NULL REFERENCES mobility.match_attempt(id) ON DELETE CASCADE,
  trip_id uuid NOT NULL REFERENCES mobility.ride_trip(id) ON DELETE CASCADE,
  driver_user_id integer NOT NULL REFERENCES mobility.driver_profile(user_id) ON DELETE RESTRICT,
  rank smallint NOT NULL CHECK (rank > 0),
  score numeric(12,6) NOT NULL,
  score_explanation jsonb NOT NULL,
  offered_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  state mobility.offer_state NOT NULL DEFAULT 'pending',
  responded_at timestamptz,
  response_idempotency_key text,
  CHECK (expires_at > offered_at),
  UNIQUE (match_attempt_id, driver_user_id),
  UNIQUE (trip_id, response_idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS mobility_driver_offer_one_pending_idx
  ON mobility.driver_offer (driver_user_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS mobility_driver_offer_expiry_idx
  ON mobility.driver_offer (expires_at) WHERE state = 'pending';

-- The guard table is the final concurrency invariant: a driver has at most one live passenger assignment.
CREATE TABLE IF NOT EXISTS mobility.driver_assignment_guard (
  driver_user_id integer PRIMARY KEY REFERENCES mobility.driver_profile(user_id) ON DELETE RESTRICT,
  trip_id uuid NOT NULL UNIQUE REFERENCES mobility.ride_trip(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('reserved', 'en_route', 'arrived', 'on_trip')),
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE mobility.driver_presence
  DROP CONSTRAINT IF EXISTS mobility_driver_presence_active_trip_id_fkey;
ALTER TABLE mobility.driver_presence
  ADD CONSTRAINT mobility_driver_presence_active_trip_id_fkey
  FOREIGN KEY (active_trip_id) REFERENCES mobility.ride_trip(id) ON DELETE SET NULL;
ALTER TABLE mobility.driver_presence
  DROP CONSTRAINT IF EXISTS mobility_driver_presence_active_offer_id_fkey;
ALTER TABLE mobility.driver_presence
  ADD CONSTRAINT mobility_driver_presence_active_offer_id_fkey
  FOREIGN KEY (active_offer_id) REFERENCES mobility.driver_offer(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS mobility.trip_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES mobility.ride_trip(id) ON DELETE CASCADE,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  event_type text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('rider', 'driver', 'system', 'operator', 'provider')),
  actor_user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
  correlation_id uuid NOT NULL,
  idempotency_key text,
  previous_state mobility.trip_state,
  next_state mobility.trip_state,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, sequence_no),
  UNIQUE (trip_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS mobility_trip_event_trip_time_idx
  ON mobility.trip_event (trip_id, occurred_at ASC);

-- The ledger is internal accounting evidence. It does not itself custody funds.
CREATE TABLE IF NOT EXISTS mobility.ledger_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_code text NOT NULL UNIQUE,
  account_class text NOT NULL CHECK (account_class IN ('asset', 'liability', 'revenue', 'expense', 'contra_revenue')),
  currency char(3) NOT NULL DEFAULT 'NGN',
  owner_kind text NOT NULL CHECK (owner_kind IN ('platform', 'rider', 'driver', 'tax_authority', 'provider')),
  owner_key text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mobility.ledger_transaction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  trip_id uuid REFERENCES mobility.ride_trip(id) ON DELETE RESTRICT,
  transaction_type text NOT NULL CHECK (transaction_type IN (
    'fare_capture', 'provider_fee', 'driver_earning', 'tax_accrual',
    'promotion', 'refund', 'chargeback', 'payout_settlement', 'adjustment'
  )),
  description text NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mobility.ledger_posting (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES mobility.ledger_transaction(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mobility.ledger_account(id) ON DELETE RESTRICT,
  direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mobility_ledger_posting_transaction_idx ON mobility.ledger_posting (transaction_id);
CREATE INDEX IF NOT EXISTS mobility_ledger_posting_account_idx ON mobility.ledger_posting (account_id, created_at DESC);

-- Enforces balanced postings after all postings for a transaction are written by the transaction procedure.
CREATE OR REPLACE FUNCTION mobility.assert_balanced_ledger(p_transaction_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  debit_total bigint;
  credit_total bigint;
BEGIN
  SELECT COALESCE(SUM(amount_kobo) FILTER (WHERE direction = 'debit'), 0),
         COALESCE(SUM(amount_kobo) FILTER (WHERE direction = 'credit'), 0)
    INTO debit_total, credit_total
    FROM mobility.ledger_posting
   WHERE transaction_id = p_transaction_id;
  IF debit_total = 0 OR debit_total <> credit_total THEN
    RAISE EXCEPTION 'unbalanced ledger transaction %, debit %, credit %',
      p_transaction_id, debit_total, credit_total
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS mobility.provider_payment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL UNIQUE REFERENCES mobility.ride_trip(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_reference text NOT NULL,
  provider_customer_reference text,
  provider_split_reference text,
  provider_event_id text,
  amount_kobo bigint NOT NULL CHECK (amount_kobo >= 0),
  currency char(3) NOT NULL DEFAULT 'NGN',
  state mobility.payment_state NOT NULL DEFAULT 'created',
  raw_provider_status text,
  authorised_at timestamptz,
  captured_at timestamptz,
  settled_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_reference),
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE IF NOT EXISTS mobility.trip_settlement (
  trip_id uuid PRIMARY KEY REFERENCES mobility.ride_trip(id) ON DELETE RESTRICT,
  allocation_policy_version text NOT NULL,
  currency char(3) NOT NULL DEFAULT 'NGN',
  gross_fare_kobo bigint NOT NULL CHECK (gross_fare_kobo > 0),
  driver_earnings_kobo bigint NOT NULL CHECK (driver_earnings_kobo >= 0),
  platform_commission_kobo bigint NOT NULL CHECK (platform_commission_kobo >= 0),
  tax_and_statutory_kobo bigint NOT NULL CHECK (tax_and_statutory_kobo >= 0),
  provider_fee_kobo bigint NOT NULL DEFAULT 0 CHECK (provider_fee_kobo >= 0),
  payout_hold_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK (gross_fare_kobo = driver_earnings_kobo + platform_commission_kobo + tax_and_statutory_kobo)
);

CREATE TABLE IF NOT EXISTS mobility.provider_webhook_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text,
  payload_sha512 bytea NOT NULL,
  signature_valid boolean NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_error text,
  raw_payload jsonb NOT NULL,
  UNIQUE (provider, provider_event_id),
  UNIQUE (provider, payload_sha512)
);

CREATE TABLE IF NOT EXISTS mobility.driver_payout_recipient (
  driver_user_id integer PRIMARY KEY REFERENCES mobility.driver_profile(user_id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_recipient_reference text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'verified', 'blocked', 'revoked')),
  verified_at timestamptz,
  changed_at timestamptz NOT NULL DEFAULT NOW(),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_recipient_reference)
);

CREATE TABLE IF NOT EXISTS mobility.driver_payout_instruction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_user_id integer NOT NULL REFERENCES mobility.driver_profile(user_id) ON DELETE RESTRICT,
  trip_id uuid NOT NULL UNIQUE REFERENCES mobility.ride_trip(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_recipient_reference text NOT NULL,
  provider_transfer_reference text NOT NULL,
  amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),
  currency char(3) NOT NULL DEFAULT 'NGN',
  state mobility.payout_state NOT NULL DEFAULT 'held',
  eligible_at timestamptz NOT NULL,
  submitted_at timestamptz,
  settled_at timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_transfer_reference)
);
CREATE INDEX IF NOT EXISTS mobility_driver_payout_releasable_idx
  ON mobility.driver_payout_instruction (eligible_at, created_at)
  WHERE state IN ('held', 'queued');

CREATE TABLE IF NOT EXISTS mobility.outbox_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text
);
CREATE INDEX IF NOT EXISTS mobility_outbox_unpublished_idx
  ON mobility.outbox_event (created_at) WHERE published_at IS NULL;

-- Atomically accepts a currently pending driver offer. The API passes an idempotency key
-- unique to this acceptance action. The next application step publishes cache/push effects
-- from the outbox only after this commit.
CREATE OR REPLACE FUNCTION mobility.accept_driver_offer(
  p_offer_id uuid,
  p_driver_user_id integer,
  p_idempotency_key text,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (trip_id uuid, driver_user_id integer, new_trip_state mobility.trip_state)
LANGUAGE plpgsql AS $$
DECLARE
  v_offer mobility.driver_offer%ROWTYPE;
  v_trip mobility.ride_trip%ROWTYPE;
  v_presence mobility.driver_presence%ROWTYPE;
  v_sequence integer;
BEGIN
  SELECT * INTO v_offer
    FROM mobility.driver_offer
   WHERE id = p_offer_id
   FOR UPDATE;

  IF NOT FOUND OR v_offer.driver_user_id <> p_driver_user_id THEN
    RAISE EXCEPTION 'offer not found for driver' USING ERRCODE = 'P0002';
  END IF;

  IF v_offer.state = 'accepted' AND v_offer.response_idempotency_key = p_idempotency_key THEN
    RETURN QUERY SELECT v_offer.trip_id, p_driver_user_id, 'driver_reserved'::mobility.trip_state;
    RETURN;
  END IF;

  IF v_offer.state <> 'pending' OR v_offer.expires_at <= p_now THEN
    RAISE EXCEPTION 'offer is no longer eligible for acceptance' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_trip FROM mobility.ride_trip WHERE id = v_offer.trip_id FOR UPDATE;
  IF v_trip.state NOT IN ('matching', 'driver_offered') THEN
    RAISE EXCEPTION 'trip is not matchable' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_presence
    FROM mobility.driver_presence AS dp
   WHERE dp.driver_user_id = p_driver_user_id
   FOR UPDATE;
  IF NOT FOUND OR v_presence.state NOT IN ('available', 'offer_pending')
     OR v_presence.location_valid_until IS NULL OR v_presence.location_valid_until <= p_now THEN
    RAISE EXCEPTION 'driver is not currently reservable' USING ERRCODE = '23514';
  END IF;

  INSERT INTO mobility.driver_assignment_guard (driver_user_id, trip_id, state, lease_expires_at)
  VALUES (p_driver_user_id, v_offer.trip_id, 'reserved', p_now + interval '2 minutes');

  UPDATE mobility.driver_offer
     SET state = 'accepted', responded_at = p_now, response_idempotency_key = p_idempotency_key
   WHERE id = p_offer_id;

  UPDATE mobility.driver_offer AS other_offer
     SET state = 'cancelled', responded_at = p_now
   WHERE other_offer.trip_id = v_offer.trip_id AND other_offer.id <> p_offer_id AND other_offer.state = 'pending';

  UPDATE mobility.driver_presence AS dp
     SET state = 'reserved', active_trip_id = v_offer.trip_id, active_offer_id = NULL,
         offer_expires_at = NULL, reservation_expires_at = p_now + interval '2 minutes',
         version = version + 1, updated_at = p_now
   WHERE dp.driver_user_id = p_driver_user_id;

  UPDATE mobility.ride_trip
     SET state = 'driver_reserved', assigned_driver_user_id = p_driver_user_id,
         state_version = state_version + 1, updated_at = p_now
   WHERE id = v_offer.trip_id;

  SELECT COALESCE(MAX(te.sequence_no), 0) + 1 INTO v_sequence
    FROM mobility.trip_event AS te WHERE te.trip_id = v_offer.trip_id;

  INSERT INTO mobility.trip_event (
    trip_id, sequence_no, event_type, actor_kind, actor_user_id,
    correlation_id, idempotency_key, previous_state, next_state, payload, occurred_at
  ) VALUES (
    v_offer.trip_id, v_sequence, 'driver_offer_accepted', 'driver', p_driver_user_id,
    gen_random_uuid(), p_idempotency_key, v_trip.state, 'driver_reserved',
    jsonb_build_object('offer_id', p_offer_id), p_now
  );

  INSERT INTO mobility.outbox_event (aggregate_type, aggregate_id, event_type, payload)
  VALUES (
    'ride_trip', v_offer.trip_id, 'ride.driver_reserved',
    jsonb_build_object('trip_id', v_offer.trip_id, 'driver_user_id', p_driver_user_id, 'offer_id', p_offer_id)
  );

  RETURN QUERY SELECT v_offer.trip_id, p_driver_user_id, 'driver_reserved'::mobility.trip_state;
END;
$$;


-- Operational notes:
-- 1. PostgreSQL remains authoritative. Redis is a rebuildable accelerator only.
-- 2. Rotate/partition mobility.driver_location_sample; retain fine-grained location no longer than the approved privacy schedule.
-- 3. Use application migrations to grant only necessary schema privileges; drivers/riders never connect directly to PostgreSQL.
-- 4. A separate procedure must create balanced mobility.ledger_posting rows and call mobility.assert_balanced_ledger before commit.
-- 5. Provider payments and payouts transition only after signature validation + provider-side verification, never from a client callback.
