-- Independently designed rental-asset tracking, geofence, and safe remote-control authority.
-- PostgreSQL/PostGIS is authoritative for all state, evidence, and interlocks.
-- This migration deliberately has no engine-stop/engine-cut/ignition-off command.

DO $$ BEGIN
  CREATE TYPE vehicle_access.tracker_provider_kind AS ENUM (
    'generic_webhook','samsara_webhook','geotab_feed','traccar_rest','oem_gateway','aftermarket_gateway'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE vehicle_access.tracker_state AS ENUM ('pending','active','suspended','revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE vehicle_access.tracker_signal_kind AS ENUM ('position','engine','tamper','emergency','provider_geofence','command_ack');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE vehicle_access.rental_geofence_kind AS ENUM ('restricted','return_zone','service_zone');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE vehicle_access.rental_geofence_event_kind AS ENUM ('entered','exited');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE vehicle_access.tracker_risk_flag_code AS ENUM (
    'restricted_geofence_entered','tracker_integrity_low','tracker_tamper','emergency_active',
    'stale_tracking','implausible_location_jump','speed_ignition_conflict','payment_grace_elapsed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE vehicle_access.tracker_risk_severity AS ENUM ('info','warning','critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE vehicle_access.rental_payment_tracking_state AS ENUM ('past_due','cured','disputed','unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE vehicle_access.prevent_next_start_case_state AS ENUM ('observed','requested','authorized','dispatched','acknowledged','rejected','cancelled','expired','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE vehicle_access.prevent_next_start_command_state AS ENUM ('authorized','claimed','dispatched','acknowledged','failed','cancelled','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS vehicle_access.tracker_provider (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_provider_id uuid NOT NULL REFERENCES vehicle_access.fleet_provider(id) ON DELETE RESTRICT,
  provider_kind vehicle_access.tracker_provider_kind NOT NULL,
  integration_key text NOT NULL CHECK (integration_key ~ '^[a-z][a-z0-9_.-]{2,80}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 160),
  credential_ref text NOT NULL CHECK (length(credential_ref) BETWEEN 8 AND 160),
  state vehicle_access.tracker_state NOT NULL DEFAULT 'pending',
  created_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  UNIQUE (fleet_provider_id, integration_key),
  UNIQUE (fleet_provider_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS vehicle_access_tracker_provider_active_idx
  ON vehicle_access.tracker_provider (fleet_provider_id, provider_kind, created_at DESC) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS vehicle_access.vehicle_asset_tracker (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES vehicle_access.vehicle_asset(id) ON DELETE RESTRICT,
  tracker_provider_id uuid NOT NULL REFERENCES vehicle_access.tracker_provider(id) ON DELETE RESTRICT,
  external_device_id text NOT NULL CHECK (length(external_device_id) BETWEEN 3 AND 160),
  device_identifier_digest bytea NOT NULL CHECK (octet_length(device_identifier_digest) = 32),
  supports_prevent_next_start boolean NOT NULL DEFAULT false,
  state vehicle_access.tracker_state NOT NULL DEFAULT 'pending',
  activated_at timestamptz NULL,
  revoked_at timestamptz NULL,
  registered_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  UNIQUE (tracker_provider_id, external_device_id),
  UNIQUE (asset_id, idempotency_key),
  CHECK ((state = 'active') = (activated_at IS NOT NULL)),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS vehicle_access_asset_tracker_live_idx
  ON vehicle_access.vehicle_asset_tracker (asset_id, updated_at DESC) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS vehicle_access.rental_asset_geofence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES vehicle_access.vehicle_asset(id) ON DELETE RESTRICT,
  geofence_kind vehicle_access.rental_geofence_kind NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,62}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 160),
  boundary geography(MultiPolygon,4326) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  UNIQUE (asset_id, code),
  UNIQUE (asset_id, idempotency_key),
  CHECK (ST_IsValid(boundary::geometry))
);
CREATE INDEX IF NOT EXISTS vehicle_access_rental_asset_geofence_gix
  ON vehicle_access.rental_asset_geofence USING gist (boundary) WHERE active;

CREATE TABLE IF NOT EXISTS vehicle_access.contract_tracker_control_consent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES vehicle_access.access_contract(id) ON DELETE RESTRICT,
  worker_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  consent_version text NOT NULL CHECK (length(consent_version) BETWEEN 1 AND 64),
  consent_sha256_hex text NOT NULL CHECK (consent_sha256_hex ~ '^[a-f0-9]{64}$'),
  accepted_at timestamptz NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  UNIQUE (contract_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS vehicle_access.vehicle_tracker_signal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracker_id uuid NOT NULL REFERENCES vehicle_access.vehicle_asset_tracker(id) ON DELETE RESTRICT,
  asset_id uuid NOT NULL REFERENCES vehicle_access.vehicle_asset(id) ON DELETE RESTRICT,
  contract_id uuid NULL REFERENCES vehicle_access.access_contract(id) ON DELETE RESTRICT,
  signal_kind vehicle_access.tracker_signal_kind NOT NULL,
  external_event_id text NOT NULL CHECK (length(external_event_id) BETWEEN 8 AND 160),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  point geography(Point,4326) NULL,
  speed_kph numeric(7,2) NULL CHECK (speed_kph IS NULL OR (speed_kph >= 0 AND speed_kph <= 400)),
  heading_degrees numeric(6,2) NULL CHECK (heading_degrees IS NULL OR (heading_degrees >= 0 AND heading_degrees < 360)),
  accuracy_m numeric(10,2) NULL CHECK (accuracy_m IS NULL OR (accuracy_m >= 0 AND accuracy_m <= 100000)),
  odometer_km numeric(12,2) NULL CHECK (odometer_km IS NULL OR odometer_km >= 0),
  ignition_on boolean NULL,
  integrity_score smallint NOT NULL CHECK (integrity_score BETWEEN 0 AND 100),
  payload_digest bytea NOT NULL CHECK (octet_length(payload_digest) = 32),
  normalized_payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(normalized_payload) = 'object'),
  UNIQUE (tracker_id, external_event_id),
  CHECK ((signal_kind <> 'position') OR point IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS vehicle_access_tracker_signal_asset_observed_idx
  ON vehicle_access.vehicle_tracker_signal (asset_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS vehicle_access_tracker_signal_contract_observed_idx
  ON vehicle_access.vehicle_tracker_signal (contract_id, observed_at DESC) WHERE contract_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS vehicle_access_tracker_signal_point_gix
  ON vehicle_access.vehicle_tracker_signal USING gist (point) WHERE point IS NOT NULL;

CREATE TABLE IF NOT EXISTS vehicle_access.rental_asset_geofence_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_geofence_id uuid NOT NULL REFERENCES vehicle_access.rental_asset_geofence(id) ON DELETE RESTRICT,
  tracker_signal_id uuid NOT NULL REFERENCES vehicle_access.vehicle_tracker_signal(id) ON DELETE RESTRICT,
  asset_id uuid NOT NULL REFERENCES vehicle_access.vehicle_asset(id) ON DELETE RESTRICT,
  contract_id uuid NULL REFERENCES vehicle_access.access_contract(id) ON DELETE RESTRICT,
  event_kind vehicle_access.rental_geofence_event_kind NOT NULL,
  observed_at timestamptz NOT NULL,
  decision_digest bytea NOT NULL CHECK (octet_length(decision_digest) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (asset_geofence_id, tracker_signal_id)
);
CREATE INDEX IF NOT EXISTS vehicle_access_rental_geofence_event_asset_idx
  ON vehicle_access.rental_asset_geofence_event (asset_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS vehicle_access.rental_tracker_risk_flag (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES vehicle_access.vehicle_asset(id) ON DELETE RESTRICT,
  contract_id uuid NULL REFERENCES vehicle_access.access_contract(id) ON DELETE RESTRICT,
  tracker_signal_id uuid NULL REFERENCES vehicle_access.vehicle_tracker_signal(id) ON DELETE RESTRICT,
  payment_tracking_signal_id uuid NULL,
  flag_code vehicle_access.tracker_risk_flag_code NOT NULL,
  severity vehicle_access.tracker_risk_severity NOT NULL,
  fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  detected_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (fingerprint)
);
CREATE INDEX IF NOT EXISTS vehicle_access_rental_tracker_risk_asset_idx
  ON vehicle_access.rental_tracker_risk_flag (asset_id, detected_at DESC);

CREATE TABLE IF NOT EXISTS vehicle_access.rental_payment_tracking_signal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES vehicle_access.access_contract(id) ON DELETE RESTRICT,
  payment_reference_digest bytea NOT NULL CHECK (octet_length(payment_reference_digest) = 32),
  state vehicle_access.rental_payment_tracking_state NOT NULL,
  effective_at timestamptz NOT NULL,
  grace_ends_at timestamptz NULL,
  evidence_sha256_hex text NOT NULL CHECK (evidence_sha256_hex ~ '^[a-f0-9]{64}$'),
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_.-]{2,80}$'),
  received_by_user_id integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (contract_id, idempotency_key),
  CHECK ((state = 'past_due') = (grace_ends_at IS NOT NULL)),
  CHECK (grace_ends_at IS NULL OR grace_ends_at >= effective_at)
);
CREATE INDEX IF NOT EXISTS vehicle_access_payment_tracking_open_idx
  ON vehicle_access.rental_payment_tracking_signal (contract_id, grace_ends_at DESC) WHERE state = 'past_due';

ALTER TABLE vehicle_access.rental_tracker_risk_flag
  DROP CONSTRAINT IF EXISTS rental_tracker_risk_flag_payment_tracking_signal_fkey;
ALTER TABLE vehicle_access.rental_tracker_risk_flag
  ADD CONSTRAINT rental_tracker_risk_flag_payment_tracking_signal_fkey
  FOREIGN KEY (payment_tracking_signal_id) REFERENCES vehicle_access.rental_payment_tracking_signal(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS vehicle_access.prevent_next_start_case (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES vehicle_access.vehicle_asset(id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL REFERENCES vehicle_access.access_contract(id) ON DELETE RESTRICT,
  tracker_id uuid NOT NULL REFERENCES vehicle_access.vehicle_asset_tracker(id) ON DELETE RESTRICT,
  payment_tracking_signal_id uuid NOT NULL REFERENCES vehicle_access.rental_payment_tracking_signal(id) ON DELETE RESTRICT,
  state vehicle_access.prevent_next_start_case_state NOT NULL DEFAULT 'observed',
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_.-]{2,95}$'),
  requested_by_user_id integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  requested_at timestamptz NULL,
  authorized_by_user_id integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  authorized_at timestamptz NULL,
  expires_at timestamptz NOT NULL,
  terminal_reason text NULL CHECK (terminal_reason IS NULL OR length(terminal_reason) BETWEEN 3 AND 1000),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (contract_id, idempotency_key),
  CHECK ((state IN ('requested','authorized','dispatched','acknowledged')) = (requested_at IS NOT NULL)),
  CHECK ((state IN ('authorized','dispatched','acknowledged')) = (authorized_at IS NOT NULL)),
  CHECK (authorized_by_user_id IS NULL OR authorized_by_user_id <> requested_by_user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_access_prevent_next_start_one_open_case_idx
  ON vehicle_access.prevent_next_start_case (contract_id)
  WHERE state IN ('observed','requested','authorized','dispatched');

CREATE TABLE IF NOT EXISTS vehicle_access.prevent_next_start_command (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL UNIQUE REFERENCES vehicle_access.prevent_next_start_case(id) ON DELETE RESTRICT,
  tracker_id uuid NOT NULL REFERENCES vehicle_access.vehicle_asset_tracker(id) ON DELETE RESTRICT,
  state vehicle_access.prevent_next_start_command_state NOT NULL DEFAULT 'authorized',
  claim_token uuid NULL UNIQUE,
  claimed_by text NULL CHECK (claimed_by IS NULL OR length(claimed_by) BETWEEN 3 AND 128),
  claimed_at timestamptz NULL,
  provider_command_id text NULL CHECK (provider_command_id IS NULL OR length(provider_command_id) BETWEEN 3 AND 160),
  acknowledgement_sha256_hex text NULL CHECK (acknowledgement_sha256_hex IS NULL OR acknowledgement_sha256_hex ~ '^[a-f0-9]{64}$'),
  dispatched_at timestamptz NULL,
  acknowledged_at timestamptz NULL,
  terminal_reason text NULL CHECK (terminal_reason IS NULL OR length(terminal_reason) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state IN ('claimed','dispatched','acknowledged')) = (claim_token IS NOT NULL)),
  CHECK ((state IN ('dispatched','acknowledged')) = (dispatched_at IS NOT NULL)),
  CHECK ((state = 'acknowledged') = (acknowledged_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS vehicle_access.tracker_control_event (
  id bigserial PRIMARY KEY,
  aggregate_type text NOT NULL CHECK (aggregate_type IN ('tracker_provider','asset_tracker','asset_geofence','signal','payment_signal','prevent_next_start_case','prevent_next_start_command')),
  aggregate_id uuid NOT NULL,
  actor_user_id integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.-]{2,120}$'),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL,
  UNIQUE (aggregate_type, aggregate_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS vehicle_access_tracker_control_event_aggregate_idx
  ON vehicle_access.tracker_control_event (aggregate_type, aggregate_id, created_at DESC);

CREATE OR REPLACE FUNCTION vehicle_access.reject_tracker_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, vehicle_access AS $$
BEGIN
  RAISE EXCEPTION 'vehicle tracker evidence is append-only' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS vehicle_access_tracker_consent_append_only ON vehicle_access.contract_tracker_control_consent;
CREATE TRIGGER vehicle_access_tracker_consent_append_only
  BEFORE UPDATE OR DELETE ON vehicle_access.contract_tracker_control_consent
  FOR EACH ROW EXECUTE FUNCTION vehicle_access.reject_tracker_evidence_mutation();
DROP TRIGGER IF EXISTS vehicle_access_tracker_signal_append_only ON vehicle_access.vehicle_tracker_signal;
CREATE TRIGGER vehicle_access_tracker_signal_append_only
  BEFORE UPDATE OR DELETE ON vehicle_access.vehicle_tracker_signal
  FOR EACH ROW EXECUTE FUNCTION vehicle_access.reject_tracker_evidence_mutation();
DROP TRIGGER IF EXISTS vehicle_access_rental_geofence_event_append_only ON vehicle_access.rental_asset_geofence_event;
CREATE TRIGGER vehicle_access_rental_geofence_event_append_only
  BEFORE UPDATE OR DELETE ON vehicle_access.rental_asset_geofence_event
  FOR EACH ROW EXECUTE FUNCTION vehicle_access.reject_tracker_evidence_mutation();
DROP TRIGGER IF EXISTS vehicle_access_tracker_risk_flag_append_only ON vehicle_access.rental_tracker_risk_flag;
CREATE TRIGGER vehicle_access_tracker_risk_flag_append_only
  BEFORE UPDATE OR DELETE ON vehicle_access.rental_tracker_risk_flag
  FOR EACH ROW EXECUTE FUNCTION vehicle_access.reject_tracker_evidence_mutation();
DROP TRIGGER IF EXISTS vehicle_access_payment_tracking_signal_append_only ON vehicle_access.rental_payment_tracking_signal;
CREATE TRIGGER vehicle_access_payment_tracking_signal_append_only
  BEFORE UPDATE OR DELETE ON vehicle_access.rental_payment_tracking_signal
  FOR EACH ROW EXECUTE FUNCTION vehicle_access.reject_tracker_evidence_mutation();
DROP TRIGGER IF EXISTS vehicle_access_tracker_control_event_append_only ON vehicle_access.tracker_control_event;
CREATE TRIGGER vehicle_access_tracker_control_event_append_only
  BEFORE UPDATE OR DELETE ON vehicle_access.tracker_control_event
  FOR EACH ROW EXECUTE FUNCTION vehicle_access.reject_tracker_evidence_mutation();

CREATE OR REPLACE FUNCTION vehicle_access.append_tracker_control_event(
  p_type text, p_id uuid, p_actor integer, p_event_type text, p_detail jsonb, p_key text, p_now timestamptz
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
BEGIN
  INSERT INTO vehicle_access.tracker_control_event(aggregate_type,aggregate_id,actor_user_id,event_type,detail,idempotency_key,created_at)
  VALUES (p_type,p_id,p_actor,p_event_type,p_detail,p_key,p_now)
  ON CONFLICT (aggregate_type,aggregate_id,idempotency_key) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.create_tracker_provider(
  p_actor integer, p_fleet_provider uuid, p_kind vehicle_access.tracker_provider_kind, p_integration_key text,
  p_display_name text, p_credential_ref text, p_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE='42501'; END IF;
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' OR p_integration_key !~ '^[a-z][a-z0-9_.-]{2,80}$'
     OR length(coalesce(p_display_name,'')) NOT BETWEEN 2 AND 160 OR length(coalesce(p_credential_ref,'')) NOT BETWEEN 8 AND 160 THEN
    RAISE EXCEPTION 'invalid tracker provider input' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicle_access.fleet_provider WHERE id=p_fleet_provider AND state='active') THEN
    RAISE EXCEPTION 'active fleet provider required' USING ERRCODE='23514';
  END IF;
  SELECT id INTO v_id FROM vehicle_access.tracker_provider WHERE fleet_provider_id=p_fleet_provider AND idempotency_key=p_key;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO vehicle_access.tracker_provider(fleet_provider_id,provider_kind,integration_key,display_name,credential_ref,state,created_by_user_id,created_at,updated_at,idempotency_key)
  VALUES(p_fleet_provider,p_kind,p_integration_key,p_display_name,p_credential_ref,'active',p_actor,p_now,p_now,p_key) RETURNING id INTO v_id;
  PERFORM vehicle_access.append_tracker_control_event('tracker_provider',v_id,p_actor,'vehicle_access.tracker_provider.created',jsonb_build_object('kind',p_kind,'fleet_provider_id',p_fleet_provider),p_key,p_now);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.register_asset_tracker(
  p_actor integer,p_asset uuid,p_tracker_provider uuid,p_external_device_id text,p_device_identifier_sha256 text,
  p_supports_prevent_next_start boolean,p_key text,p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_id uuid; v_asset_provider uuid; v_tracker_provider uuid;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE='42501'; END IF;
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' OR length(coalesce(p_external_device_id,'')) NOT BETWEEN 3 AND 160 OR p_device_identifier_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid asset tracker input' USING ERRCODE='22023';
  END IF;
  SELECT provider_id INTO v_asset_provider FROM vehicle_access.vehicle_asset WHERE id=p_asset FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'asset not found' USING ERRCODE='P0002'; END IF;
  SELECT fleet_provider_id INTO v_tracker_provider FROM vehicle_access.tracker_provider WHERE id=p_tracker_provider AND state='active';
  IF NOT FOUND OR v_tracker_provider<>v_asset_provider THEN RAISE EXCEPTION 'active matching tracker provider required' USING ERRCODE='23514'; END IF;
  SELECT id INTO v_id FROM vehicle_access.vehicle_asset_tracker WHERE asset_id=p_asset AND idempotency_key=p_key;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO vehicle_access.vehicle_asset_tracker(asset_id,tracker_provider_id,external_device_id,device_identifier_digest,supports_prevent_next_start,state,activated_at,registered_by_user_id,created_at,updated_at,idempotency_key)
  VALUES(p_asset,p_tracker_provider,p_external_device_id,decode(p_device_identifier_sha256,'hex'),p_supports_prevent_next_start,'active',p_now,p_actor,p_now,p_now,p_key) RETURNING id INTO v_id;
  PERFORM vehicle_access.append_tracker_control_event('asset_tracker',v_id,p_actor,'vehicle_access.asset_tracker.registered',jsonb_build_object('asset_id',p_asset,'supports_prevent_next_start',p_supports_prevent_next_start),p_key,p_now);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.create_rental_asset_geofence(
  p_actor integer,p_asset uuid,p_kind vehicle_access.rental_geofence_kind,p_code text,p_display_name text,
  p_geojson jsonb,p_key text,p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_id uuid; v_boundary public.geography;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE='42501'; END IF;
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' OR upper(coalesce(p_code,'')) !~ '^[A-Z0-9][A-Z0-9_-]{1,62}$' OR length(coalesce(p_display_name,'')) NOT BETWEEN 2 AND 160 OR jsonb_typeof(p_geojson)<>'object' THEN
    RAISE EXCEPTION 'invalid rental geofence input' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM vehicle_access.vehicle_asset WHERE id=p_asset FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'asset not found' USING ERRCODE='P0002'; END IF;
  BEGIN
    v_boundary := public.ST_Multi(public.ST_SetSRID(public.ST_GeomFromGeoJSON(p_geojson::text),4326))::public.geography;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid rental geofence geometry' USING ERRCODE='22023';
  END;
  IF public.GeometryType(v_boundary::public.geometry) <> 'MULTIPOLYGON' OR NOT public.ST_IsValid(v_boundary::public.geometry) THEN RAISE EXCEPTION 'invalid rental geofence geometry' USING ERRCODE='22023'; END IF;
  SELECT id INTO v_id FROM vehicle_access.rental_asset_geofence WHERE asset_id=p_asset AND idempotency_key=p_key;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO vehicle_access.rental_asset_geofence(asset_id,geofence_kind,code,display_name,boundary,created_by_user_id,created_at,updated_at,idempotency_key)
  VALUES(p_asset,p_kind,upper(p_code),p_display_name,v_boundary,p_actor,p_now,p_now,p_key) RETURNING id INTO v_id;
  PERFORM vehicle_access.append_tracker_control_event('asset_geofence',v_id,p_actor,'vehicle_access.asset_geofence.created',jsonb_build_object('asset_id',p_asset,'kind',p_kind),p_key,p_now);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.record_tracker_control_consent(
  p_worker integer,p_contract uuid,p_version text,p_consent_sha256_hex text,p_key text,p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_id uuid; v_contract vehicle_access.access_contract%ROWTYPE;
BEGIN
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' OR length(coalesce(p_version,'')) NOT BETWEEN 1 AND 64 OR p_consent_sha256_hex !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid tracker consent input' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_contract FROM vehicle_access.access_contract WHERE id=p_contract FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract not found' USING ERRCODE='P0002'; END IF;
  IF v_contract.worker_user_id<>p_worker OR v_contract.state NOT IN ('requested','approved','active') THEN RAISE EXCEPTION 'contract worker consent required' USING ERRCODE='42501'; END IF;
  SELECT id INTO v_id FROM vehicle_access.contract_tracker_control_consent WHERE contract_id=p_contract AND idempotency_key=p_key;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO vehicle_access.contract_tracker_control_consent(contract_id,worker_user_id,consent_version,consent_sha256_hex,accepted_at,idempotency_key)
  VALUES(p_contract,p_worker,p_version,p_consent_sha256_hex,p_now,p_key) RETURNING id INTO v_id;
  PERFORM vehicle_access.append_tracker_control_event('prevent_next_start_case',p_contract,p_worker,'vehicle_access.tracker_control_consent.recorded',jsonb_build_object('consent_id',v_id,'version',p_version),p_key,p_now);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.insert_tracker_risk_flag(
  p_asset uuid,p_contract uuid,p_tracker_signal uuid,p_payment_signal uuid,p_code vehicle_access.tracker_risk_flag_code,
  p_severity vehicle_access.tracker_risk_severity,p_detail jsonb,p_detected timestamptz
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_fingerprint bytea;
BEGIN
  v_fingerprint := public.digest(jsonb_build_object('asset_id',p_asset,'contract_id',p_contract,'tracker_signal_id',p_tracker_signal,'payment_tracking_signal_id',p_payment_signal,'flag_code',p_code,'detail',p_detail)::text,'sha256');
  INSERT INTO vehicle_access.rental_tracker_risk_flag(asset_id,contract_id,tracker_signal_id,payment_tracking_signal_id,flag_code,severity,fingerprint,detail,detected_at)
  VALUES(p_asset,p_contract,p_tracker_signal,p_payment_signal,p_code,p_severity,v_fingerprint,p_detail,p_detected)
  ON CONFLICT (fingerprint) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.resolve_active_tracker_for_ingress(
  p_integration_key text,p_external_device_id text
) RETURNS TABLE(tracker_id uuid,provider_kind vehicle_access.tracker_provider_kind)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
  SELECT t.id, p.provider_kind
  FROM vehicle_access.tracker_provider p
  JOIN vehicle_access.vehicle_asset_tracker t ON t.tracker_provider_id=p.id
  WHERE p.integration_key=p_integration_key AND p.state='active' AND t.state='active'
    AND t.external_device_id=p_external_device_id
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.record_vehicle_tracker_signal(
  p_tracker uuid,p_external_event_id text,p_kind vehicle_access.tracker_signal_kind,p_observed_at timestamptz,
  p_latitude numeric,p_longitude numeric,p_speed_kph numeric,p_heading_degrees numeric,p_accuracy_m numeric,p_odometer_km numeric,
  p_ignition_on boolean,p_integrity_score smallint,p_payload_digest_hex text,p_normalized_payload jsonb,p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_id uuid; v_tracker vehicle_access.vehicle_asset_tracker%ROWTYPE; v_contract uuid; v_point public.geography; v_previous record; v_jump_kph numeric; v_geofence record;
BEGIN
  IF length(coalesce(p_external_event_id,'')) NOT BETWEEN 8 AND 160 OR p_payload_digest_hex !~ '^[a-f0-9]{64}$' OR jsonb_typeof(p_normalized_payload)<>'object'
     OR p_integrity_score NOT BETWEEN 0 AND 100 OR p_observed_at > p_now + interval '60 seconds'
     OR (p_latitude IS NOT NULL AND (p_latitude < -90 OR p_latitude > 90)) OR (p_longitude IS NOT NULL AND (p_longitude < -180 OR p_longitude > 180))
     OR ((p_latitude IS NULL) <> (p_longitude IS NULL)) OR (p_speed_kph IS NOT NULL AND (p_speed_kph < 0 OR p_speed_kph > 400)) THEN
    RAISE EXCEPTION 'invalid tracker signal' USING ERRCODE='22023';
  END IF;
  IF p_kind='position' AND p_latitude IS NULL THEN RAISE EXCEPTION 'position coordinates required' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_tracker FROM vehicle_access.vehicle_asset_tracker WHERE id=p_tracker AND state='active' FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM vehicle_access.tracker_provider WHERE id=v_tracker.tracker_provider_id AND state='active') THEN RAISE EXCEPTION 'active tracker required' USING ERRCODE='23514'; END IF;
  SELECT id INTO v_id FROM vehicle_access.vehicle_tracker_signal WHERE tracker_id=p_tracker AND external_event_id=p_external_event_id;
  IF v_id IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM vehicle_access.vehicle_tracker_signal WHERE id=v_id AND payload_digest=decode(p_payload_digest_hex,'hex')) THEN RAISE EXCEPTION 'tracker event id reused with different payload' USING ERRCODE='23505'; END IF;
    RETURN v_id;
  END IF;
  IF p_latitude IS NOT NULL THEN v_point := public.ST_SetSRID(public.ST_MakePoint(p_longitude,p_latitude),4326)::public.geography; END IF;
  SELECT id INTO v_contract FROM vehicle_access.access_contract
    WHERE asset_id=v_tracker.asset_id AND state='active' AND starts_at<=p_observed_at AND ends_at>p_observed_at
    ORDER BY activated_at DESC NULLS LAST LIMIT 1;
  INSERT INTO vehicle_access.vehicle_tracker_signal(tracker_id,asset_id,contract_id,signal_kind,external_event_id,observed_at,received_at,point,speed_kph,heading_degrees,accuracy_m,odometer_km,ignition_on,integrity_score,payload_digest,normalized_payload)
  VALUES(p_tracker,v_tracker.asset_id,v_contract,p_kind,p_external_event_id,p_observed_at,p_now,v_point,p_speed_kph,p_heading_degrees,p_accuracy_m,p_odometer_km,p_ignition_on,p_integrity_score,decode(p_payload_digest_hex,'hex'),p_normalized_payload)
  RETURNING id INTO v_id;
  IF p_integrity_score<75 THEN PERFORM vehicle_access.insert_tracker_risk_flag(v_tracker.asset_id,v_contract,v_id,NULL,'tracker_integrity_low','warning',jsonb_build_object('integrity_score',p_integrity_score),p_now); END IF;
  IF p_kind='tamper' THEN PERFORM vehicle_access.insert_tracker_risk_flag(v_tracker.asset_id,v_contract,v_id,NULL,'tracker_tamper','critical',jsonb_build_object('source','tracker'),p_now); END IF;
  IF p_kind='emergency' THEN PERFORM vehicle_access.insert_tracker_risk_flag(v_tracker.asset_id,v_contract,v_id,NULL,'emergency_active','critical',jsonb_build_object('source','tracker'),p_now); END IF;
  IF p_now-p_observed_at>interval '15 minutes' THEN PERFORM vehicle_access.insert_tracker_risk_flag(v_tracker.asset_id,v_contract,v_id,NULL,'stale_tracking','warning',jsonb_build_object('delay_seconds',extract(epoch FROM p_now-p_observed_at)::integer),p_now); END IF;
  IF p_speed_kph IS NOT NULL AND p_speed_kph>0.5 AND p_ignition_on=false THEN PERFORM vehicle_access.insert_tracker_risk_flag(v_tracker.asset_id,v_contract,v_id,NULL,'speed_ignition_conflict','critical',jsonb_build_object('speed_kph',p_speed_kph),p_now); END IF;
  IF v_point IS NOT NULL THEN
    SELECT point, observed_at INTO v_previous FROM vehicle_access.vehicle_tracker_signal
      WHERE tracker_id=p_tracker AND point IS NOT NULL AND id<>v_id AND observed_at<p_observed_at AND observed_at>=p_observed_at-interval '30 minutes'
      ORDER BY observed_at DESC LIMIT 1;
    IF FOUND AND extract(epoch FROM p_observed_at-v_previous.observed_at)>0 THEN
      v_jump_kph := public.ST_Distance(v_previous.point,v_point) / extract(epoch FROM p_observed_at-v_previous.observed_at) * 3.6;
      IF v_jump_kph>220 THEN PERFORM vehicle_access.insert_tracker_risk_flag(v_tracker.asset_id,v_contract,v_id,NULL,'implausible_location_jump','critical',jsonb_build_object('estimated_kph',round(v_jump_kph,2)),p_now); END IF;
    END IF;
    FOR v_geofence IN
      SELECT id,geofence_kind,
        public.ST_Covers(boundary::public.geometry,v_point::public.geometry) AS currently_inside,
        CASE WHEN v_previous.point IS NULL THEN false ELSE public.ST_Covers(boundary::public.geometry,v_previous.point::public.geometry) END AS previously_inside
      FROM vehicle_access.rental_asset_geofence
      WHERE asset_id=v_tracker.asset_id AND active
    LOOP
      IF v_geofence.currently_inside AND NOT v_geofence.previously_inside THEN
        INSERT INTO vehicle_access.rental_asset_geofence_event(asset_geofence_id,tracker_signal_id,asset_id,contract_id,event_kind,observed_at,decision_digest)
        VALUES(v_geofence.id,v_id,v_tracker.asset_id,v_contract,'entered',p_observed_at,public.digest(jsonb_build_object('geofence_id',v_geofence.id,'signal_id',v_id,'event','entered')::text,'sha256'))
        ON CONFLICT (asset_geofence_id,tracker_signal_id) DO NOTHING;
        IF v_geofence.geofence_kind='restricted' THEN PERFORM vehicle_access.insert_tracker_risk_flag(v_tracker.asset_id,v_contract,v_id,NULL,'restricted_geofence_entered','critical',jsonb_build_object('geofence_id',v_geofence.id),p_now); END IF;
      ELSIF NOT v_geofence.currently_inside AND v_geofence.previously_inside THEN
        INSERT INTO vehicle_access.rental_asset_geofence_event(asset_geofence_id,tracker_signal_id,asset_id,contract_id,event_kind,observed_at,decision_digest)
        VALUES(v_geofence.id,v_id,v_tracker.asset_id,v_contract,'exited',p_observed_at,public.digest(jsonb_build_object('geofence_id',v_geofence.id,'signal_id',v_id,'event','exited')::text,'sha256'))
        ON CONFLICT (asset_geofence_id,tracker_signal_id) DO NOTHING;
      END IF;
    END LOOP;
  END IF;
  PERFORM vehicle_access.append_tracker_control_event('signal',v_id,NULL,'vehicle_access.tracker_signal.recorded',jsonb_build_object('asset_id',v_tracker.asset_id,'contract_id',v_contract,'kind',p_kind),replace(p_external_event_id,':','_'),p_now);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.record_rental_payment_tracking_signal(
  p_actor integer,p_contract uuid,p_payment_reference_sha256_hex text,p_state vehicle_access.rental_payment_tracking_state,
  p_effective_at timestamptz,p_grace_ends_at timestamptz,p_evidence_sha256_hex text,p_source text,p_key text,p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_id uuid; v_contract vehicle_access.access_contract%ROWTYPE;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE='42501'; END IF;
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' OR p_payment_reference_sha256_hex !~ '^[a-f0-9]{64}$' OR p_evidence_sha256_hex !~ '^[a-f0-9]{64}$' OR p_source !~ '^[a-z][a-z0-9_.-]{2,80}$'
     OR (p_state='past_due' AND (p_grace_ends_at IS NULL OR p_grace_ends_at<p_effective_at OR p_grace_ends_at>p_effective_at+interval '30 days'))
     OR (p_state<>'past_due' AND p_grace_ends_at IS NOT NULL) THEN RAISE EXCEPTION 'invalid payment tracking signal' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_contract FROM vehicle_access.access_contract WHERE id=p_contract FOR UPDATE;
  IF NOT FOUND OR v_contract.state NOT IN ('approved','active','return_pending') THEN RAISE EXCEPTION 'rental contract required for payment tracking signal' USING ERRCODE='23514'; END IF;
  SELECT id INTO v_id FROM vehicle_access.rental_payment_tracking_signal WHERE contract_id=p_contract AND idempotency_key=p_key;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO vehicle_access.rental_payment_tracking_signal(contract_id,payment_reference_digest,state,effective_at,grace_ends_at,evidence_sha256_hex,source,received_by_user_id,idempotency_key,created_at)
  VALUES(p_contract,decode(p_payment_reference_sha256_hex,'hex'),p_state,p_effective_at,p_grace_ends_at,p_evidence_sha256_hex,p_source,p_actor,p_key,p_now) RETURNING id INTO v_id;
  IF p_state='past_due' AND p_grace_ends_at<=p_now THEN
    PERFORM vehicle_access.insert_tracker_risk_flag(v_contract.asset_id,p_contract,NULL,v_id,'payment_grace_elapsed','warning',jsonb_build_object('grace_ends_at',p_grace_ends_at,'source',p_source),p_now);
  END IF;
  PERFORM vehicle_access.append_tracker_control_event('payment_signal',v_id,p_actor,'vehicle_access.rental_payment_tracking_signal.recorded',jsonb_build_object('contract_id',p_contract,'state',p_state),p_key,p_now);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.assert_prevent_next_start_interlocks(p_case uuid,p_now timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_case vehicle_access.prevent_next_start_case%ROWTYPE; v_signal record;
BEGIN
  SELECT * INTO v_case FROM vehicle_access.prevent_next_start_case WHERE id=p_case FOR UPDATE;
  IF NOT FOUND OR v_case.state NOT IN ('requested','authorized') OR v_case.expires_at<=p_now THEN RAISE EXCEPTION 'prevent-next-start case is not dispatchable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM vehicle_access.access_contract c WHERE c.id=v_case.contract_id AND c.asset_id=v_case.asset_id AND c.state='active' AND c.ends_at>p_now) THEN RAISE EXCEPTION 'active rental contract required' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM vehicle_access.contract_tracker_control_consent WHERE contract_id=v_case.contract_id) THEN RAISE EXCEPTION 'tracker control consent required' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM vehicle_access.rental_payment_tracking_signal p WHERE p.id=v_case.payment_tracking_signal_id AND p.contract_id=v_case.contract_id AND p.state='past_due' AND p.grace_ends_at<=p_now)
     OR EXISTS(SELECT 1 FROM vehicle_access.rental_payment_tracking_signal p WHERE p.contract_id=v_case.contract_id AND p.state='cured' AND p.created_at>(SELECT created_at FROM vehicle_access.rental_payment_tracking_signal WHERE id=v_case.payment_tracking_signal_id)) THEN RAISE EXCEPTION 'uncured payment grace signal required' USING ERRCODE='23514'; END IF;
  SELECT id,observed_at,speed_kph,ignition_on INTO v_signal FROM vehicle_access.vehicle_tracker_signal WHERE tracker_id=v_case.tracker_id AND signal_kind='position' ORDER BY observed_at DESC LIMIT 1;
  IF NOT FOUND OR v_signal.observed_at<p_now-interval '2 minutes' OR coalesce(v_signal.speed_kph,999)>0.5 OR v_signal.ignition_on IS DISTINCT FROM false THEN RAISE EXCEPTION 'fresh stationary ignition-off tracker signal required' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM vehicle_access.rental_tracker_risk_flag WHERE contract_id=v_case.contract_id AND flag_code='emergency_active' AND detected_at>=p_now-interval '24 hours') THEN RAISE EXCEPTION 'emergency safety flag blocks remote control' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM vehicle_access.vehicle_asset_tracker WHERE id=v_case.tracker_id AND state='active' AND supports_prevent_next_start) THEN RAISE EXCEPTION 'tracker prevent-next-start capability required' USING ERRCODE='23514'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.request_prevent_next_start(
  p_actor integer,p_contract uuid,p_payment_tracking_signal uuid,p_reason_code text,p_key text,p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_case uuid; v_asset uuid; v_tracker uuid;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE='42501'; END IF;
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' OR p_reason_code !~ '^[a-z][a-z0-9_.-]{2,95}$' THEN RAISE EXCEPTION 'invalid prevent-next-start request' USING ERRCODE='22023'; END IF;
  SELECT asset_id INTO v_asset FROM vehicle_access.access_contract WHERE id=p_contract AND state='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active contract required' USING ERRCODE='23514'; END IF;
  SELECT id INTO v_case FROM vehicle_access.prevent_next_start_case WHERE contract_id=p_contract AND idempotency_key=p_key;
  IF v_case IS NOT NULL THEN RETURN v_case; END IF;
  SELECT id INTO v_tracker FROM vehicle_access.vehicle_asset_tracker WHERE asset_id=v_asset AND state='active' AND supports_prevent_next_start ORDER BY updated_at DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'active capable tracker required' USING ERRCODE='23514'; END IF;
  INSERT INTO vehicle_access.prevent_next_start_case(asset_id,contract_id,tracker_id,payment_tracking_signal_id,state,reason_code,requested_by_user_id,requested_at,expires_at,idempotency_key,created_at,updated_at)
  VALUES(v_asset,p_contract,v_tracker,p_payment_tracking_signal,'requested',p_reason_code,p_actor,p_now,p_now+interval '10 minutes',p_key,p_now,p_now) RETURNING id INTO v_case;
  PERFORM vehicle_access.assert_prevent_next_start_interlocks(v_case,p_now);
  PERFORM vehicle_access.append_tracker_control_event('prevent_next_start_case',v_case,p_actor,'vehicle_access.prevent_next_start.requested',jsonb_build_object('contract_id',p_contract,'payment_tracking_signal_id',p_payment_tracking_signal),p_key,p_now);
  RETURN v_case;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.authorize_prevent_next_start(
  p_actor integer,p_case uuid,p_key text,p_now timestamptz DEFAULT clock_timestamp()
) RETURNS vehicle_access.prevent_next_start_case_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_case vehicle_access.prevent_next_start_case%ROWTYPE;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE='42501'; END IF;
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid idempotency key' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_case FROM vehicle_access.prevent_next_start_case WHERE id=p_case FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'prevent-next-start case not found' USING ERRCODE='P0002'; END IF;
  IF v_case.state='authorized' AND v_case.authorized_by_user_id=p_actor THEN RETURN 'authorized'; END IF;
  IF v_case.state<>'requested' OR v_case.requested_by_user_id=p_actor THEN RAISE EXCEPTION 'independent operator authorization required' USING ERRCODE='42501'; END IF;
  PERFORM vehicle_access.assert_prevent_next_start_interlocks(p_case,p_now);
  UPDATE vehicle_access.prevent_next_start_case SET state='authorized',authorized_by_user_id=p_actor,authorized_at=p_now,updated_at=p_now WHERE id=p_case;
  INSERT INTO vehicle_access.prevent_next_start_command(case_id,tracker_id,state,created_at,updated_at) VALUES(p_case,v_case.tracker_id,'authorized',p_now,p_now);
  PERFORM vehicle_access.append_tracker_control_event('prevent_next_start_case',p_case,p_actor,'vehicle_access.prevent_next_start.authorized',jsonb_build_object('requested_by_user_id',v_case.requested_by_user_id),p_key,p_now);
  RETURN 'authorized';
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.cancel_prevent_next_start(
  p_actor integer,p_case uuid,p_reason text,p_key text,p_now timestamptz DEFAULT clock_timestamp()
) RETURNS vehicle_access.prevent_next_start_case_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_case vehicle_access.prevent_next_start_case%ROWTYPE;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE='42501'; END IF;
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' OR length(coalesce(p_reason,'')) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'invalid prevent-next-start cancellation' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_case FROM vehicle_access.prevent_next_start_case WHERE id=p_case FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'prevent-next-start case not found' USING ERRCODE='P0002'; END IF;
  IF v_case.state='cancelled' THEN RETURN 'cancelled'; END IF;
  IF v_case.state NOT IN ('requested','authorized') THEN RAISE EXCEPTION 'prevent-next-start case cannot be cancelled' USING ERRCODE='23514'; END IF;
  UPDATE vehicle_access.prevent_next_start_case SET state='cancelled',terminal_reason=p_reason,updated_at=p_now WHERE id=p_case;
  UPDATE vehicle_access.prevent_next_start_command SET state='cancelled',terminal_reason=p_reason,updated_at=p_now WHERE case_id=p_case AND state IN ('authorized','claimed');
  PERFORM vehicle_access.append_tracker_control_event('prevent_next_start_case',p_case,p_actor,'vehicle_access.prevent_next_start.cancelled',jsonb_build_object('reason',p_reason),p_key,p_now);
  RETURN 'cancelled';
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.claim_prevent_next_start_command(
  p_worker text,p_now timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE(command_id uuid,case_id uuid,claim_token uuid,tracker_id uuid,provider_kind vehicle_access.tracker_provider_kind,external_device_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_command vehicle_access.prevent_next_start_command%ROWTYPE;
BEGIN
  IF length(coalesce(p_worker,'')) NOT BETWEEN 3 AND 128 THEN RAISE EXCEPTION 'invalid tracker command worker' USING ERRCODE='22023'; END IF;
  SELECT c.* INTO v_command FROM vehicle_access.prevent_next_start_command c
  JOIN vehicle_access.prevent_next_start_case k ON k.id=c.case_id
  WHERE c.state='authorized' AND k.state='authorized' AND k.expires_at>p_now
  ORDER BY c.created_at ASC FOR UPDATE OF c, k SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM vehicle_access.assert_prevent_next_start_interlocks(v_command.case_id,p_now);
  UPDATE vehicle_access.prevent_next_start_command SET state='claimed',claim_token=gen_random_uuid(),claimed_by=p_worker,claimed_at=p_now,updated_at=p_now WHERE id=v_command.id
  RETURNING * INTO v_command;
  RETURN QUERY SELECT v_command.id,v_command.case_id,v_command.claim_token,v_command.tracker_id,p.provider_kind,t.external_device_id
    FROM vehicle_access.vehicle_asset_tracker t JOIN vehicle_access.tracker_provider p ON p.id=t.tracker_provider_id WHERE t.id=v_command.tracker_id;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.mark_prevent_next_start_dispatched(
  p_command uuid,p_claim_token uuid,p_provider_command_id text,p_now timestamptz DEFAULT clock_timestamp()
) RETURNS vehicle_access.prevent_next_start_command_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_case uuid;
BEGIN
  IF length(coalesce(p_provider_command_id,'')) NOT BETWEEN 3 AND 160 THEN RAISE EXCEPTION 'invalid provider command identifier' USING ERRCODE='22023'; END IF;
  SELECT case_id INTO v_case FROM vehicle_access.prevent_next_start_command WHERE id=p_command AND claim_token=p_claim_token AND state='claimed' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'prevent-next-start command claim fence mismatch' USING ERRCODE='55000'; END IF;
  PERFORM vehicle_access.assert_prevent_next_start_interlocks(v_case,p_now);
  UPDATE vehicle_access.prevent_next_start_command SET state='dispatched',provider_command_id=p_provider_command_id,dispatched_at=p_now,updated_at=p_now WHERE id=p_command;
  UPDATE vehicle_access.prevent_next_start_case SET state='dispatched',updated_at=p_now WHERE id=v_case AND state='authorized';
  RETURN 'dispatched';
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.fail_claimed_prevent_next_start_command(
  p_command uuid,p_claim_token uuid,p_reason text,p_now timestamptz DEFAULT clock_timestamp()
) RETURNS vehicle_access.prevent_next_start_command_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_case uuid;
BEGIN
  IF length(coalesce(p_reason,'')) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'invalid prevent-next-start failure reason' USING ERRCODE='22023'; END IF;
  SELECT case_id INTO v_case FROM vehicle_access.prevent_next_start_command WHERE id=p_command AND claim_token=p_claim_token AND state='claimed' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'prevent-next-start command claim fence mismatch' USING ERRCODE='55000'; END IF;
  UPDATE vehicle_access.prevent_next_start_command SET state='failed',terminal_reason=p_reason,updated_at=p_now WHERE id=p_command;
  UPDATE vehicle_access.prevent_next_start_case SET state='failed',terminal_reason=p_reason,updated_at=p_now WHERE id=v_case;
  PERFORM vehicle_access.append_tracker_control_event('prevent_next_start_command',p_command,NULL,'vehicle_access.prevent_next_start.failed_before_dispatch',jsonb_build_object('case_id',v_case,'reason',p_reason),encode(public.digest(p_reason,'sha256'),'hex'),p_now);
  RETURN 'failed';
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.complete_prevent_next_start_command(
  p_command uuid,p_claim_token uuid,p_success boolean,p_acknowledgement_sha256_hex text,p_reason text,p_now timestamptz DEFAULT clock_timestamp()
) RETURNS vehicle_access.prevent_next_start_command_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_case uuid;
BEGIN
  IF p_acknowledgement_sha256_hex !~ '^[a-f0-9]{64}$' OR length(coalesce(p_reason,'')) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'invalid prevent-next-start completion' USING ERRCODE='22023'; END IF;
  SELECT case_id INTO v_case FROM vehicle_access.prevent_next_start_command WHERE id=p_command AND claim_token=p_claim_token AND state='dispatched' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'prevent-next-start command claim fence mismatch' USING ERRCODE='55000'; END IF;
  IF p_success THEN
    UPDATE vehicle_access.prevent_next_start_command SET state='acknowledged',acknowledgement_sha256_hex=p_acknowledgement_sha256_hex,acknowledged_at=p_now,terminal_reason=p_reason,updated_at=p_now WHERE id=p_command;
    UPDATE vehicle_access.prevent_next_start_case SET state='acknowledged',terminal_reason=p_reason,updated_at=p_now WHERE id=v_case;
    PERFORM vehicle_access.append_tracker_control_event('prevent_next_start_command',p_command,NULL,'vehicle_access.prevent_next_start.acknowledged',jsonb_build_object('case_id',v_case),encode(public.digest(p_acknowledgement_sha256_hex,'sha256'),'hex'),p_now);
    RETURN 'acknowledged';
  END IF;
  UPDATE vehicle_access.prevent_next_start_command SET state='failed',acknowledgement_sha256_hex=p_acknowledgement_sha256_hex,terminal_reason=p_reason,updated_at=p_now WHERE id=p_command;
  UPDATE vehicle_access.prevent_next_start_case SET state='failed',terminal_reason=p_reason,updated_at=p_now WHERE id=v_case;
  PERFORM vehicle_access.append_tracker_control_event('prevent_next_start_command',p_command,NULL,'vehicle_access.prevent_next_start.failed',jsonb_build_object('case_id',v_case),encode(public.digest(p_acknowledgement_sha256_hex,'sha256'),'hex'),p_now);
  RETURN 'failed';
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.tracker_operations_snapshot(p_actor integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
  SELECT jsonb_build_object(
    'active_trackers', CASE WHEN vehicle_access.is_operator(p_actor) THEN (SELECT count(*)::integer FROM vehicle_access.vehicle_asset_tracker WHERE state='active') ELSE 0 END,
    'open_flags', CASE WHEN vehicle_access.is_operator(p_actor) THEN (SELECT count(*)::integer FROM vehicle_access.rental_tracker_risk_flag WHERE detected_at>clock_timestamp()-interval '7 days') ELSE 0 END,
    'recent_positions', COALESCE((SELECT jsonb_agg(item) FROM (SELECT jsonb_build_object('tracker_id',s.tracker_id,'asset_id',s.asset_id,'contract_id',s.contract_id,'observed_at',s.observed_at,'latitude',public.ST_Y(s.point::public.geometry),'longitude',public.ST_X(s.point::public.geometry),'speed_kph',s.speed_kph,'ignition_on',s.ignition_on,'integrity_score',s.integrity_score) item FROM vehicle_access.vehicle_tracker_signal s JOIN (SELECT tracker_id,max(observed_at) observed_at FROM vehicle_access.vehicle_tracker_signal WHERE point IS NOT NULL GROUP BY tracker_id) latest ON latest.tracker_id=s.tracker_id AND latest.observed_at=s.observed_at JOIN vehicle_access.access_contract c ON c.id=s.contract_id WHERE vehicle_access.is_operator(p_actor) OR c.worker_user_id=p_actor ORDER BY s.observed_at DESC LIMIT 50) rows),'[]'::jsonb),
    'recent_flags', CASE WHEN vehicle_access.is_operator(p_actor) THEN COALESCE((SELECT jsonb_agg(item) FROM (SELECT jsonb_build_object('id',f.id,'asset_id',f.asset_id,'contract_id',f.contract_id,'flag_code',f.flag_code,'severity',f.severity,'detected_at',f.detected_at,'detail',f.detail) item FROM vehicle_access.rental_tracker_risk_flag f ORDER BY f.detected_at DESC LIMIT 50) rows),'[]'::jsonb) ELSE '[]'::jsonb END,
    'control_cases', CASE WHEN vehicle_access.is_operator(p_actor) THEN COALESCE((SELECT jsonb_agg(item) FROM (SELECT jsonb_build_object('id',c.id,'contract_id',c.contract_id,'asset_id',c.asset_id,'state',c.state,'reason_code',c.reason_code,'requested_by_user_id',c.requested_by_user_id,'authorized_by_user_id',c.authorized_by_user_id,'expires_at',c.expires_at,'created_at',c.created_at) item FROM vehicle_access.prevent_next_start_case c WHERE c.state IN ('requested','authorized','dispatched') ORDER BY c.created_at DESC LIMIT 50) rows),'[]'::jsonb) ELSE '[]'::jsonb END
  );
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA vehicle_access FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA vehicle_access FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='vehicle_access_service') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA vehicle_access FROM vehicle_access_service;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA vehicle_access FROM vehicle_access_service;
    GRANT USAGE ON SCHEMA vehicle_access TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.create_provider(integer,text,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.upsert_worker_eligibility(integer,integer,jsonb,timestamptz,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.register_asset(integer,uuid,text,text,text,text,integer,integer,smallint,jsonb,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.record_asset_evidence(integer,uuid,text,text,text,timestamptz,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.activate_asset(integer,uuid,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.create_offer(integer,uuid,uuid,char(3),bigint,bigint,integer,bigint,smallint,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.request_contract(integer,uuid,timestamptz,timestamptz,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.transition_contract(integer,uuid,text,text,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.record_inspection(integer,uuid,text,text,text,text,integer,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.list_contracts_for_actor(integer,integer) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.list_active_offers(integer) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.create_provider_location(integer,uuid,text,text,text,text,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.assign_asset_location(integer,uuid,uuid,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.create_availability_block(integer,uuid,text,text,timestamptz,timestamptz,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.cancel_availability_block(integer,uuid,text,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.create_rental_add_on(integer,uuid,text,text,text,char(3),vehicle_access.rental_add_on_charge_unit,bigint,smallint,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.request_contract_with_add_ons(integer,uuid,timestamptz,timestamptz,jsonb,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.record_agreement_acceptance(integer,uuid,text,text,text,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.request_contract_extension(integer,uuid,timestamptz,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.decide_contract_extension(integer,uuid,text,text,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.list_rental_add_ons_for_offer(uuid,integer) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.rental_operations_snapshot(integer) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.create_tracker_provider(integer,uuid,vehicle_access.tracker_provider_kind,text,text,text,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.register_asset_tracker(integer,uuid,uuid,text,text,boolean,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.create_rental_asset_geofence(integer,uuid,vehicle_access.rental_geofence_kind,text,text,jsonb,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.record_tracker_control_consent(integer,uuid,text,text,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.resolve_active_tracker_for_ingress(text,text) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.record_vehicle_tracker_signal(uuid,text,vehicle_access.tracker_signal_kind,timestamptz,numeric,numeric,numeric,numeric,numeric,numeric,boolean,smallint,text,jsonb,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.record_rental_payment_tracking_signal(integer,uuid,text,vehicle_access.rental_payment_tracking_state,timestamptz,timestamptz,text,text,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.request_prevent_next_start(integer,uuid,uuid,text,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.authorize_prevent_next_start(integer,uuid,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.cancel_prevent_next_start(integer,uuid,text,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.claim_prevent_next_start_command(text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.mark_prevent_next_start_dispatched(uuid,uuid,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.fail_claimed_prevent_next_start_command(uuid,uuid,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.complete_prevent_next_start_command(uuid,uuid,boolean,text,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.tracker_operations_snapshot(integer) TO vehicle_access_service;
  END IF;
END $$;
