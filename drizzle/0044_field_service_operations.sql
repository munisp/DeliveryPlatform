-- Field-service operations are PostgreSQL/PostGIS-authoritative.
-- This migration intentionally uses existing public users, customers, and service_providers
-- rather than duplicating identity or tenant authority.

CREATE SCHEMA IF NOT EXISTS field_service;

DO $$ BEGIN
  CREATE TYPE field_service.technician_state AS ENUM ('active', 'suspended', 'inactive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE field_service.work_order_state AS ENUM ('requested', 'scheduled', 'assigned', 'en_route', 'on_site', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE field_service.work_order_priority AS ENUM ('low', 'normal', 'high', 'urgent');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS field_service.service_area (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id integer NOT NULL REFERENCES public.service_providers(id) ON DELETE RESTRICT,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_-]{2,63}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 160),
  boundary geography(Polygon, 4326) NOT NULL,
  timezone text NOT NULL CHECK (timezone ~ '^[A-Za-z_]+/[A-Za-z_]+$'),
  active boolean NOT NULL DEFAULT true,
  created_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, code),
  CHECK (ST_IsValid(boundary::geometry)),
  CHECK (ST_NPoints(boundary::geometry) >= 4)
);
CREATE INDEX IF NOT EXISTS field_service_service_area_boundary_gix ON field_service.service_area USING gist (boundary);
CREATE INDEX IF NOT EXISTS field_service_service_area_provider_active_idx ON field_service.service_area (provider_id, code) WHERE active;

