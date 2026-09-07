-- Depends on 0026 and the private-beta lifecycle migrations through 0042.
-- Category, quality, support, and business attribution are PostgreSQL-authoritative.

CREATE SCHEMA IF NOT EXISTS mobility;

DO $$ BEGIN
  CREATE TYPE mobility.service_category_state AS ENUM ('active', 'paused', 'retired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE mobility.driver_category_state AS ENUM ('eligible', 'suspended', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE mobility.support_case_state AS ENUM ('open', 'assigned', 'awaiting_requester', 'resolved', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE mobility.support_case_action AS ENUM ('assign', 'request_information', 'resolve', 'reopen', 'close');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS mobility.service_category (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id uuid NOT NULL REFERENCES mobility.service_zone(id) ON DELETE RESTRICT,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{2,31}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 96),
  state mobility.service_category_state NOT NULL DEFAULT 'paused',
  min_passengers smallint NOT NULL CHECK (min_passengers BETWEEN 1 AND 8),
  max_passengers smallint NOT NULL CHECK (max_passengers BETWEEN min_passengers AND 8),
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE (zone_id, code),
  CHECK ((state = 'retired') = (retired_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS mobility_service_category_active_idx
  ON mobility.service_category (zone_id, code) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS mobility.driver_service_category (
  driver_user_id integer NOT NULL REFERENCES mobility.driver_profile(user_id) ON DELETE RESTRICT,
  service_category_id uuid NOT NULL REFERENCES mobility.service_category(id) ON DELETE RESTRICT,
  vehicle_id uuid NOT NULL REFERENCES mobility.vehicle(id) ON DELETE RESTRICT,
  state mobility.driver_category_state NOT NULL DEFAULT 'eligible',
  approved_at timestamptz,
  expires_at timestamptz,
  approved_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (driver_user_id, service_category_id),
  CHECK (expires_at IS NULL OR approved_at IS NULL OR expires_at > approved_at)
);
CREATE INDEX IF NOT EXISTS mobility_driver_service_category_match_idx
  ON mobility.driver_service_category (service_category_id, driver_user_id)
  WHERE state = 'eligible';

ALTER TABLE mobility.ride_trip
  ADD COLUMN IF NOT EXISTS service_category_id uuid REFERENCES mobility.service_category(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS mobility_ride_trip_category_idx
  ON mobility.ride_trip (service_category_id, state, updated_at DESC) WHERE service_category_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mobility.trip_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES mobility.ride_trip(id) ON DELETE RESTRICT,
  author_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  recipient_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  score smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
  tags jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tags) = 'array' AND jsonb_array_length(tags) <= 8),
  comment text CHECK (comment IS NULL OR length(comment) BETWEEN 1 AND 1000),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, author_user_id),
  UNIQUE (author_user_id, idempotency_key),
  CHECK (author_user_id <> recipient_user_id)
);
CREATE INDEX IF NOT EXISTS mobility_trip_feedback_recipient_idx
  ON mobility.trip_feedback (recipient_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mobility.trip_support_case (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES mobility.ride_trip(id) ON DELETE RESTRICT,
  requester_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  case_type text NOT NULL CHECK (case_type IN ('fare_question', 'trip_quality', 'lost_item', 'safety_follow_up', 'accessibility', 'other')),
  state mobility.support_case_state NOT NULL DEFAULT 'open',
  assigned_operator_user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
  subject text NOT NULL CHECK (length(subject) BETWEEN 3 AND 160),
  description text NOT NULL CHECK (length(description) BETWEEN 3 AND 4000),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requester_user_id, idempotency_key),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS mobility_trip_support_case_queue_idx
  ON mobility.trip_support_case (state, opened_at) WHERE state NOT IN ('closed', 'resolved');

CREATE TABLE IF NOT EXISTS mobility.trip_support_case_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES mobility.trip_support_case(id) ON DELETE RESTRICT,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  actor_user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.]{2,63}$'),
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, sequence_no),
  UNIQUE (case_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS mobility.business_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 160),
  billing_email citext NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'suspended', 'closed')) DEFAULT 'active',
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 64),
  created_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK ((state = 'closed') = (closed_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS mobility.business_traveler (
  business_account_id uuid NOT NULL REFERENCES mobility.business_account(id) ON DELETE RESTRICT,
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  employee_reference text CHECK (employee_reference IS NULL OR length(employee_reference) BETWEEN 1 AND 128),
  monthly_budget_kobo bigint CHECK (monthly_budget_kobo IS NULL OR monthly_budget_kobo >= 0),
  active boolean NOT NULL DEFAULT true,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  PRIMARY KEY (business_account_id, user_id),
  CHECK ((active AND removed_at IS NULL) OR (NOT active AND removed_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS mobility.business_trip_attribution (
  trip_id uuid PRIMARY KEY REFERENCES mobility.ride_trip(id) ON DELETE RESTRICT,
  business_account_id uuid NOT NULL REFERENCES mobility.business_account(id) ON DELETE RESTRICT,
  traveler_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  cost_center text CHECK (cost_center IS NULL OR length(cost_center) BETWEEN 1 AND 64),
  attribution_state text NOT NULL CHECK (attribution_state IN ('requested', 'approved', 'rejected', 'invoiced')) DEFAULT 'requested',
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  approved_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  CHECK ((attribution_state = 'approved') = (approved_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION mobility.prevent_private_beta_experience_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, mobility AS $$
BEGIN RAISE EXCEPTION 'case and feedback timelines are append-only' USING ERRCODE = '55000'; END;
$$;
DROP TRIGGER IF EXISTS mobility_trip_support_case_event_append_only ON mobility.trip_support_case_event;
CREATE TRIGGER mobility_trip_support_case_event_append_only BEFORE UPDATE OR DELETE ON mobility.trip_support_case_event
FOR EACH ROW EXECUTE FUNCTION mobility.prevent_private_beta_experience_mutation();

CREATE OR REPLACE FUNCTION mobility.select_trip_service_category(
  p_trip_id uuid, p_rider_user_id integer, p_service_category_id uuid, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, mobility AS $$
DECLARE v_trip mobility.ride_trip%ROWTYPE; v_category mobility.service_category%ROWTYPE;
BEGIN
  SELECT * INTO v_trip FROM mobility.ride_trip WHERE id=p_trip_id FOR UPDATE;
  IF NOT FOUND OR v_trip.rider_user_id <> p_rider_user_id OR v_trip.state <> 'quote_created' THEN RAISE EXCEPTION 'trip is not eligible for category selection' USING ERRCODE='23514'; END IF;
  SELECT * INTO v_category FROM mobility.service_category WHERE id=p_service_category_id FOR SHARE;
  IF NOT FOUND OR v_category.zone_id <> v_trip.zone_id OR v_category.state <> 'active' THEN RAISE EXCEPTION 'service category is unavailable for trip zone' USING ERRCODE='23514'; END IF;
  UPDATE mobility.ride_trip AS trip SET service_category_id=p_service_category_id, updated_at=p_now WHERE trip.id=p_trip_id;
  RETURN p_service_category_id;
END;
$$;

CREATE OR REPLACE FUNCTION mobility.submit_trip_feedback(
  p_trip_id uuid, p_author_user_id integer, p_score smallint, p_tags jsonb, p_comment text, p_idempotency_key text, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, mobility AS $$
DECLARE v_trip mobility.ride_trip%ROWTYPE; v_recipient integer; v_feedback_id uuid;
BEGIN
  IF p_score NOT BETWEEN 1 AND 5 OR jsonb_typeof(p_tags) <> 'array' OR jsonb_array_length(p_tags) > 8 OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid feedback input' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_trip FROM mobility.ride_trip WHERE id=p_trip_id FOR SHARE;
  IF NOT FOUND OR v_trip.state NOT IN ('completed', 'completed_pending_payment') THEN RAISE EXCEPTION 'trip is not eligible for feedback' USING ERRCODE = '23514'; END IF;
  IF p_author_user_id = v_trip.rider_user_id THEN v_recipient := v_trip.assigned_driver_user_id;
  ELSIF p_author_user_id = v_trip.assigned_driver_user_id THEN v_recipient := v_trip.rider_user_id;
  ELSE RAISE EXCEPTION 'feedback author is not a trip participant' USING ERRCODE = 'P0002'; END IF;
  IF v_recipient IS NULL THEN RAISE EXCEPTION 'feedback recipient is unavailable' USING ERRCODE = '23514'; END IF;
  SELECT id INTO v_feedback_id FROM mobility.trip_feedback WHERE author_user_id=p_author_user_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN RETURN v_feedback_id; END IF;
  INSERT INTO mobility.trip_feedback (trip_id, author_user_id, recipient_user_id, score, tags, comment, idempotency_key, created_at)
  VALUES (p_trip_id,p_author_user_id,v_recipient,p_score,p_tags,p_comment,p_idempotency_key,p_now) RETURNING id INTO v_feedback_id;
  RETURN v_feedback_id;
END;
$$;

CREATE OR REPLACE FUNCTION mobility.create_trip_support_case(
  p_trip_id uuid, p_requester_user_id integer, p_case_type text, p_subject text, p_description text, p_idempotency_key text, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, mobility AS $$
DECLARE v_trip mobility.ride_trip%ROWTYPE; v_case_id uuid;
BEGIN
  IF p_case_type NOT IN ('fare_question','trip_quality','lost_item','safety_follow_up','accessibility','other') OR length(p_subject) NOT BETWEEN 3 AND 160 OR length(p_description) NOT BETWEEN 3 AND 4000 OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid support case input' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_trip FROM mobility.ride_trip WHERE id=p_trip_id FOR SHARE;
  IF NOT FOUND OR (v_trip.rider_user_id <> p_requester_user_id AND v_trip.assigned_driver_user_id IS DISTINCT FROM p_requester_user_id) THEN RAISE EXCEPTION 'trip not found for requester' USING ERRCODE='P0002'; END IF;
  SELECT id INTO v_case_id FROM mobility.trip_support_case WHERE requester_user_id=p_requester_user_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN RETURN v_case_id; END IF;
  INSERT INTO mobility.trip_support_case (trip_id, requester_user_id, case_type, subject, description, idempotency_key, opened_at, updated_at)
  VALUES (p_trip_id,p_requester_user_id,p_case_type,p_subject,p_description,p_idempotency_key,p_now,p_now) RETURNING id INTO v_case_id;
  INSERT INTO mobility.trip_support_case_event (case_id,sequence_no,actor_user_id,action,idempotency_key,created_at)
  VALUES (v_case_id,1,p_requester_user_id,'case.opened',p_idempotency_key,p_now);
  RETURN v_case_id;
END;
$$;

CREATE OR REPLACE FUNCTION mobility.attribute_business_trip(
  p_trip_id uuid, p_traveler_user_id integer, p_business_account_id uuid, p_cost_center text, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, mobility AS $$
DECLARE v_trip mobility.ride_trip%ROWTYPE;
BEGIN
  SELECT * INTO v_trip FROM mobility.ride_trip WHERE id=p_trip_id FOR SHARE;
  IF NOT FOUND OR v_trip.rider_user_id <> p_traveler_user_id OR v_trip.state NOT IN ('quote_created','requested','matching','driver_offered','driver_reserved') THEN RAISE EXCEPTION 'trip is not eligible for business attribution' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM mobility.business_account AS account JOIN mobility.business_traveler AS traveler ON traveler.business_account_id=account.id WHERE account.id=p_business_account_id AND account.state='active' AND traveler.user_id=p_traveler_user_id AND traveler.active) THEN RAISE EXCEPTION 'traveler is not active for business account' USING ERRCODE='23514'; END IF;
  INSERT INTO mobility.business_trip_attribution (trip_id,business_account_id,traveler_user_id,cost_center,created_at)
  VALUES (p_trip_id,p_business_account_id,p_traveler_user_id,p_cost_center,p_now)
  ON CONFLICT (trip_id) DO UPDATE SET business_account_id=EXCLUDED.business_account_id, traveler_user_id=EXCLUDED.traveler_user_id, cost_center=EXCLUDED.cost_center, created_at=EXCLUDED.created_at
  WHERE mobility.business_trip_attribution.attribution_state='requested';
  RETURN 'requested';
END;
$$;

REVOKE ALL ON mobility.service_category, mobility.driver_service_category, mobility.trip_feedback, mobility.trip_support_case, mobility.trip_support_case_event, mobility.business_account, mobility.business_traveler, mobility.business_trip_attribution FROM PUBLIC;
REVOKE ALL ON FUNCTION mobility.select_trip_service_category(uuid,integer,uuid,timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION mobility.submit_trip_feedback(uuid,integer,smallint,jsonb,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION mobility.create_trip_support_case(uuid,integer,text,text,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION mobility.attribute_business_trip(uuid,integer,uuid,text,timestamptz) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mobility_trip_lifecycle_service') THEN
    GRANT USAGE ON SCHEMA mobility TO mobility_trip_lifecycle_service;
    GRANT SELECT ON mobility.service_category, mobility.driver_service_category, mobility.trip_feedback, mobility.trip_support_case, mobility.trip_support_case_event, mobility.business_account, mobility.business_traveler, mobility.business_trip_attribution TO mobility_trip_lifecycle_service;
    GRANT EXECUTE ON FUNCTION mobility.select_trip_service_category(uuid,integer,uuid,timestamp with time zone) TO mobility_trip_lifecycle_service;
    GRANT EXECUTE ON FUNCTION mobility.submit_trip_feedback(uuid,integer,smallint,jsonb,text,text,timestamptz) TO mobility_trip_lifecycle_service;
    GRANT EXECUTE ON FUNCTION mobility.create_trip_support_case(uuid,integer,text,text,text,text,timestamptz) TO mobility_trip_lifecycle_service;
    GRANT EXECUTE ON FUNCTION mobility.attribute_business_trip(uuid,integer,uuid,text,timestamptz) TO mobility_trip_lifecycle_service;
  END IF;
END $$;
-- Append this block to the end of drizzle/0043_private_beta_experience_and_business.sql
-- only while 0043 remains uncommitted and unapplied outside disposable databases.
-- If 0043 has reached a persistent shared environment, create a new additive migration
-- and use a staged data migration instead of rewriting history.
--
-- This block closes two schema-level lifecycle gaps:
--   1. support-case actions are implemented as locked, idempotent staff transitions;
--   2. business-attribution approval/rejection/invoicing has account-scoped authorization
--      and an append-only audit timeline.
--
-- It does not create a payment, payout, provider settlement, invoice receivable, or
-- ledger entry. PostgreSQL remains authoritative for these workflow states.

-- =============================================================================
-- Support-case transition completion
-- =============================================================================

ALTER TABLE mobility.trip_support_case_event
  ADD COLUMN IF NOT EXISTS assigned_operator_user_id integer
    REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS previous_state mobility.support_case_state,
  ADD COLUMN IF NOT EXISTS next_state mobility.support_case_state;

-- The support-event trigger is append-only. If historical rows exist without state
-- values, do not rewrite those records in place. Use a separately approved additive
-- migration with a preserved legacy representation instead.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM mobility.trip_support_case_event
    WHERE previous_state IS NULL OR next_state IS NULL
  ) THEN
    RAISE EXCEPTION 'cannot add required state fields to populated append-only support timeline'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE mobility.trip_support_case_event
  ALTER COLUMN previous_state SET NOT NULL,
  ALTER COLUMN next_state SET NOT NULL;

CREATE OR REPLACE FUNCTION mobility.next_trip_support_case_event_sequence(
  p_case_id uuid
)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = pg_catalog, mobility
AS $$
  SELECT COALESCE(MAX(sequence_no), 0) + 1
  FROM mobility.trip_support_case_event
  WHERE case_id = p_case_id
$$;

CREATE OR REPLACE FUNCTION mobility.create_trip_support_case(
  p_trip_id uuid,
  p_requester_user_id integer,
  p_case_type text,
  p_subject text,
  p_description text,
  p_idempotency_key text,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, mobility
AS $$
DECLARE
  v_trip mobility.ride_trip%ROWTYPE;
  v_case_id uuid;
BEGIN
  IF p_case_type NOT IN (
       'fare_question', 'trip_quality', 'lost_item',
       'safety_follow_up', 'accessibility', 'other'
     )
     OR length(p_subject) NOT BETWEEN 3 AND 160
     OR length(p_description) NOT BETWEEN 3 AND 4000
     OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN
    RAISE EXCEPTION 'invalid support case input' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_requester_user_id::text || ':' || p_idempotency_key, 0)
  );

  SELECT * INTO v_trip
  FROM mobility.ride_trip
  WHERE id = p_trip_id
  FOR SHARE;
  IF NOT FOUND
     OR (
       v_trip.rider_user_id <> p_requester_user_id
       AND v_trip.assigned_driver_user_id IS DISTINCT FROM p_requester_user_id
     ) THEN
    RAISE EXCEPTION 'trip not found for requester' USING ERRCODE = 'P0002';
  END IF;

  SELECT id INTO v_case_id
  FROM mobility.trip_support_case
  WHERE requester_user_id = p_requester_user_id
    AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_case_id;
  END IF;

  INSERT INTO mobility.trip_support_case (
    trip_id,
    requester_user_id,
    case_type,
    subject,
    description,
    idempotency_key,
    opened_at,
    updated_at
  ) VALUES (
    p_trip_id,
    p_requester_user_id,
    p_case_type,
    p_subject,
    p_description,
    p_idempotency_key,
    p_now,
    p_now
  )
  RETURNING id INTO v_case_id;

  INSERT INTO mobility.trip_support_case_event (
    case_id,
    sequence_no,
    actor_user_id,
    assigned_operator_user_id,
    action,
    previous_state,
    next_state,
    note,
    idempotency_key,
    created_at
  ) VALUES (
    v_case_id,
    1,
    p_requester_user_id,
    NULL,
    'case.opened',
    'open',
    'open',
    NULL,
    p_idempotency_key,
    p_now
  );

  INSERT INTO mobility.outbox_event (
    aggregate_type,
    aggregate_id,
    event_type,
    payload
  ) VALUES (
    'trip_support_case',
    v_case_id,
    'support.case_opened',
    jsonb_build_object('case_id', v_case_id, 'trip_id', p_trip_id)
  );

  RETURN v_case_id;
END;
$$;

CREATE OR REPLACE FUNCTION mobility.apply_trip_support_case_action(
  p_case_id uuid,
  p_operator_user_id integer,
  p_action mobility.support_case_action,
  p_idempotency_key text,
  p_note text DEFAULT NULL,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (
  case_id uuid,
  previous_state mobility.support_case_state,
  next_state mobility.support_case_state,
  assigned_operator_user_id integer,
  resolved_at timestamptz,
  closed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, mobility
AS $$
#variable_conflict use_column
DECLARE
  v_case mobility.trip_support_case%ROWTYPE;
  v_existing mobility.trip_support_case_event%ROWTYPE;
  v_next mobility.support_case_state;
  v_assigned_operator_user_id integer;
  v_note text;
BEGIN
  IF p_case_id IS NULL
     OR p_operator_user_id IS NULL
     OR p_operator_user_id <= 0
     OR p_action IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN
    RAISE EXCEPTION 'invalid support case action input' USING ERRCODE = '22023';
  END IF;

  v_note := NULLIF(btrim(p_note), '');
  IF v_note IS NOT NULL AND length(v_note) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'invalid support case action note' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.users AS operator_user
  WHERE operator_user.id = p_operator_user_id
    AND operator_user.role = 'admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator is not authorized for support case actions'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_case
  FROM mobility.trip_support_case
  WHERE id = p_case_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'support case not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_existing
  FROM mobility.trip_support_case_event AS event_row
  WHERE event_row.case_id = p_case_id
    AND event_row.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.action <> ('case.' || p_action::text) THEN
      RAISE EXCEPTION 'idempotency key belongs to another support case action'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY
    SELECT
      v_case.id,
      v_existing.previous_state,
      v_existing.next_state,
      v_existing.assigned_operator_user_id,
      v_case.resolved_at,
      v_case.closed_at;
    RETURN;
  END IF;

  v_next := v_case.state;
  v_assigned_operator_user_id := v_case.assigned_operator_user_id;

  CASE p_action
    WHEN 'assign' THEN
      IF v_case.state NOT IN ('open', 'assigned', 'awaiting_requester') THEN
        RAISE EXCEPTION 'support case cannot be assigned in current state'
          USING ERRCODE = '23514';
      END IF;
      v_next := 'assigned';
      v_assigned_operator_user_id := p_operator_user_id;

    WHEN 'request_information' THEN
      IF v_case.state NOT IN ('open', 'assigned') THEN
        RAISE EXCEPTION 'information cannot be requested in current state'
          USING ERRCODE = '23514';
      END IF;
      IF v_note IS NULL THEN
        RAISE EXCEPTION 'information request note is required' USING ERRCODE = '22023';
      END IF;
      v_next := 'awaiting_requester';
      v_assigned_operator_user_id := COALESCE(
        v_assigned_operator_user_id,
        p_operator_user_id
      );

    WHEN 'resolve' THEN
      IF v_case.state NOT IN ('assigned', 'awaiting_requester') THEN
        RAISE EXCEPTION 'support case must be assigned before resolution'
          USING ERRCODE = '23514';
      END IF;
      IF v_note IS NULL THEN
        RAISE EXCEPTION 'resolution note is required' USING ERRCODE = '22023';
      END IF;
      v_next := 'resolved';
      v_assigned_operator_user_id := COALESCE(
        v_assigned_operator_user_id,
        p_operator_user_id
      );

    WHEN 'reopen' THEN
      IF v_case.state <> 'resolved' THEN
        RAISE EXCEPTION 'only a resolved support case may be reopened'
          USING ERRCODE = '23514';
      END IF;
      IF v_note IS NULL THEN
        RAISE EXCEPTION 'reopen note is required' USING ERRCODE = '22023';
      END IF;
      v_next := 'assigned';
      v_assigned_operator_user_id := p_operator_user_id;

    WHEN 'close' THEN
      IF v_case.state <> 'resolved' THEN
        RAISE EXCEPTION 'support case must be resolved before closure'
          USING ERRCODE = '23514';
      END IF;
      IF v_note IS NULL THEN
        RAISE EXCEPTION 'closure note is required' USING ERRCODE = '22023';
      END IF;
      v_next := 'closed';
      v_assigned_operator_user_id := COALESCE(
        v_assigned_operator_user_id,
        p_operator_user_id
      );

    ELSE
      RAISE EXCEPTION 'unsupported support case action' USING ERRCODE = '22023';
  END CASE;

  UPDATE mobility.trip_support_case AS support_case
     SET state = v_next,
         assigned_operator_user_id = v_assigned_operator_user_id,
         resolved_at = CASE
           WHEN v_next = 'resolved' THEN p_now
           WHEN p_action = 'reopen' THEN NULL
           ELSE support_case.resolved_at
         END,
         closed_at = CASE
           WHEN v_next = 'closed' THEN p_now
           ELSE support_case.closed_at
         END,
         updated_at = p_now
   WHERE support_case.id = p_case_id;

  INSERT INTO mobility.trip_support_case_event (
    case_id,
    sequence_no,
    actor_user_id,
    assigned_operator_user_id,
    action,
    previous_state,
    next_state,
    note,
    idempotency_key,
    created_at
  ) VALUES (
    p_case_id,
    mobility.next_trip_support_case_event_sequence(p_case_id),
    p_operator_user_id,
    v_assigned_operator_user_id,
    'case.' || p_action::text,
    v_case.state,
    v_next,
    v_note,
    p_idempotency_key,
    p_now
  );

  INSERT INTO mobility.outbox_event (
    aggregate_type,
    aggregate_id,
    event_type,
    payload
  ) VALUES (
    'trip_support_case',
    p_case_id,
    'support.case_' || p_action::text,
    jsonb_build_object(
      'case_id', p_case_id,
      'previous_state', v_case.state::text,
      'next_state', v_next::text,
      'assigned_operator_user_id', v_assigned_operator_user_id
    )
  );

  RETURN QUERY
  SELECT
    p_case_id,
    v_case.state,
    v_next,
    v_assigned_operator_user_id,
    CASE
      WHEN v_next = 'resolved' THEN p_now
      WHEN p_action = 'reopen' THEN NULL
      ELSE v_case.resolved_at
    END,
    CASE WHEN v_next = 'closed' THEN p_now ELSE v_case.closed_at END;
END;
$$;

-- =============================================================================
-- Business attribution transition completion
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE mobility.business_trip_attribution_state AS ENUM (
    'requested', 'approved', 'rejected', 'invoiced'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mobility.business_trip_attribution_action AS ENUM (
    'request', 'approve', 'reject', 'mark_invoiced'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mobility.business_account_operator_role AS ENUM (
    'approver', 'billing'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Existing 0043 declares this column as text. The defensive precheck avoids a
-- lossy cast if this completion is accidentally appended to a populated database.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM mobility.business_trip_attribution
    WHERE attribution_state NOT IN ('requested', 'approved', 'rejected', 'invoiced')
  ) THEN
    RAISE EXCEPTION 'business attribution has unsupported state for enum conversion'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

-- The original uncommitted 0043 table declares two unnamed check constraints,
-- both expressed against a text state. Remove only those table-level checks before
-- converting the column; the named enum-safe checks below replace them atomically.
DO $$
DECLARE
  v_constraint record;
BEGIN
  FOR v_constraint IN
    SELECT constraint_row.conname
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'mobility.business_trip_attribution'::regclass
      AND constraint_row.contype = 'c'
  LOOP
    EXECUTE format(
      'ALTER TABLE mobility.business_trip_attribution DROP CONSTRAINT %I',
      v_constraint.conname
    );
  END LOOP;
END;
$$;

ALTER TABLE mobility.business_trip_attribution
  ALTER COLUMN attribution_state DROP DEFAULT,
  ALTER COLUMN attribution_state TYPE mobility.business_trip_attribution_state
    USING attribution_state::mobility.business_trip_attribution_state,
  ALTER COLUMN attribution_state SET DEFAULT 'requested'::mobility.business_trip_attribution_state,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_code text,
  ADD COLUMN IF NOT EXISTS invoiced_at timestamptz,
  ADD COLUMN IF NOT EXISTS invoiced_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS invoice_reference text;

ALTER TABLE mobility.business_trip_attribution
  ADD CONSTRAINT mobility_business_trip_attribution_approved_ck CHECK (
    (attribution_state IN (
      'approved'::mobility.business_trip_attribution_state,
      'invoiced'::mobility.business_trip_attribution_state
    )) = (
      approved_at IS NOT NULL AND approved_by IS NOT NULL
    )
  ),
  ADD CONSTRAINT mobility_business_trip_attribution_rejected_ck CHECK (
    (attribution_state = 'rejected'::mobility.business_trip_attribution_state) = (
      rejected_at IS NOT NULL
      AND rejected_by IS NOT NULL
      AND rejection_code IS NOT NULL
    )
  ),
  ADD CONSTRAINT mobility_business_trip_attribution_invoiced_ck CHECK (
    (attribution_state = 'invoiced'::mobility.business_trip_attribution_state) = (
      invoiced_at IS NOT NULL
      AND invoiced_by IS NOT NULL
      AND invoice_reference IS NOT NULL
    )
  ),
  ADD CONSTRAINT mobility_business_trip_attribution_rejection_code_ck CHECK (
    rejection_code IS NULL
    OR rejection_code ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  ADD CONSTRAINT mobility_business_trip_attribution_invoice_reference_ck CHECK (
    invoice_reference IS NULL
    OR invoice_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$'
  );

CREATE TABLE IF NOT EXISTS mobility.business_account_operator (
  business_account_id uuid NOT NULL REFERENCES mobility.business_account(id) ON DELETE RESTRICT,
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  role mobility.business_account_operator_role NOT NULL,
  active boolean NOT NULL DEFAULT true,
  granted_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (business_account_id, user_id, role),
  CHECK ((active AND revoked_at IS NULL) OR (NOT active AND revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS mobility_business_account_operator_active_idx
  ON mobility.business_account_operator (business_account_id, user_id, role)
  WHERE active;

CREATE TABLE IF NOT EXISTS mobility.business_trip_attribution_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES mobility.business_trip_attribution(trip_id) ON DELETE RESTRICT,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  action mobility.business_trip_attribution_action NOT NULL,
  previous_state mobility.business_trip_attribution_state NOT NULL,
  next_state mobility.business_trip_attribution_state NOT NULL,
  reason_code text,
  invoice_reference text,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, sequence_no),
  UNIQUE (trip_id, idempotency_key),
  CHECK (reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  CHECK (
    invoice_reference IS NULL
    OR invoice_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$'
  )
);

CREATE OR REPLACE FUNCTION mobility.prevent_business_attribution_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, mobility
AS $$
BEGIN
  RAISE EXCEPTION 'business attribution timeline is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS mobility_business_trip_attribution_event_append_only
  ON mobility.business_trip_attribution_event;
CREATE TRIGGER mobility_business_trip_attribution_event_append_only
  BEFORE UPDATE OR DELETE ON mobility.business_trip_attribution_event
  FOR EACH ROW EXECUTE FUNCTION mobility.prevent_business_attribution_event_mutation();

CREATE OR REPLACE FUNCTION mobility.next_business_trip_attribution_event_sequence(
  p_trip_id uuid
)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = pg_catalog, mobility
AS $$
  SELECT COALESCE(MAX(sequence_no), 0) + 1
  FROM mobility.business_trip_attribution_event
  WHERE trip_id = p_trip_id
$$;

-- The requester-facing signature is preserved. A requested attribution is immutable
-- with respect to account and cost center after creation; a new request must be made
-- through a separately designed correction/cancellation workflow rather than silently
-- changing an approval target in place.
CREATE OR REPLACE FUNCTION mobility.attribute_business_trip(
  p_trip_id uuid,
  p_traveler_user_id integer,
  p_business_account_id uuid,
  p_cost_center text,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, mobility
AS $$
DECLARE
  v_trip mobility.ride_trip%ROWTYPE;
  v_existing mobility.business_trip_attribution%ROWTYPE;
BEGIN
  IF p_trip_id IS NULL
     OR p_traveler_user_id IS NULL
     OR p_traveler_user_id <= 0
     OR p_business_account_id IS NULL
     OR (p_cost_center IS NOT NULL AND length(p_cost_center) NOT BETWEEN 1 AND 64) THEN
    RAISE EXCEPTION 'invalid business attribution request input' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_trip_id::text, 0));

  SELECT * INTO v_trip
  FROM mobility.ride_trip
  WHERE id = p_trip_id
  FOR SHARE;
  IF NOT FOUND
     OR v_trip.rider_user_id <> p_traveler_user_id
     OR v_trip.state NOT IN (
       'quote_created', 'requested', 'matching', 'driver_offered', 'driver_reserved'
     ) THEN
    RAISE EXCEPTION 'trip is not eligible for business attribution' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM mobility.business_account AS account
    JOIN mobility.business_traveler AS traveler
      ON traveler.business_account_id = account.id
    WHERE account.id = p_business_account_id
      AND account.state = 'active'
      AND traveler.user_id = p_traveler_user_id
      AND traveler.active
  ) THEN
    RAISE EXCEPTION 'traveler is not active for business account'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_existing
  FROM mobility.business_trip_attribution
  WHERE trip_id = p_trip_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.business_account_id <> p_business_account_id
       OR v_existing.traveler_user_id <> p_traveler_user_id
       OR v_existing.cost_center IS DISTINCT FROM NULLIF(btrim(p_cost_center), '') THEN
      RAISE EXCEPTION 'existing business attribution cannot be changed'
        USING ERRCODE = '23514';
    END IF;
    RETURN v_existing.attribution_state::text;
  END IF;

  INSERT INTO mobility.business_trip_attribution (
    trip_id,
    business_account_id,
    traveler_user_id,
    cost_center,
    attribution_state,
    created_at
  ) VALUES (
    p_trip_id,
    p_business_account_id,
    p_traveler_user_id,
    NULLIF(btrim(p_cost_center), ''),
    'requested',
    p_now
  );

  INSERT INTO mobility.business_trip_attribution_event (
    trip_id,
    sequence_no,
    actor_user_id,
    action,
    previous_state,
    next_state,
    reason_code,
    invoice_reference,
    idempotency_key,
    created_at
  ) VALUES (
    p_trip_id,
    1,
    p_traveler_user_id,
    'request',
    'requested',
    'requested',
    NULL,
    NULL,
    'business-attribution-request:' || p_trip_id::text,
    p_now
  );

  INSERT INTO mobility.outbox_event (
    aggregate_type,
    aggregate_id,
    event_type,
    payload
  ) VALUES (
    'business_trip_attribution',
    p_trip_id,
    'business.attribution_requested',
    jsonb_build_object(
      'trip_id', p_trip_id,
      'business_account_id', p_business_account_id,
      'traveler_user_id', p_traveler_user_id
    )
  );

  RETURN 'requested';
END;
$$;

CREATE OR REPLACE FUNCTION mobility.apply_business_trip_attribution_action(
  p_trip_id uuid,
  p_operator_user_id integer,
  p_action mobility.business_trip_attribution_action,
  p_idempotency_key text,
  p_reason_code text DEFAULT NULL,
  p_invoice_reference text DEFAULT NULL,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (
  trip_id uuid,
  previous_state mobility.business_trip_attribution_state,
  next_state mobility.business_trip_attribution_state,
  business_account_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, mobility
AS $$
#variable_conflict use_column
DECLARE
  v_attribution mobility.business_trip_attribution%ROWTYPE;
  v_existing mobility.business_trip_attribution_event%ROWTYPE;
  v_trip_state mobility.trip_state;
  v_required_role mobility.business_account_operator_role;
  v_next mobility.business_trip_attribution_state;
  v_reason_code text;
  v_invoice_reference text;
BEGIN
  IF p_trip_id IS NULL
     OR p_operator_user_id IS NULL
     OR p_operator_user_id <= 0
     OR p_action IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN
    RAISE EXCEPTION 'invalid business attribution action input'
      USING ERRCODE = '22023';
  END IF;

  v_reason_code := NULLIF(btrim(p_reason_code), '');
  v_invoice_reference := NULLIF(btrim(p_invoice_reference), '');

  SELECT * INTO v_attribution
  FROM mobility.business_trip_attribution
  WHERE trip_id = p_trip_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'business trip attribution not found' USING ERRCODE = 'P0002';
  END IF;

  v_required_role := CASE
    WHEN p_action IN (
      'approve'::mobility.business_trip_attribution_action,
      'reject'::mobility.business_trip_attribution_action
    ) THEN 'approver'::mobility.business_account_operator_role
    WHEN p_action = 'mark_invoiced'::mobility.business_trip_attribution_action
      THEN 'billing'::mobility.business_account_operator_role
    ELSE NULL
  END;
  IF v_required_role IS NULL THEN
    RAISE EXCEPTION 'unsupported business attribution action'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM mobility.business_account_operator AS operator_assignment
  WHERE operator_assignment.business_account_id = v_attribution.business_account_id
    AND operator_assignment.user_id = p_operator_user_id
    AND operator_assignment.role = v_required_role
    AND operator_assignment.active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator is not authorized for business attribution action'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_existing
  FROM mobility.business_trip_attribution_event AS event_row
  WHERE event_row.trip_id = p_trip_id
    AND event_row.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.action <> p_action THEN
      RAISE EXCEPTION 'idempotency key belongs to another business attribution action'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY
    SELECT
      p_trip_id,
      v_existing.previous_state,
      v_existing.next_state,
      v_attribution.business_account_id;
    RETURN;
  END IF;

  CASE p_action
    WHEN 'approve' THEN
      IF v_attribution.attribution_state <> 'requested'::mobility.business_trip_attribution_state THEN
        RAISE EXCEPTION 'only requested attribution may be approved'
          USING ERRCODE = '23514';
      END IF;
      v_next := 'approved';

    WHEN 'reject' THEN
      IF v_attribution.attribution_state <> 'requested'::mobility.business_trip_attribution_state THEN
        RAISE EXCEPTION 'only requested attribution may be rejected'
          USING ERRCODE = '23514';
      END IF;
      IF v_reason_code IS NULL
         OR v_reason_code !~ '^[a-z][a-z0-9_]{2,63}$' THEN
        RAISE EXCEPTION 'valid rejection reason code is required'
          USING ERRCODE = '22023';
      END IF;
      v_next := 'rejected';

    WHEN 'mark_invoiced' THEN
      IF v_attribution.attribution_state <> 'approved'::mobility.business_trip_attribution_state THEN
        RAISE EXCEPTION 'only approved attribution may be invoiced'
          USING ERRCODE = '23514';
      END IF;
      IF v_invoice_reference IS NULL
         OR v_invoice_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$' THEN
        RAISE EXCEPTION 'valid immutable invoice reference is required'
          USING ERRCODE = '22023';
      END IF;
      SELECT state INTO v_trip_state
      FROM mobility.ride_trip
      WHERE id = p_trip_id
      FOR SHARE;
      IF NOT FOUND
         OR v_trip_state NOT IN (
           'completed_pending_payment'::mobility.trip_state,
           'completed'::mobility.trip_state
         ) THEN
        RAISE EXCEPTION 'trip must be completed before attribution is invoiced'
          USING ERRCODE = '23514';
      END IF;
      v_next := 'invoiced';

    ELSE
      RAISE EXCEPTION 'unsupported business attribution action'
        USING ERRCODE = '22023';
  END CASE;

  UPDATE mobility.business_trip_attribution AS attribution
     SET attribution_state = v_next,
         approved_at = CASE
           WHEN v_next = 'approved' THEN p_now
           ELSE attribution.approved_at
         END,
         approved_by = CASE
           WHEN v_next = 'approved' THEN p_operator_user_id
           ELSE attribution.approved_by
         END,
         rejected_at = CASE
           WHEN v_next = 'rejected' THEN p_now
           ELSE attribution.rejected_at
         END,
         rejected_by = CASE
           WHEN v_next = 'rejected' THEN p_operator_user_id
           ELSE attribution.rejected_by
         END,
         rejection_code = CASE
           WHEN v_next = 'rejected' THEN v_reason_code
           ELSE attribution.rejection_code
         END,
         invoiced_at = CASE
           WHEN v_next = 'invoiced' THEN p_now
           ELSE attribution.invoiced_at
         END,
         invoiced_by = CASE
           WHEN v_next = 'invoiced' THEN p_operator_user_id
           ELSE attribution.invoiced_by
         END,
         invoice_reference = CASE
           WHEN v_next = 'invoiced' THEN v_invoice_reference
           ELSE attribution.invoice_reference
         END
   WHERE attribution.trip_id = p_trip_id;

  INSERT INTO mobility.business_trip_attribution_event (
    trip_id,
    sequence_no,
    actor_user_id,
    action,
    previous_state,
    next_state,
    reason_code,
    invoice_reference,
    idempotency_key,
    created_at
  ) VALUES (
    p_trip_id,
    mobility.next_business_trip_attribution_event_sequence(p_trip_id),
    p_operator_user_id,
    p_action,
    v_attribution.attribution_state,
    v_next,
    v_reason_code,
    v_invoice_reference,
    p_idempotency_key,
    p_now
  );

  INSERT INTO mobility.outbox_event (
    aggregate_type,
    aggregate_id,
    event_type,
    payload
  ) VALUES (
    'business_trip_attribution',
    p_trip_id,
    'business.attribution_' || p_action::text,
    jsonb_build_object(
      'trip_id', p_trip_id,
      'business_account_id', v_attribution.business_account_id,
      'previous_state', v_attribution.attribution_state::text,
      'next_state', v_next::text,
      'reason_code', v_reason_code,
      'invoice_reference', v_invoice_reference
    )
  );

  RETURN QUERY
  SELECT
    p_trip_id,
    v_attribution.attribution_state,
    v_next,
    v_attribution.business_account_id;
END;
$$;

-- =============================================================================
-- Least-privilege grants
-- =============================================================================

REVOKE ALL ON FUNCTION mobility.next_trip_support_case_event_sequence(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION mobility.apply_trip_support_case_action(
  uuid,
  integer,
  mobility.support_case_action,
  text,
  text,
  timestamptz
) FROM PUBLIC;

REVOKE ALL ON mobility.business_account_operator,
              mobility.business_trip_attribution_event
FROM PUBLIC;
REVOKE ALL ON FUNCTION mobility.prevent_business_attribution_event_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION mobility.next_business_trip_attribution_event_sequence(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION mobility.apply_business_trip_attribution_action(
  uuid,
  integer,
  mobility.business_trip_attribution_action,
  text,
  text,
  text,
  timestamptz
) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mobility_support_operator_service') THEN
    GRANT USAGE ON SCHEMA mobility TO mobility_support_operator_service;
    GRANT SELECT ON mobility.trip_support_case, mobility.trip_support_case_event
      TO mobility_support_operator_service;
    REVOKE INSERT, UPDATE, DELETE ON mobility.trip_support_case,
                                     mobility.trip_support_case_event
      FROM mobility_support_operator_service;
    GRANT EXECUTE ON FUNCTION mobility.apply_trip_support_case_action(
      uuid,
      integer,
      mobility.support_case_action,
      text,
      text,
      timestamptz
    ) TO mobility_support_operator_service;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mobility_business_billing_service') THEN
    GRANT USAGE ON SCHEMA mobility TO mobility_business_billing_service;
    GRANT SELECT ON mobility.business_account,
                    mobility.business_traveler,
                    mobility.business_account_operator,
                    mobility.business_trip_attribution,
                    mobility.business_trip_attribution_event
      TO mobility_business_billing_service;
    REVOKE INSERT, UPDATE, DELETE ON mobility.business_account_operator,
                                     mobility.business_trip_attribution,
                                     mobility.business_trip_attribution_event
      FROM mobility_business_billing_service;
    GRANT EXECUTE ON FUNCTION mobility.apply_business_trip_attribution_action(
      uuid,
      integer,
      mobility.business_trip_attribution_action,
      text,
      text,
      text,
      timestamptz
    ) TO mobility_business_billing_service;
  END IF;
END $$;