CREATE TABLE IF NOT EXISTS field_service.technician_profile (
  user_id integer PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
  provider_id integer NOT NULL REFERENCES public.service_providers(id) ON DELETE RESTRICT,
  employee_reference text CHECK (employee_reference IS NULL OR employee_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 160),
  skills jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(skills) = 'array' AND jsonb_array_length(skills) <= 48),
  state field_service.technician_state NOT NULL DEFAULT 'inactive',
  activated_at timestamptz,
  suspended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, employee_reference),
  CHECK ((state = 'active') = (activated_at IS NOT NULL)),
  CHECK ((state = 'suspended') = (suspended_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS field_service_technician_active_idx ON field_service.technician_profile (provider_id, user_id) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS field_service.technician_service_area (
  technician_user_id integer NOT NULL REFERENCES field_service.technician_profile(user_id) ON DELETE RESTRICT,
  service_area_id uuid NOT NULL REFERENCES field_service.service_area(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  authorized_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  removed_at timestamptz,
  PRIMARY KEY (technician_user_id, service_area_id),
  CHECK ((active AND removed_at IS NULL) OR (NOT active AND removed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS field_service_technician_area_active_idx ON field_service.technician_service_area (service_area_id, technician_user_id) WHERE active;

CREATE TABLE IF NOT EXISTS field_service.work_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_reference text NOT NULL UNIQUE DEFAULT ('fs-' || lower(replace(gen_random_uuid()::text, '-', ''))),
  customer_id integer NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  provider_id integer NOT NULL REFERENCES public.service_providers(id) ON DELETE RESTRICT,
  service_area_id uuid NOT NULL REFERENCES field_service.service_area(id) ON DELETE RESTRICT,
  source_order_id integer REFERENCES public.orders(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 180),
  description text NOT NULL CHECK (length(description) BETWEEN 3 AND 5000),
  service_address text NOT NULL CHECK (length(service_address) BETWEEN 3 AND 500),
  service_location geography(Point, 4326),
  priority field_service.work_order_priority NOT NULL DEFAULT 'normal',
  state field_service.work_order_state NOT NULL DEFAULT 'requested',
  scheduled_start_at timestamptz,
  scheduled_end_at timestamptz,
  assigned_technician_user_id integer REFERENCES field_service.technician_profile(user_id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT now(),
  assigned_at timestamptz,
  en_route_at timestamptz,
  arrived_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text CHECK (cancellation_reason IS NULL OR length(cancellation_reason) BETWEEN 3 AND 1000),
  completion_summary text CHECK (completion_summary IS NULL OR length(completion_summary) BETWEEN 3 AND 4000),
  created_by_user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (scheduled_end_at IS NULL OR scheduled_start_at IS NOT NULL),
  CHECK (scheduled_end_at IS NULL OR scheduled_end_at > scheduled_start_at),
  CHECK ((state IN ('assigned', 'en_route', 'on_site', 'completed')) = (assigned_technician_user_id IS NOT NULL)),
  CHECK ((state IN ('assigned', 'en_route', 'on_site', 'completed')) = (assigned_at IS NOT NULL)),
  CHECK ((state IN ('en_route', 'on_site', 'completed')) = (en_route_at IS NOT NULL)),
  CHECK ((state IN ('on_site', 'completed')) = (arrived_at IS NOT NULL)),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((state = 'cancelled') = (cancellation_reason IS NOT NULL)),
  CHECK ((state = 'completed') = (completion_summary IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS field_service_work_order_dispatch_idx ON field_service.work_order (provider_id, service_area_id, state, priority DESC, scheduled_start_at) WHERE state IN ('requested', 'scheduled', 'assigned');
CREATE INDEX IF NOT EXISTS field_service_work_order_technician_idx ON field_service.work_order (assigned_technician_user_id, state, scheduled_start_at) WHERE assigned_technician_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS field_service_work_order_customer_idx ON field_service.work_order (customer_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS field_service_work_order_location_gix ON field_service.work_order USING gist (service_location) WHERE service_location IS NOT NULL;

CREATE TABLE IF NOT EXISTS field_service.work_order_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES field_service.work_order(id) ON DELETE RESTRICT,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  actor_user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.]{2,95}$'),
  previous_state field_service.work_order_state,
  next_state field_service.work_order_state NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_order_id, sequence_no),
  UNIQUE (work_order_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS field_service_work_order_event_timeline_idx ON field_service.work_order_event (work_order_id, sequence_no);

CREATE TABLE IF NOT EXISTS field_service.work_order_proof (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES field_service.work_order(id) ON DELETE RESTRICT,
  captured_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 3 AND 512 AND object_key ~ '^[A-Za-z0-9][A-Za-z0-9._/-]+$'),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/heic', 'application/pdf')),
  sha256_hex text NOT NULL CHECK (sha256_hex ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('arrival', 'completion', 'customer_signature', 'equipment_serial')),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_order_id, kind, idempotency_key),
  UNIQUE (work_order_id, kind, sha256_hex)
);
CREATE INDEX IF NOT EXISTS field_service_work_order_proof_idx ON field_service.work_order_proof (work_order_id, captured_at);

CREATE TABLE IF NOT EXISTS field_service.outbox_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL CHECK (aggregate_type IN ('work_order')),
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.]{2,95}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  UNIQUE (aggregate_type, aggregate_id, event_type, idempotency_key)
);
CREATE INDEX IF NOT EXISTS field_service_outbox_pending_idx ON field_service.outbox_event (created_at) WHERE published_at IS NULL;

CREATE OR REPLACE FUNCTION field_service.prevent_append_only_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, field_service AS $$
BEGIN
  RAISE EXCEPTION 'field-service evidence is append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS field_service_work_order_event_append_only ON field_service.work_order_event;
CREATE TRIGGER field_service_work_order_event_append_only BEFORE UPDATE OR DELETE ON field_service.work_order_event
FOR EACH ROW EXECUTE FUNCTION field_service.prevent_append_only_mutation();
DROP TRIGGER IF EXISTS field_service_work_order_proof_append_only ON field_service.work_order_proof;
CREATE TRIGGER field_service_work_order_proof_append_only BEFORE UPDATE OR DELETE ON field_service.work_order_proof
FOR EACH ROW EXECUTE FUNCTION field_service.prevent_append_only_mutation();

CREATE OR REPLACE FUNCTION field_service.is_platform_operator(p_user_id integer)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, field_service AS $$
  SELECT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id AND role = 'admin');
$$;

CREATE OR REPLACE FUNCTION field_service.append_work_order_event(
  p_work_order_id uuid,
  p_actor_user_id integer,
  p_event_type text,
  p_previous_state field_service.work_order_state,
  p_next_state field_service.work_order_state,
  p_detail jsonb,
  p_idempotency_key text,
  p_now timestamptz
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, field_service AS $$
DECLARE v_sequence integer;
BEGIN
  SELECT COALESCE(MAX(sequence_no), 0) + 1 INTO v_sequence
  FROM field_service.work_order_event WHERE work_order_id = p_work_order_id;
  INSERT INTO field_service.work_order_event (work_order_id, sequence_no, actor_user_id, event_type, previous_state, next_state, detail, idempotency_key, created_at)
  VALUES (p_work_order_id, v_sequence, p_actor_user_id, p_event_type, p_previous_state, p_next_state, p_detail, p_idempotency_key, p_now);
END;
$$;

CREATE OR REPLACE FUNCTION field_service.enqueue_work_order_outbox(
  p_work_order_id uuid, p_event_type text, p_idempotency_key text, p_now timestamptz
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, field_service AS $$
DECLARE v_order field_service.work_order%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM field_service.work_order WHERE id = p_work_order_id;
  INSERT INTO field_service.outbox_event (aggregate_type, aggregate_id, event_type, payload, idempotency_key, created_at)
  VALUES (
    'work_order', p_work_order_id, p_event_type,
    jsonb_build_object('work_order_id', p_work_order_id, 'public_reference', v_order.public_reference, 'provider_id', v_order.provider_id, 'customer_id', v_order.customer_id, 'state', v_order.state, 'updated_at', v_order.updated_at),
    p_idempotency_key, p_now
  ) ON CONFLICT (aggregate_type, aggregate_id, event_type, idempotency_key) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION field_service.upsert_service_area(
  p_actor_user_id integer, p_provider_id integer, p_code text, p_display_name text, p_boundary_geojson jsonb, p_timezone text, p_active boolean, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, field_service AS $$
DECLARE v_id uuid; v_boundary public.geography;
BEGIN
  IF NOT field_service.is_platform_operator(p_actor_user_id) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  IF p_code !~ '^[a-z][a-z0-9_-]{2,63}$' OR length(p_display_name) NOT BETWEEN 2 AND 160 OR p_timezone !~ '^[A-Za-z_]+/[A-Za-z_]+$' OR jsonb_typeof(p_boundary_geojson) <> 'object' THEN RAISE EXCEPTION 'invalid service area input' USING ERRCODE = '22023'; END IF;
  v_boundary := public.ST_SetSRID(public.ST_GeomFromGeoJSON(p_boundary_geojson::text), 4326)::public.geography;
  IF public.GeometryType(v_boundary::public.geometry) <> 'POLYGON' OR NOT public.ST_IsValid(v_boundary::public.geometry) THEN RAISE EXCEPTION 'service area boundary must be a valid polygon' USING ERRCODE = '22023'; END IF;
  INSERT INTO field_service.service_area (provider_id, code, display_name, boundary, timezone, active, created_by, created_at, updated_at)
  VALUES (p_provider_id, p_code, p_display_name, v_boundary, p_timezone, p_active, p_actor_user_id, p_now, p_now)
  ON CONFLICT (provider_id, code) DO UPDATE SET display_name = EXCLUDED.display_name, boundary = EXCLUDED.boundary, timezone = EXCLUDED.timezone, active = EXCLUDED.active, updated_at = EXCLUDED.updated_at
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION field_service.upsert_technician(
  p_actor_user_id integer, p_user_id integer, p_provider_id integer, p_display_name text, p_employee_reference text, p_skills jsonb, p_state field_service.technician_state, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, field_service AS $$
BEGIN
  IF NOT field_service.is_platform_operator(p_actor_user_id) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  IF length(p_display_name) NOT BETWEEN 2 AND 160 OR jsonb_typeof(p_skills) <> 'array' OR jsonb_array_length(p_skills) > 48 OR (p_employee_reference IS NOT NULL AND p_employee_reference !~ '^[A-Za-z0-9._:-]{1,128}$') THEN RAISE EXCEPTION 'invalid technician input' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id) THEN RAISE EXCEPTION 'technician user does not exist' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO field_service.technician_profile (user_id, provider_id, employee_reference, display_name, skills, state, activated_at, suspended_at, created_at, updated_at)
  VALUES (p_user_id, p_provider_id, p_employee_reference, p_display_name, p_skills, p_state, CASE WHEN p_state = 'active' THEN p_now END, CASE WHEN p_state = 'suspended' THEN p_now END, p_now, p_now)
  ON CONFLICT (user_id) DO UPDATE SET provider_id = EXCLUDED.provider_id, employee_reference = EXCLUDED.employee_reference, display_name = EXCLUDED.display_name, skills = EXCLUDED.skills, state = EXCLUDED.state, activated_at = CASE WHEN EXCLUDED.state = 'active' THEN p_now ELSE NULL END, suspended_at = CASE WHEN EXCLUDED.state = 'suspended' THEN p_now ELSE NULL END, updated_at = p_now;
  RETURN p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION field_service.set_technician_service_area(
  p_actor_user_id integer, p_technician_user_id integer, p_service_area_id uuid, p_active boolean, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, field_service AS $$
DECLARE v_provider integer; v_area_provider integer;
BEGIN
  IF NOT field_service.is_platform_operator(p_actor_user_id) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  SELECT provider_id INTO v_provider FROM field_service.technician_profile WHERE user_id = p_technician_user_id FOR UPDATE;
  SELECT provider_id INTO v_area_provider FROM field_service.service_area WHERE id = p_service_area_id FOR SHARE;
  IF v_provider IS NULL OR v_area_provider IS NULL OR v_provider <> v_area_provider THEN RAISE EXCEPTION 'technician and service area must belong to the same provider' USING ERRCODE = '23514'; END IF;
  INSERT INTO field_service.technician_service_area (technician_user_id, service_area_id, active, authorized_at, authorized_by, removed_at)
  VALUES (p_technician_user_id, p_service_area_id, p_active, p_now, p_actor_user_id, CASE WHEN p_active THEN NULL ELSE p_now END)
  ON CONFLICT (technician_user_id, service_area_id) DO UPDATE SET active = EXCLUDED.active, authorized_at = EXCLUDED.authorized_at, authorized_by = EXCLUDED.authorized_by, removed_at = EXCLUDED.removed_at;
END;
$$;

CREATE OR REPLACE FUNCTION field_service.create_work_order(
  p_customer_id integer, p_provider_id integer, p_service_area_id uuid, p_title text, p_description text, p_service_address text, p_latitude numeric, p_longitude numeric, p_priority field_service.work_order_priority, p_scheduled_start_at timestamptz, p_scheduled_end_at timestamptz, p_source_order_id integer, p_created_by_user_id integer, p_idempotency_key text, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, field_service AS $$
DECLARE v_id uuid; v_existing uuid; v_area field_service.service_area%ROWTYPE; v_location public.geography;
BEGIN
  IF p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' OR length(p_title) NOT BETWEEN 3 AND 180 OR length(p_description) NOT BETWEEN 3 AND 5000 OR length(p_service_address) NOT BETWEEN 3 AND 500 OR (p_scheduled_end_at IS NOT NULL AND (p_scheduled_start_at IS NULL OR p_scheduled_end_at <= p_scheduled_start_at)) THEN RAISE EXCEPTION 'invalid work order input' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('field_service.create:' || p_customer_id::text || ':' || p_idempotency_key, 0));
  SELECT work_order_id INTO v_existing FROM field_service.work_order_event WHERE actor_user_id IS NOT DISTINCT FROM p_created_by_user_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN RETURN v_existing; END IF;
  SELECT * INTO v_area FROM field_service.service_area WHERE id = p_service_area_id FOR SHARE;
  IF NOT FOUND OR NOT v_area.active OR v_area.provider_id <> p_provider_id THEN RAISE EXCEPTION 'service area is unavailable for provider' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = p_customer_id) OR NOT EXISTS (SELECT 1 FROM public.service_providers WHERE id = p_provider_id AND status = 'active') THEN RAISE EXCEPTION 'customer or provider is unavailable' USING ERRCODE = 'P0002'; END IF;
  IF p_latitude IS NOT NULL OR p_longitude IS NOT NULL THEN
    IF p_latitude IS NULL OR p_longitude IS NULL OR p_latitude NOT BETWEEN -90 AND 90 OR p_longitude NOT BETWEEN -180 AND 180 THEN RAISE EXCEPTION 'invalid service coordinates' USING ERRCODE = '22023'; END IF;
    v_location := public.ST_SetSRID(public.ST_MakePoint(p_longitude, p_latitude), 4326)::public.geography;
    IF NOT public.ST_Covers(v_area.boundary::public.geometry, v_location::public.geometry) THEN RAISE EXCEPTION 'service location is outside service area' USING ERRCODE = '23514'; END IF;
  END IF;
  INSERT INTO field_service.work_order (customer_id, provider_id, service_area_id, source_order_id, title, description, service_address, service_location, priority, scheduled_start_at, scheduled_end_at, created_by_user_id, requested_at, updated_at)
  VALUES (p_customer_id, p_provider_id, p_service_area_id, p_source_order_id, p_title, p_description, p_service_address, v_location, p_priority, p_scheduled_start_at, p_scheduled_end_at, p_created_by_user_id, p_now, p_now)
  RETURNING id INTO v_id;
  PERFORM field_service.append_work_order_event(v_id, p_created_by_user_id, 'work_order.created', NULL, 'requested'::field_service.work_order_state, jsonb_build_object('priority', p_priority, 'scheduled_start_at', p_scheduled_start_at), p_idempotency_key, p_now);
  PERFORM field_service.enqueue_work_order_outbox(v_id, 'field_service.work_order.created', p_idempotency_key, p_now);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION field_service.schedule_work_order(
  p_work_order_id uuid, p_operator_user_id integer, p_scheduled_start_at timestamptz, p_scheduled_end_at timestamptz, p_idempotency_key text, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS field_service.work_order_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, field_service AS $$
DECLARE v_order field_service.work_order%ROWTYPE;
BEGIN
  IF NOT field_service.is_platform_operator(p_operator_user_id) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  IF p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' OR p_scheduled_start_at IS NULL OR p_scheduled_end_at IS NULL OR p_scheduled_end_at <= p_scheduled_start_at THEN RAISE EXCEPTION 'invalid schedule input' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_order FROM field_service.work_order WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'work order not found' USING ERRCODE = 'P0002'; END IF;
  IF EXISTS (SELECT 1 FROM field_service.work_order_event WHERE work_order_id = p_work_order_id AND idempotency_key = p_idempotency_key) THEN RETURN v_order.state; END IF;
  IF v_order.state NOT IN ('requested', 'scheduled') THEN RAISE EXCEPTION 'work order cannot be scheduled from current state' USING ERRCODE = '23514'; END IF;
  UPDATE field_service.work_order SET state = 'scheduled', scheduled_start_at = p_scheduled_start_at, scheduled_end_at = p_scheduled_end_at, updated_at = p_now WHERE id = p_work_order_id;
  PERFORM field_service.append_work_order_event(p_work_order_id, p_operator_user_id, 'work_order.scheduled', v_order.state, 'scheduled'::field_service.work_order_state, jsonb_build_object('scheduled_start_at', p_scheduled_start_at, 'scheduled_end_at', p_scheduled_end_at), p_idempotency_key, p_now);
  PERFORM field_service.enqueue_work_order_outbox(p_work_order_id, 'field_service.work_order.scheduled', p_idempotency_key, p_now);
  RETURN 'scheduled'::field_service.work_order_state;
END;
$$;

CREATE OR REPLACE FUNCTION field_service.assign_work_order(
  p_work_order_id uuid, p_operator_user_id integer, p_technician_user_id integer, p_idempotency_key text, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS field_service.work_order_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, field_service AS $$
DECLARE v_order field_service.work_order%ROWTYPE;
BEGIN
  IF NOT field_service.is_platform_operator(p_operator_user_id) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  IF p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid idempotency key' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_order FROM field_service.work_order WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'work order not found' USING ERRCODE = 'P0002'; END IF;
  IF EXISTS (SELECT 1 FROM field_service.work_order_event WHERE work_order_id = p_work_order_id AND idempotency_key = p_idempotency_key) THEN RETURN v_order.state; END IF;
  IF v_order.state <> 'scheduled' THEN RAISE EXCEPTION 'work order must be scheduled before assignment' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM field_service.technician_profile profile JOIN field_service.technician_service_area coverage ON coverage.technician_user_id = profile.user_id WHERE profile.user_id = p_technician_user_id AND profile.provider_id = v_order.provider_id AND profile.state = 'active' AND coverage.service_area_id = v_order.service_area_id AND coverage.active) THEN RAISE EXCEPTION 'technician is not eligible for this service area' USING ERRCODE = '23514'; END IF;
  UPDATE field_service.work_order SET state = 'assigned', assigned_technician_user_id = p_technician_user_id, assigned_at = p_now, updated_at = p_now WHERE id = p_work_order_id;
  PERFORM field_service.append_work_order_event(p_work_order_id, p_operator_user_id, 'work_order.assigned', v_order.state, 'assigned'::field_service.work_order_state, jsonb_build_object('technician_user_id', p_technician_user_id), p_idempotency_key, p_now);
  PERFORM field_service.enqueue_work_order_outbox(p_work_order_id, 'field_service.work_order.assigned', p_idempotency_key, p_now);
  RETURN 'assigned'::field_service.work_order_state;
END;
$$;

CREATE OR REPLACE FUNCTION field_service.advance_work_order(
  p_work_order_id uuid, p_technician_user_id integer, p_action text, p_note text, p_idempotency_key text, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS field_service.work_order_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, field_service AS $$
DECLARE v_order field_service.work_order%ROWTYPE; v_next field_service.work_order_state; v_event text;
BEGIN
  IF p_action NOT IN ('depart', 'arrive') OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' OR (p_note IS NOT NULL AND length(p_note) NOT BETWEEN 1 AND 2000) THEN RAISE EXCEPTION 'invalid work order advancement input' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_order FROM field_service.work_order WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.assigned_technician_user_id <> p_technician_user_id THEN RAISE EXCEPTION 'work order is not assigned to technician' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM field_service.work_order_event WHERE work_order_id = p_work_order_id AND idempotency_key = p_idempotency_key) THEN RETURN v_order.state; END IF;
  IF p_action = 'depart' AND v_order.state = 'assigned' THEN v_next := 'en_route'; v_event := 'work_order.en_route';
  ELSIF p_action = 'arrive' AND v_order.state = 'en_route' THEN v_next := 'on_site'; v_event := 'work_order.arrived';
  ELSE RAISE EXCEPTION 'invalid technician transition' USING ERRCODE = '23514'; END IF;
  UPDATE field_service.work_order SET state = v_next, en_route_at = CASE WHEN v_next = 'en_route' THEN p_now ELSE en_route_at END, arrived_at = CASE WHEN v_next = 'on_site' THEN p_now ELSE arrived_at END, updated_at = p_now WHERE id = p_work_order_id;
  PERFORM field_service.append_work_order_event(p_work_order_id, p_technician_user_id, v_event, v_order.state, v_next, jsonb_build_object('note', p_note), p_idempotency_key, p_now);
  PERFORM field_service.enqueue_work_order_outbox(p_work_order_id, 'field_service.' || v_event, p_idempotency_key, p_now);
  RETURN v_next;
END;
$$;

CREATE OR REPLACE FUNCTION field_service.complete_work_order(
  p_work_order_id uuid, p_technician_user_id integer, p_completion_summary text, p_object_key text, p_content_type text, p_sha256_hex text, p_idempotency_key text, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS field_service.work_order_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, field_service AS $$
DECLARE v_order field_service.work_order%ROWTYPE;
BEGIN
  IF length(p_completion_summary) NOT BETWEEN 3 AND 4000 OR length(p_object_key) NOT BETWEEN 3 AND 512 OR p_object_key !~ '^[A-Za-z0-9][A-Za-z0-9._/-]+$' OR p_content_type NOT IN ('image/jpeg','image/png','image/heic','application/pdf') OR p_sha256_hex !~ '^[a-f0-9]{64}$' OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid completion evidence' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_order FROM field_service.work_order WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.assigned_technician_user_id <> p_technician_user_id THEN RAISE EXCEPTION 'work order is not assigned to technician' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM field_service.work_order_event WHERE work_order_id = p_work_order_id AND idempotency_key = p_idempotency_key) THEN RETURN v_order.state; END IF;
  IF v_order.state <> 'on_site' THEN RAISE EXCEPTION 'work order must be on site before completion' USING ERRCODE = '23514'; END IF;
  INSERT INTO field_service.work_order_proof (work_order_id, captured_by_user_id, object_key, content_type, sha256_hex, kind, idempotency_key, captured_at)
  VALUES (p_work_order_id, p_technician_user_id, p_object_key, p_content_type, p_sha256_hex, 'completion', p_idempotency_key, p_now);
  UPDATE field_service.work_order SET state = 'completed', completion_summary = p_completion_summary, completed_at = p_now, updated_at = p_now WHERE id = p_work_order_id;
  PERFORM field_service.append_work_order_event(p_work_order_id, p_technician_user_id, 'work_order.completed', v_order.state, 'completed'::field_service.work_order_state, jsonb_build_object('completion_summary', p_completion_summary, 'proof_sha256', p_sha256_hex), p_idempotency_key, p_now);
  PERFORM field_service.enqueue_work_order_outbox(p_work_order_id, 'field_service.work_order.completed', p_idempotency_key, p_now);
  RETURN 'completed'::field_service.work_order_state;
END;
$$;

CREATE OR REPLACE FUNCTION field_service.cancel_work_order(
  p_work_order_id uuid, p_operator_user_id integer, p_reason text, p_idempotency_key text, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS field_service.work_order_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, field_service AS $$
DECLARE v_order field_service.work_order%ROWTYPE;
BEGIN
  IF NOT field_service.is_platform_operator(p_operator_user_id) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  IF length(p_reason) NOT BETWEEN 3 AND 1000 OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid cancellation input' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_order FROM field_service.work_order WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'work order not found' USING ERRCODE = 'P0002'; END IF;
  IF EXISTS (SELECT 1 FROM field_service.work_order_event WHERE work_order_id = p_work_order_id AND idempotency_key = p_idempotency_key) THEN RETURN v_order.state; END IF;
  IF v_order.state NOT IN ('requested','scheduled','assigned') THEN RAISE EXCEPTION 'work order cannot be cancelled from current state' USING ERRCODE = '23514'; END IF;
  UPDATE field_service.work_order SET state = 'cancelled', cancellation_reason = p_reason, cancelled_at = p_now, updated_at = p_now WHERE id = p_work_order_id;
  PERFORM field_service.append_work_order_event(p_work_order_id, p_operator_user_id, 'work_order.cancelled', v_order.state, 'cancelled'::field_service.work_order_state, jsonb_build_object('reason', p_reason), p_idempotency_key, p_now);
  PERFORM field_service.enqueue_work_order_outbox(p_work_order_id, 'field_service.work_order.cancelled', p_idempotency_key, p_now);
  RETURN 'cancelled'::field_service.work_order_state;
END;
$$;

CREATE OR REPLACE FUNCTION field_service.get_work_order_detail_for_actor(
  p_actor_user_id integer, p_work_order_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, field_service AS $$
DECLARE v_order field_service.work_order%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM field_service.work_order WHERE id = p_work_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'work order not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT field_service.is_platform_operator(p_actor_user_id) AND v_order.assigned_technician_user_id IS DISTINCT FROM p_actor_user_id THEN
    RAISE EXCEPTION 'field-service access denied' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'id', v_order.id, 'public_reference', v_order.public_reference, 'customer_id', v_order.customer_id, 'provider_id', v_order.provider_id,
    'service_area_id', v_order.service_area_id, 'title', v_order.title, 'description', v_order.description, 'service_address', v_order.service_address,
    'priority', v_order.priority, 'state', v_order.state, 'scheduled_start_at', v_order.scheduled_start_at, 'scheduled_end_at', v_order.scheduled_end_at,
    'assigned_technician_user_id', v_order.assigned_technician_user_id, 'requested_at', v_order.requested_at, 'assigned_at', v_order.assigned_at,
    'en_route_at', v_order.en_route_at, 'arrived_at', v_order.arrived_at, 'completed_at', v_order.completed_at, 'cancelled_at', v_order.cancelled_at,
    'cancellation_reason', v_order.cancellation_reason, 'completion_summary', v_order.completion_summary, 'updated_at', v_order.updated_at,
    'events', COALESCE((SELECT jsonb_agg(jsonb_build_object('sequence_no', event.sequence_no, 'event_type', event.event_type, 'previous_state', event.previous_state, 'next_state', event.next_state, 'detail', event.detail, 'created_at', event.created_at) ORDER BY event.sequence_no) FROM field_service.work_order_event event WHERE event.work_order_id = v_order.id), '[]'::jsonb),
    'proofs', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', proof.kind, 'object_key', proof.object_key, 'content_type', proof.content_type, 'sha256_hex', proof.sha256_hex, 'captured_at', proof.captured_at) ORDER BY proof.captured_at) FROM field_service.work_order_proof proof WHERE proof.work_order_id = v_order.id), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION field_service.list_work_orders_for_actor(
  p_actor_user_id integer, p_state field_service.work_order_state DEFAULT NULL, p_limit integer DEFAULT 50
)
RETURNS TABLE (id uuid, public_reference text, customer_id integer, provider_id integer, state field_service.work_order_state, priority field_service.work_order_priority, scheduled_start_at timestamptz, assigned_technician_user_id integer, updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, field_service AS $$
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid list limit' USING ERRCODE = '22023'; END IF;
  IF field_service.is_platform_operator(p_actor_user_id) THEN
    RETURN QUERY SELECT work.id, work.public_reference, work.customer_id, work.provider_id, work.state, work.priority, work.scheduled_start_at, work.assigned_technician_user_id, work.updated_at FROM field_service.work_order work WHERE p_state IS NULL OR work.state = p_state ORDER BY work.updated_at DESC LIMIT p_limit;
  ELSIF EXISTS (SELECT 1 FROM field_service.technician_profile profile WHERE profile.user_id = p_actor_user_id AND profile.state = 'active') THEN
    RETURN QUERY SELECT work.id, work.public_reference, work.customer_id, work.provider_id, work.state, work.priority, work.scheduled_start_at, work.assigned_technician_user_id, work.updated_at FROM field_service.work_order work WHERE work.assigned_technician_user_id = p_actor_user_id AND (p_state IS NULL OR work.state = p_state) ORDER BY work.updated_at DESC LIMIT p_limit;
  ELSE
    RAISE EXCEPTION 'field-service access denied' USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON SCHEMA field_service FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA field_service FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA field_service FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_service_api') THEN
    GRANT USAGE ON SCHEMA field_service TO field_service_api;
    GRANT EXECUTE ON FUNCTION field_service.upsert_service_area(integer,integer,text,text,jsonb,text,boolean,timestamp with time zone) TO field_service_api;
    GRANT EXECUTE ON FUNCTION field_service.upsert_technician(integer,integer,integer,text,text,jsonb,field_service.technician_state,timestamp with time zone) TO field_service_api;
    GRANT EXECUTE ON FUNCTION field_service.set_technician_service_area(integer,integer,uuid,boolean,timestamp with time zone) TO field_service_api;
    GRANT EXECUTE ON FUNCTION field_service.create_work_order(integer,integer,uuid,text,text,text,numeric,numeric,field_service.work_order_priority,timestamp with time zone,timestamp with time zone,integer,integer,text,timestamp with time zone) TO field_service_api;
    GRANT EXECUTE ON FUNCTION field_service.schedule_work_order(uuid,integer,timestamp with time zone,timestamp with time zone,text,timestamp with time zone) TO field_service_api;
    GRANT EXECUTE ON FUNCTION field_service.assign_work_order(uuid,integer,integer,text,timestamp with time zone) TO field_service_api;
    GRANT EXECUTE ON FUNCTION field_service.advance_work_order(uuid,integer,text,text,text,timestamp with time zone) TO field_service_api;
    GRANT EXECUTE ON FUNCTION field_service.complete_work_order(uuid,integer,text,text,text,text,text,timestamp with time zone) TO field_service_api;
    GRANT EXECUTE ON FUNCTION field_service.cancel_work_order(uuid,integer,text,text,timestamp with time zone) TO field_service_api;
    GRANT EXECUTE ON FUNCTION field_service.get_work_order_detail_for_actor(integer,uuid) TO field_service_api;
    GRANT EXECUTE ON FUNCTION field_service.list_work_orders_for_actor(integer,field_service.work_order_state,integer) TO field_service_api;
  END IF;
END $$;
