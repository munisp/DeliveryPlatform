-- Clean-room gig vehicle-rental operations extension.
-- Extends vehicle_access without changing financial settlement authority.

DO $$ BEGIN
  CREATE TYPE vehicle_access.availability_block_state AS ENUM ('active','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE vehicle_access.rental_add_on_charge_unit AS ENUM ('flat','per_day','per_week');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE vehicle_access.extension_request_state AS ENUM ('requested','approved','rejected','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS vehicle_access.provider_location (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES vehicle_access.fleet_provider(id) ON DELETE RESTRICT,
  location_code text NOT NULL CHECK (location_code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 160),
  address_summary text NOT NULL CHECK (length(address_summary) BETWEEN 3 AND 400),
  timezone_name text NOT NULL CHECK (timezone_name ~ '^[A-Za-z_]+/[A-Za-z_]+$'),
  active boolean NOT NULL DEFAULT true,
  created_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider_id, location_code)
);
CREATE INDEX IF NOT EXISTS vehicle_access_provider_location_active_idx
  ON vehicle_access.provider_location(provider_id, display_name) WHERE active;

CREATE TABLE IF NOT EXISTS vehicle_access.asset_location_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES vehicle_access.vehicle_asset(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES vehicle_access.provider_location(id) ON DELETE RESTRICT,
  assigned_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  unassigned_at timestamptz,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  CHECK (unassigned_at IS NULL OR unassigned_at > assigned_at),
  UNIQUE (asset_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS vehicle_access_location_assignment_asset_idx
  ON vehicle_access.asset_location_assignment(asset_id, assigned_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS vehicle_access_location_assignment_location_idx
  ON vehicle_access.asset_location_assignment(location_id, assigned_at DESC, id DESC);
COMMENT ON COLUMN vehicle_access.asset_location_assignment.unassigned_at IS
  'Legacy-compatible field intentionally unused: assignment history is immutable and current location is the latest append-only assignment.';

CREATE OR REPLACE VIEW vehicle_access.current_asset_location AS
SELECT DISTINCT ON (assignment.asset_id)
  assignment.asset_id,
  assignment.location_id,
  assignment.assigned_by_user_id,
  assignment.assigned_at
FROM vehicle_access.asset_location_assignment assignment
ORDER BY assignment.asset_id, assignment.assigned_at DESC, assignment.id DESC;

CREATE TABLE IF NOT EXISTS vehicle_access.asset_availability_block (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES vehicle_access.vehicle_asset(id) ON DELETE RESTRICT,
  block_reason text NOT NULL CHECK (block_reason IN ('maintenance','inspection','operator_hold','seasonal_unavailable','repair')),
  note text NOT NULL CHECK (length(note) BETWEEN 3 AND 1000),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  state vehicle_access.availability_block_state NOT NULL DEFAULT 'active',
  cancelled_by_user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
  cancellation_reason text CHECK (cancellation_reason IS NULL OR length(cancellation_reason) BETWEEN 3 AND 1000),
  created_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (ends_at > starts_at),
  CHECK ((state = 'cancelled') = (cancelled_by_user_id IS NOT NULL)),
  CHECK (state <> 'cancelled' OR cancellation_reason IS NOT NULL),
  UNIQUE (asset_id, idempotency_key),
  EXCLUDE USING gist (asset_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
    WHERE (state = 'active')
);
CREATE INDEX IF NOT EXISTS vehicle_access_asset_availability_block_upcoming_idx
  ON vehicle_access.asset_availability_block(asset_id, starts_at) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS vehicle_access.rental_add_on (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES vehicle_access.fleet_provider(id) ON DELETE RESTRICT,
  add_on_code text NOT NULL CHECK (add_on_code ~ '^[a-z][a-z0-9_-]{1,62}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 120),
  category text NOT NULL CHECK (category IN ('protection','equipment','fuel_plan','additional_driver','assistance','other')),
  active boolean NOT NULL DEFAULT true,
  created_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider_id, add_on_code)
);
CREATE INDEX IF NOT EXISTS vehicle_access_rental_add_on_provider_active_idx
  ON vehicle_access.rental_add_on(provider_id, display_name) WHERE active;

CREATE TABLE IF NOT EXISTS vehicle_access.rental_add_on_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  add_on_id uuid NOT NULL REFERENCES vehicle_access.rental_add_on(id) ON DELETE RESTRICT,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  charge_unit vehicle_access.rental_add_on_charge_unit NOT NULL,
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  max_quantity smallint NOT NULL DEFAULT 1 CHECK (max_quantity BETWEEN 1 AND 8),
  active boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  effective_to timestamptz,
  created_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX IF NOT EXISTS vehicle_access_rental_add_on_version_live_idx
  ON vehicle_access.rental_add_on_version(add_on_id, effective_from DESC) WHERE active;

CREATE TABLE IF NOT EXISTS vehicle_access.contract_add_on_selection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES vehicle_access.access_contract(id) ON DELETE RESTRICT,
  add_on_version_id uuid NOT NULL REFERENCES vehicle_access.rental_add_on_version(id) ON DELETE RESTRICT,
  add_on_code text NOT NULL CHECK (add_on_code ~ '^[a-z][a-z0-9_-]{1,62}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 120),
  charge_unit vehicle_access.rental_add_on_charge_unit NOT NULL,
  quantity smallint NOT NULL CHECK (quantity BETWEEN 1 AND 8),
  billing_units integer NOT NULL CHECK (billing_units >= 1),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  total_price_minor bigint NOT NULL CHECK (total_price_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (contract_id, add_on_version_id),
  UNIQUE (contract_id, add_on_code),
  CHECK (total_price_minor = unit_price_minor * quantity * billing_units)
);
CREATE INDEX IF NOT EXISTS vehicle_access_contract_add_on_selection_contract_idx
  ON vehicle_access.contract_add_on_selection(contract_id, add_on_code);

CREATE TABLE IF NOT EXISTS vehicle_access.contract_agreement_acceptance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES vehicle_access.access_contract(id) ON DELETE RESTRICT,
  agreement_version text NOT NULL CHECK (agreement_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$'),
  agreement_sha256_hex text NOT NULL CHECK (agreement_sha256_hex ~ '^[a-f0-9]{64}$'),
  acceptance_sha256_hex text NOT NULL CHECK (acceptance_sha256_hex ~ '^[a-f0-9]{64}$'),
  accepted_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  UNIQUE (contract_id, agreement_version),
  UNIQUE (contract_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS vehicle_access_contract_agreement_contract_idx
  ON vehicle_access.contract_agreement_acceptance(contract_id, accepted_at DESC);

CREATE TABLE IF NOT EXISTS vehicle_access.contract_extension_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES vehicle_access.access_contract(id) ON DELETE RESTRICT,
  requested_ends_at timestamptz NOT NULL,
  state vehicle_access.extension_request_state NOT NULL DEFAULT 'requested',
  requested_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  decided_by_user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
  decision_reason text CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 3 AND 1000),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  CHECK ((state IN ('approved','rejected','cancelled')) = (decided_at IS NOT NULL)),
  CHECK ((state IN ('approved','rejected','cancelled')) = (decided_by_user_id IS NOT NULL)),
  CHECK (state <> 'rejected' OR decision_reason IS NOT NULL),
  CHECK (state <> 'cancelled' OR decision_reason IS NOT NULL),
  UNIQUE (contract_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_access_contract_one_open_extension_idx
  ON vehicle_access.contract_extension_request(contract_id) WHERE state = 'requested';
CREATE INDEX IF NOT EXISTS vehicle_access_extension_request_state_idx
  ON vehicle_access.contract_extension_request(state, created_at);

CREATE TABLE IF NOT EXISTS vehicle_access.rental_operations_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL CHECK (aggregate_type IN ('location','asset','availability_block','add_on','agreement','extension')),
  aggregate_id uuid NOT NULL,
  actor_user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.]{2,95}$'),
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (aggregate_type, aggregate_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS vehicle_access_rental_operations_event_aggregate_idx
  ON vehicle_access.rental_operations_event(aggregate_type, aggregate_id, created_at DESC);

CREATE OR REPLACE FUNCTION vehicle_access.prevent_rental_operations_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, vehicle_access AS $$
BEGIN
  RAISE EXCEPTION 'vehicle-rental evidence is append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS vehicle_access_asset_location_assignment_append_only ON vehicle_access.asset_location_assignment;
CREATE TRIGGER vehicle_access_asset_location_assignment_append_only
  BEFORE UPDATE OR DELETE ON vehicle_access.asset_location_assignment
  FOR EACH ROW EXECUTE FUNCTION vehicle_access.prevent_rental_operations_mutation();
DROP TRIGGER IF EXISTS vehicle_access_contract_add_on_selection_append_only ON vehicle_access.contract_add_on_selection;
CREATE TRIGGER vehicle_access_contract_add_on_selection_append_only
  BEFORE UPDATE OR DELETE ON vehicle_access.contract_add_on_selection
  FOR EACH ROW EXECUTE FUNCTION vehicle_access.prevent_rental_operations_mutation();
DROP TRIGGER IF EXISTS vehicle_access_contract_agreement_acceptance_append_only ON vehicle_access.contract_agreement_acceptance;
CREATE TRIGGER vehicle_access_contract_agreement_acceptance_append_only
  BEFORE UPDATE OR DELETE ON vehicle_access.contract_agreement_acceptance
  FOR EACH ROW EXECUTE FUNCTION vehicle_access.prevent_rental_operations_mutation();
DROP TRIGGER IF EXISTS vehicle_access_rental_operations_event_append_only ON vehicle_access.rental_operations_event;
CREATE TRIGGER vehicle_access_rental_operations_event_append_only
  BEFORE UPDATE OR DELETE ON vehicle_access.rental_operations_event
  FOR EACH ROW EXECUTE FUNCTION vehicle_access.prevent_rental_operations_mutation();

CREATE OR REPLACE FUNCTION vehicle_access.append_rental_operations_event(
  p_type text, p_id uuid, p_actor integer, p_event_type text, p_detail jsonb, p_key text, p_now timestamptz
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
BEGIN
  INSERT INTO vehicle_access.rental_operations_event(aggregate_type, aggregate_id, actor_user_id, event_type, detail, idempotency_key, created_at)
  VALUES (p_type, p_id, p_actor, p_event_type, p_detail, p_key, p_now)
  ON CONFLICT (aggregate_type, aggregate_id, idempotency_key) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.create_provider_location(
  p_actor integer, p_provider uuid, p_code text, p_name text, p_address text, p_timezone text, p_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR upper(coalesce(p_code,'')) !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'
     OR length(coalesce(p_name,'')) NOT BETWEEN 2 AND 160
     OR length(coalesce(p_address,'')) NOT BETWEEN 3 AND 400
     OR coalesce(p_timezone,'') !~ '^[A-Za-z_]+/[A-Za-z_]+$' THEN
    RAISE EXCEPTION 'invalid provider location input' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicle_access.fleet_provider WHERE id = p_provider AND state = 'active') THEN
    RAISE EXCEPTION 'active provider required' USING ERRCODE = '23514';
  END IF;
  SELECT aggregate_id INTO v_id FROM vehicle_access.rental_operations_event
    WHERE aggregate_type = 'location' AND actor_user_id = p_actor AND idempotency_key = p_key LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO vehicle_access.provider_location(provider_id, location_code, display_name, address_summary, timezone_name, created_by_user_id, created_at, updated_at)
  VALUES (p_provider, upper(p_code), p_name, p_address, p_timezone, p_actor, p_now, p_now) RETURNING id INTO v_id;
  PERFORM vehicle_access.append_rental_operations_event('location', v_id, p_actor, 'vehicle_access.location.created', jsonb_build_object('provider_id', p_provider), p_key, p_now);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.assign_asset_location(
  p_actor integer, p_asset uuid, p_location uuid, p_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_assignment uuid; v_provider uuid;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid idempotency key' USING ERRCODE = '22023'; END IF;
  SELECT provider_id INTO v_provider FROM vehicle_access.vehicle_asset WHERE id = p_asset FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'asset not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicle_access.provider_location WHERE id = p_location AND provider_id = v_provider AND active) THEN
    RAISE EXCEPTION 'active provider location required' USING ERRCODE = '23514';
  END IF;
  SELECT id INTO v_assignment FROM vehicle_access.asset_location_assignment WHERE asset_id = p_asset AND idempotency_key = p_key;
  IF v_assignment IS NOT NULL THEN RETURN v_assignment; END IF;
  INSERT INTO vehicle_access.asset_location_assignment(asset_id, location_id, assigned_by_user_id, assigned_at, idempotency_key)
  VALUES (p_asset, p_location, p_actor, p_now, p_key) RETURNING id INTO v_assignment;
  PERFORM vehicle_access.append_rental_operations_event('asset', p_asset, p_actor, 'vehicle_access.asset.location_assigned', jsonb_build_object('location_id', p_location), p_key, p_now);
  RETURN v_assignment;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.create_availability_block(
  p_actor integer, p_asset uuid, p_reason text, p_note text, p_starts timestamptz, p_ends timestamptz, p_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR length(coalesce(p_note,'')) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'invalid availability block input' USING ERRCODE = '22023'; END IF;
  IF p_starts < p_now OR p_ends <= p_starts THEN RAISE EXCEPTION 'invalid availability interval' USING ERRCODE = '22023'; END IF;
  IF p_reason NOT IN ('maintenance','inspection','operator_hold','seasonal_unavailable','repair') THEN RAISE EXCEPTION 'invalid availability block reason' USING ERRCODE = '22023'; END IF;
  PERFORM 1 FROM vehicle_access.vehicle_asset WHERE id = p_asset FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'asset not found' USING ERRCODE = 'P0002'; END IF;
  SELECT aggregate_id INTO v_id FROM vehicle_access.rental_operations_event WHERE aggregate_type = 'availability_block' AND actor_user_id = p_actor AND idempotency_key = p_key LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  IF EXISTS (SELECT 1 FROM vehicle_access.access_contract c WHERE c.asset_id = p_asset AND c.state IN ('requested','approved','active','return_pending') AND tstzrange(c.starts_at,c.ends_at,'[)') && tstzrange(p_starts,p_ends,'[)')) THEN
    RAISE EXCEPTION 'availability block conflicts with contract' USING ERRCODE = '23P01';
  END IF;
  INSERT INTO vehicle_access.asset_availability_block(asset_id, block_reason, note, starts_at, ends_at, created_by_user_id, idempotency_key, created_at, updated_at)
  VALUES (p_asset, p_reason, p_note, p_starts, p_ends, p_actor, p_key, p_now, p_now) RETURNING id INTO v_id;
  PERFORM vehicle_access.append_rental_operations_event('availability_block', v_id, p_actor, 'vehicle_access.availability_block.created', jsonb_build_object('asset_id', p_asset, 'reason', p_reason), p_key, p_now);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.cancel_availability_block(
  p_actor integer, p_block uuid, p_reason text, p_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS vehicle_access.availability_block_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_block vehicle_access.asset_availability_block%ROWTYPE;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid idempotency key' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_block FROM vehicle_access.asset_availability_block WHERE id = p_block FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'availability block not found' USING ERRCODE = 'P0002'; END IF;
  IF EXISTS (SELECT 1 FROM vehicle_access.rental_operations_event WHERE aggregate_type = 'availability_block' AND aggregate_id = p_block AND idempotency_key = p_key) THEN RETURN v_block.state; END IF;
  IF v_block.state = 'cancelled' THEN RAISE EXCEPTION 'availability block already cancelled' USING ERRCODE = '23505'; END IF;
  IF length(coalesce(p_reason,'')) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'cancellation reason required' USING ERRCODE = '22023'; END IF;
  UPDATE vehicle_access.asset_availability_block SET state = 'cancelled', cancelled_by_user_id = p_actor, cancellation_reason = p_reason, updated_at = p_now WHERE id = p_block;
  PERFORM vehicle_access.append_rental_operations_event('availability_block', p_block, p_actor, 'vehicle_access.availability_block.cancelled', jsonb_build_object('reason', p_reason), p_key, p_now);
  RETURN 'cancelled';
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.create_rental_add_on(
  p_actor integer, p_provider uuid, p_code text, p_name text, p_category text, p_currency char(3), p_unit vehicle_access.rental_add_on_charge_unit, p_price bigint, p_max_quantity smallint, p_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_add_on uuid; v_version uuid;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR coalesce(p_code,'') !~ '^[a-z][a-z0-9_-]{1,62}$'
     OR length(coalesce(p_name,'')) NOT BETWEEN 2 AND 120
     OR p_category NOT IN ('protection','equipment','fuel_plan','additional_driver','assistance','other')
     OR p_currency !~ '^[A-Z]{3}$'
     OR p_price < 0
     OR p_max_quantity NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'invalid rental add-on input' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicle_access.fleet_provider WHERE id = p_provider AND state = 'active') THEN RAISE EXCEPTION 'active provider required' USING ERRCODE = '23514'; END IF;
  SELECT aggregate_id INTO v_add_on FROM vehicle_access.rental_operations_event WHERE aggregate_type = 'add_on' AND actor_user_id = p_actor AND idempotency_key = p_key LIMIT 1;
  IF v_add_on IS NOT NULL THEN RETURN v_add_on; END IF;
  INSERT INTO vehicle_access.rental_add_on(provider_id, add_on_code, display_name, category, created_by_user_id, created_at, updated_at)
  VALUES (p_provider, p_code, p_name, p_category, p_actor, p_now, p_now) RETURNING id INTO v_add_on;
  INSERT INTO vehicle_access.rental_add_on_version(add_on_id, currency, charge_unit, unit_price_minor, max_quantity, created_by_user_id, effective_from, created_at)
  VALUES (v_add_on, p_currency, p_unit, p_price, p_max_quantity, p_actor, p_now, p_now) RETURNING id INTO v_version;
  PERFORM vehicle_access.append_rental_operations_event('add_on', v_add_on, p_actor, 'vehicle_access.rental_add_on.created', jsonb_build_object('version_id',v_version,'currency',p_currency,'charge_unit',p_unit,'unit_price_minor',p_price), p_key, p_now);
  RETURN v_add_on;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.request_contract_with_add_ons(
  p_worker integer, p_offer uuid, p_starts timestamptz, p_ends timestamptz, p_add_ons jsonb, p_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_contract uuid; v_contract_row vehicle_access.access_contract%ROWTYPE; v_item jsonb; v_version vehicle_access.rental_add_on_version%ROWTYPE; v_add_on vehicle_access.rental_add_on%ROWTYPE; v_quantity smallint; v_multiplier bigint; v_total bigint := 0; v_selection jsonb := '[]'::jsonb; v_payload_sha256 text;
BEGIN
  IF jsonb_typeof(p_add_ons) IS DISTINCT FROM 'array' OR jsonb_array_length(p_add_ons) > 8 THEN RAISE EXCEPTION 'invalid add-on selection array' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_add_ons) AS item(value) GROUP BY item.value->>'add_on_version_id' HAVING count(*) > 1) THEN RAISE EXCEPTION 'duplicate add-on selection' USING ERRCODE = '22023'; END IF;
  v_payload_sha256 := encode(public.digest(p_add_ons::text,'sha256'),'hex');
  v_contract := vehicle_access.request_contract(p_worker, p_offer, p_starts, p_ends, p_key, p_now);
  SELECT * INTO v_contract_row FROM vehicle_access.access_contract WHERE id = v_contract FOR UPDATE;
  IF v_contract_row.price_snapshot ? 'add_ons_request_sha256' THEN
    IF v_contract_row.price_snapshot->>'add_ons_request_sha256' <> v_payload_sha256 THEN RAISE EXCEPTION 'idempotency key reused with different add-on selection' USING ERRCODE = '23505'; END IF;
    RETURN v_contract;
  END IF;
  IF EXISTS (SELECT 1 FROM vehicle_access.contract_add_on_selection WHERE contract_id = v_contract) THEN RAISE EXCEPTION 'contract add-on selection lacks replay fingerprint' USING ERRCODE = '55000'; END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_add_ons) LOOP
    IF jsonb_typeof(v_item) <> 'object' OR coalesce(v_item->>'add_on_version_id','') !~ '^[0-9a-fA-F-]{36}$' OR coalesce(v_item->>'quantity','') !~ '^[1-8]$' THEN RAISE EXCEPTION 'invalid add-on selection' USING ERRCODE = '22023'; END IF;
    v_quantity := (v_item->>'quantity')::smallint;
    SELECT * INTO v_version FROM vehicle_access.rental_add_on_version WHERE id = (v_item->>'add_on_version_id')::uuid AND active AND effective_from <= p_now AND (effective_to IS NULL OR effective_to > p_now) FOR UPDATE;
    IF NOT FOUND OR v_quantity > v_version.max_quantity THEN RAISE EXCEPTION 'unavailable add-on version' USING ERRCODE = '23514'; END IF;
    SELECT * INTO v_add_on FROM vehicle_access.rental_add_on WHERE id = v_version.add_on_id AND provider_id = v_contract_row.provider_id AND active;
    IF NOT FOUND OR v_version.currency <> (v_contract_row.price_snapshot->>'currency')::char(3) THEN RAISE EXCEPTION 'incompatible add-on' USING ERRCODE = '23514'; END IF;
    v_multiplier := CASE v_version.charge_unit WHEN 'flat' THEN 1 WHEN 'per_day' THEN CEIL(EXTRACT(EPOCH FROM (p_ends-p_starts))/86400.0)::bigint WHEN 'per_week' THEN CEIL(EXTRACT(EPOCH FROM (p_ends-p_starts))/604800.0)::bigint END;
    IF v_multiplier < 1 OR v_version.unit_price_minor > 9223372036854775807 / (v_quantity * v_multiplier) THEN RAISE EXCEPTION 'add-on total exceeds bigint range' USING ERRCODE = '22003'; END IF;
    IF v_total > 9223372036854775807 - (v_version.unit_price_minor * v_quantity * v_multiplier) THEN RAISE EXCEPTION 'add-on aggregate total exceeds bigint range' USING ERRCODE = '22003'; END IF;
    v_total := v_total + (v_version.unit_price_minor * v_quantity * v_multiplier);
    INSERT INTO vehicle_access.contract_add_on_selection(contract_id,add_on_version_id,add_on_code,display_name,charge_unit,quantity,billing_units,unit_price_minor,total_price_minor,created_at)
    VALUES (v_contract,v_version.id,v_add_on.add_on_code,v_add_on.display_name,v_version.charge_unit,v_quantity,v_multiplier::integer,v_version.unit_price_minor,v_version.unit_price_minor*v_quantity*v_multiplier,p_now);
    v_selection := v_selection || jsonb_build_array(jsonb_build_object('code',v_add_on.add_on_code,'version_id',v_version.id,'charge_unit',v_version.charge_unit,'quantity',v_quantity,'billing_units',v_multiplier,'unit_price_minor',v_version.unit_price_minor,'total_price_minor',v_version.unit_price_minor*v_quantity*v_multiplier));
  END LOOP;
  UPDATE vehicle_access.access_contract SET price_snapshot = price_snapshot || jsonb_build_object('selected_add_ons',v_selection,'add_ons_total_minor',v_total,'rental_duration_days',CEIL(EXTRACT(EPOCH FROM (p_ends-p_starts))/86400.0)::integer,'add_ons_request_sha256',v_payload_sha256), updated_at = p_now WHERE id = v_contract;
  PERFORM vehicle_access.append_event(v_contract,p_worker,'vehicle_access.contract.add_ons_selected','requested','requested',jsonb_build_object('add_ons_total_minor',v_total,'selection_count',jsonb_array_length(v_selection)),encode(public.digest(p_key || ':addons','sha256'),'hex'),p_now);
  PERFORM vehicle_access.enqueue_event(v_contract,'vehicle_access.contract.add_ons_selected',encode(public.digest(p_key || ':addons','sha256'),'hex'),p_now);
  RETURN v_contract;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.record_agreement_acceptance(
  p_worker integer, p_contract uuid, p_version text, p_agreement_sha256 text, p_acceptance_sha256 text, p_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_contract vehicle_access.access_contract%ROWTYPE; v_id uuid;
BEGIN
  IF coalesce(p_version,'') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$'
     OR p_agreement_sha256 !~ '^[a-f0-9]{64}$'
     OR p_acceptance_sha256 !~ '^[a-f0-9]{64}$'
     OR p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid agreement acceptance evidence' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_contract FROM vehicle_access.access_contract WHERE id = p_contract FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract not found' USING ERRCODE = 'P0002'; END IF;
  IF v_contract.worker_user_id <> p_worker THEN RAISE EXCEPTION 'contract worker required' USING ERRCODE = '42501'; END IF;
  IF v_contract.state NOT IN ('requested','approved') THEN RAISE EXCEPTION 'agreement not accepted in current state' USING ERRCODE = '23514'; END IF;
  INSERT INTO vehicle_access.contract_agreement_acceptance(contract_id,agreement_version,agreement_sha256_hex,acceptance_sha256_hex,accepted_by_user_id,accepted_at,idempotency_key)
  VALUES(p_contract,p_version,p_agreement_sha256,p_acceptance_sha256,p_worker,p_now,p_key)
  ON CONFLICT (contract_id,idempotency_key) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN SELECT id INTO v_id FROM vehicle_access.contract_agreement_acceptance WHERE contract_id=p_contract AND idempotency_key=p_key; END IF;
  IF v_id IS NULL THEN RAISE EXCEPTION 'agreement version already accepted with different evidence' USING ERRCODE='23505'; END IF;
  PERFORM vehicle_access.append_rental_operations_event('agreement',v_id,p_worker,'vehicle_access.contract.agreement_accepted',jsonb_build_object('contract_id',p_contract,'agreement_version',p_version,'agreement_sha256',p_agreement_sha256),p_key,p_now);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.request_contract_extension(
  p_worker integer, p_contract uuid, p_requested_ends timestamptz, p_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_contract vehicle_access.access_contract%ROWTYPE; v_id uuid;
BEGIN
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid idempotency key' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_contract FROM vehicle_access.access_contract WHERE id = p_contract FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM vehicle_access.vehicle_asset WHERE id = v_contract.asset_id FOR UPDATE;
  IF v_contract.worker_user_id <> p_worker THEN RAISE EXCEPTION 'contract worker required' USING ERRCODE = '42501'; END IF;
  IF v_contract.state NOT IN ('approved','active') THEN RAISE EXCEPTION 'extension not permitted in current state' USING ERRCODE = '23514'; END IF;
  IF p_requested_ends <= v_contract.ends_at OR p_requested_ends > v_contract.starts_at + interval '365 days' THEN RAISE EXCEPTION 'invalid requested extension end' USING ERRCODE = '22023'; END IF;
  SELECT id INTO v_id FROM vehicle_access.contract_extension_request WHERE contract_id=p_contract AND idempotency_key=p_key;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  IF EXISTS (SELECT 1 FROM vehicle_access.asset_availability_block b WHERE b.asset_id=v_contract.asset_id AND b.state='active' AND tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(v_contract.ends_at,p_requested_ends,'[)')) THEN RAISE EXCEPTION 'extension conflicts with availability block' USING ERRCODE='23P01'; END IF;
  INSERT INTO vehicle_access.contract_extension_request(contract_id,requested_ends_at,requested_by_user_id,idempotency_key,created_at)
  VALUES(p_contract,p_requested_ends,p_worker,p_key,p_now) RETURNING id INTO v_id;
  PERFORM vehicle_access.append_rental_operations_event('extension',v_id,p_worker,'vehicle_access.contract.extension_requested',jsonb_build_object('contract_id',p_contract,'requested_ends_at',p_requested_ends),p_key,p_now);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.decide_contract_extension(
  p_actor integer, p_extension uuid, p_action text, p_reason text, p_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS vehicle_access.extension_request_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_extension vehicle_access.contract_extension_request%ROWTYPE; v_contract vehicle_access.access_contract%ROWTYPE; v_next vehicle_access.extension_request_state;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE='42501'; END IF;
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid idempotency key' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_extension FROM vehicle_access.contract_extension_request WHERE id=p_extension FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'extension request not found' USING ERRCODE='P0002'; END IF;
  IF v_extension.state <> 'requested' THEN
    IF EXISTS(SELECT 1 FROM vehicle_access.rental_operations_event WHERE aggregate_type='extension' AND aggregate_id=p_extension AND idempotency_key=p_key) THEN RETURN v_extension.state; END IF;
    RAISE EXCEPTION 'extension request already decided' USING ERRCODE='23505';
  END IF;
  SELECT * INTO v_contract FROM vehicle_access.access_contract WHERE id=v_extension.contract_id FOR UPDATE;
  PERFORM 1 FROM vehicle_access.vehicle_asset WHERE id = v_contract.asset_id FOR UPDATE;
  IF p_action='approve' THEN
    IF EXISTS (SELECT 1 FROM vehicle_access.asset_availability_block b WHERE b.asset_id=v_contract.asset_id AND b.state='active' AND tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(v_contract.ends_at,v_extension.requested_ends_at,'[)')) THEN RAISE EXCEPTION 'extension conflicts with availability block' USING ERRCODE='23P01'; END IF;
    UPDATE vehicle_access.access_contract SET ends_at=v_extension.requested_ends_at, updated_at=p_now WHERE id=v_contract.id;
    v_next := 'approved';
  ELSIF p_action='reject' THEN
    IF length(coalesce(p_reason,'')) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'rejection reason required' USING ERRCODE='22023'; END IF;
    v_next := 'rejected';
  ELSE RAISE EXCEPTION 'invalid extension decision' USING ERRCODE='22023'; END IF;
  UPDATE vehicle_access.contract_extension_request SET state=v_next,decided_by_user_id=p_actor,decision_reason=CASE WHEN v_next='rejected' THEN p_reason ELSE NULL END,decided_at=p_now WHERE id=p_extension;
  PERFORM vehicle_access.append_event(v_contract.id,p_actor,CASE WHEN v_next='approved' THEN 'vehicle_access.contract.extension_approved' ELSE 'vehicle_access.contract.extension_rejected' END,v_contract.state,v_contract.state,jsonb_build_object('extension_id',p_extension,'requested_ends_at',v_extension.requested_ends_at,'reason',p_reason),p_key,p_now);
  PERFORM vehicle_access.append_rental_operations_event('extension',p_extension,p_actor,CASE WHEN v_next='approved' THEN 'vehicle_access.contract.extension_approved' ELSE 'vehicle_access.contract.extension_rejected' END,jsonb_build_object('contract_id',v_contract.id,'reason',p_reason),p_key,p_now);
  RETURN v_next;
END;
$$;

-- Extend handover authority with the independent agreement-acceptance prerequisite.
CREATE OR REPLACE FUNCTION vehicle_access.transition_contract(p_actor integer,p_contract uuid,p_action text,p_reason text,p_key text,p_now timestamptz DEFAULT clock_timestamp())
RETURNS vehicle_access.contract_state LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vehicle_access AS $$
DECLARE v_contract vehicle_access.access_contract%ROWTYPE; v_next vehicle_access.contract_state; v_event text;
BEGIN
  SELECT * INTO v_contract FROM vehicle_access.access_contract WHERE id=p_contract FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract not found' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM vehicle_access.vehicle_asset WHERE id = v_contract.asset_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM vehicle_access.contract_event WHERE contract_id=p_contract AND idempotency_key=p_key) THEN RETURN v_contract.state; END IF;
  IF p_action='cancel' AND p_actor=v_contract.worker_user_id AND v_contract.state IN ('requested','approved') THEN
    IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'cancellation reason required' USING ERRCODE='22023'; END IF;
    v_next='cancelled'; v_event='vehicle_access.contract.cancelled';
    IF v_contract.state='approved' THEN UPDATE vehicle_access.vehicle_asset SET state='available',updated_at=p_now WHERE id=v_contract.asset_id; END IF;
  ELSIF p_action='begin_return' AND p_actor=v_contract.worker_user_id AND v_contract.state='active' THEN
    v_next='return_pending'; v_event='vehicle_access.contract.return_pending'; UPDATE vehicle_access.vehicle_asset SET state='return_pending',updated_at=p_now WHERE id=v_contract.asset_id;
  ELSIF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE='42501';
  ELSIF p_action='approve' AND v_contract.state='requested' THEN
    IF NOT EXISTS(SELECT 1 FROM vehicle_access.vehicle_asset WHERE id=v_contract.asset_id AND state='available') THEN RAISE EXCEPTION 'asset unavailable' USING ERRCODE='23514'; END IF;
    IF EXISTS(SELECT 1 FROM vehicle_access.asset_availability_block b WHERE b.asset_id=v_contract.asset_id AND b.state='active' AND tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(v_contract.starts_at,v_contract.ends_at,'[)')) THEN RAISE EXCEPTION 'contract conflicts with availability block' USING ERRCODE='23P01'; END IF;
    v_next='approved'; v_event='vehicle_access.contract.approved'; UPDATE vehicle_access.vehicle_asset SET state='reserved',updated_at=p_now WHERE id=v_contract.asset_id;
  ELSIF p_action='handover' AND v_contract.state='approved' THEN
    IF NOT EXISTS(SELECT 1 FROM vehicle_access.inspection_evidence WHERE contract_id=p_contract AND kind='handover') THEN RAISE EXCEPTION 'handover inspection required' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS(SELECT 1 FROM vehicle_access.contract_agreement_acceptance WHERE contract_id=p_contract AND accepted_by_user_id=v_contract.worker_user_id) THEN RAISE EXCEPTION 'worker agreement acceptance required' USING ERRCODE='23514'; END IF;
    v_next='active'; v_event='vehicle_access.contract.activated'; UPDATE vehicle_access.vehicle_asset SET state='active_access',updated_at=p_now WHERE id=v_contract.asset_id;
  ELSIF p_action='close' AND v_contract.state='return_pending' THEN
    IF NOT EXISTS(SELECT 1 FROM vehicle_access.inspection_evidence WHERE contract_id=p_contract AND kind='return') THEN RAISE EXCEPTION 'return inspection required' USING ERRCODE='23514'; END IF;
    v_next='closed'; v_event='vehicle_access.contract.closed'; UPDATE vehicle_access.vehicle_asset SET state='available',updated_at=p_now WHERE id=v_contract.asset_id;
  ELSIF p_action='suspend' AND v_contract.state IN ('approved','active','return_pending') THEN
    IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'suspension reason required' USING ERRCODE='22023'; END IF;
    v_next='suspended'; v_event='vehicle_access.contract.suspended'; UPDATE vehicle_access.vehicle_asset SET state='safety_hold',updated_at=p_now WHERE id=v_contract.asset_id;
  ELSIF p_action='begin_safe_return' AND v_contract.state='suspended' THEN
    v_next='return_pending'; v_event='vehicle_access.contract.return_pending'; UPDATE vehicle_access.vehicle_asset SET state='return_pending',updated_at=p_now WHERE id=v_contract.asset_id;
  ELSE RAISE EXCEPTION 'invalid contract transition' USING ERRCODE='23514'; END IF;
  UPDATE vehicle_access.access_contract SET state=v_next,approved_by_user_id=CASE WHEN v_next='approved' THEN p_actor ELSE approved_by_user_id END,activated_at=CASE WHEN v_next='active' THEN p_now ELSE activated_at END,closed_at=CASE WHEN v_next='closed' THEN p_now ELSE closed_at END,cancellation_reason=CASE WHEN v_next='cancelled' THEN p_reason ELSE cancellation_reason END,suspension_reason=CASE WHEN v_next='suspended' THEN p_reason ELSE suspension_reason END,updated_at=p_now WHERE id=p_contract;
  PERFORM vehicle_access.append_event(p_contract,p_actor,v_event,v_contract.state,v_next,jsonb_build_object('reason',p_reason),p_key,p_now);
  PERFORM vehicle_access.enqueue_event(p_contract,v_event,p_key,p_now);
  RETURN v_next;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.list_rental_add_ons_for_offer(p_offer uuid, p_limit integer DEFAULT 24)
RETURNS TABLE(id uuid, add_on_code text, display_name text, category text, charge_unit vehicle_access.rental_add_on_charge_unit, unit_price_minor bigint, max_quantity smallint, currency char(3))
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,vehicle_access AS $$
  SELECT v.id,a.add_on_code,a.display_name,a.category,v.charge_unit,v.unit_price_minor,v.max_quantity,v.currency
  FROM vehicle_access.vehicle_offer o
  JOIN vehicle_access.rental_add_on a ON a.provider_id=o.provider_id AND a.active
  JOIN vehicle_access.rental_add_on_version v ON v.add_on_id=a.id AND v.active AND v.effective_from<=clock_timestamp() AND (v.effective_to IS NULL OR v.effective_to>clock_timestamp())
  WHERE o.id=p_offer AND o.active AND v.currency=o.currency
  ORDER BY a.display_name, v.effective_from DESC LIMIT LEAST(GREATEST(p_limit,1),24);
$$;

CREATE OR REPLACE FUNCTION vehicle_access.rental_operations_snapshot(p_actor integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,vehicle_access AS $$
  SELECT jsonb_build_object(
    'asset_state_counts', CASE WHEN vehicle_access.is_operator(p_actor) THEN COALESCE((SELECT jsonb_object_agg(state::text, count) FROM (SELECT state, count(*)::integer AS count FROM vehicle_access.vehicle_asset GROUP BY state) counts), '{}'::jsonb) ELSE '{}'::jsonb END,
    'active_availability_blocks', CASE WHEN vehicle_access.is_operator(p_actor) THEN (SELECT count(*)::integer FROM vehicle_access.asset_availability_block WHERE state='active' AND ends_at>clock_timestamp()) ELSE 0 END,
    'active_availability_block_items', CASE WHEN vehicle_access.is_operator(p_actor) THEN COALESCE((SELECT jsonb_agg(item) FROM (SELECT jsonb_build_object('id',b.id,'asset_id',b.asset_id,'reason',b.block_reason,'note',b.note,'starts_at',b.starts_at,'ends_at',b.ends_at) AS item FROM vehicle_access.asset_availability_block b WHERE b.state='active' AND b.ends_at>clock_timestamp() ORDER BY b.starts_at LIMIT 50) block_rows), '[]'::jsonb) ELSE '[]'::jsonb END,
    'requested_extensions', CASE WHEN vehicle_access.is_operator(p_actor) THEN (SELECT count(*)::integer FROM vehicle_access.contract_extension_request WHERE state='requested') ELSE 0 END,
    'requested_extension_items', CASE WHEN vehicle_access.is_operator(p_actor) THEN COALESCE((SELECT jsonb_agg(item) FROM (SELECT jsonb_build_object('id',e.id,'contract_id',e.contract_id,'reference',c.public_reference,'worker_user_id',e.requested_by_user_id,'requested_ends_at',e.requested_ends_at,'created_at',e.created_at) AS item FROM vehicle_access.contract_extension_request e JOIN vehicle_access.access_contract c ON c.id=e.contract_id WHERE e.state='requested' ORDER BY e.created_at LIMIT 50) extension_rows), '[]'::jsonb) ELSE '[]'::jsonb END,
    'provider_locations', CASE WHEN vehicle_access.is_operator(p_actor) THEN COALESCE((SELECT jsonb_agg(item) FROM (SELECT jsonb_build_object('id',l.id,'provider_id',l.provider_id,'location_code',l.location_code,'display_name',l.display_name,'address_summary',l.address_summary,'timezone_name',l.timezone_name) AS item FROM vehicle_access.provider_location l WHERE l.active ORDER BY l.display_name LIMIT 100) location_rows), '[]'::jsonb) ELSE '[]'::jsonb END,
    'current_asset_locations', CASE WHEN vehicle_access.is_operator(p_actor) THEN COALESCE((SELECT jsonb_agg(item) FROM (SELECT jsonb_build_object('asset_id',a.id,'registration_number',a.registration_number,'make',a.make,'model',a.model,'provider_id',a.provider_id,'location_id',l.id,'location_name',l.display_name,'location_code',l.location_code,'assigned_at',la.assigned_at) AS item FROM vehicle_access.vehicle_asset a LEFT JOIN vehicle_access.current_asset_location la ON la.asset_id=a.id LEFT JOIN vehicle_access.provider_location l ON l.id=la.location_id ORDER BY a.updated_at DESC LIMIT 100) asset_location_rows), '[]'::jsonb) ELSE '[]'::jsonb END,
    'upcoming_pickups', COALESCE((SELECT jsonb_agg(item) FROM (SELECT jsonb_build_object('contract_id',c.id,'reference',c.public_reference,'asset_id',c.asset_id,'starts_at',c.starts_at,'location',l.display_name) AS item FROM vehicle_access.access_contract c LEFT JOIN vehicle_access.current_asset_location la ON la.asset_id=c.asset_id LEFT JOIN vehicle_access.provider_location l ON l.id=la.location_id WHERE (vehicle_access.is_operator(p_actor) OR c.worker_user_id=p_actor) AND c.state='approved' AND c.starts_at BETWEEN clock_timestamp() AND clock_timestamp()+interval '7 days' ORDER BY c.starts_at LIMIT 25) pickup_rows), '[]'::jsonb),
    'upcoming_returns', COALESCE((SELECT jsonb_agg(item) FROM (SELECT jsonb_build_object('contract_id',c.id,'reference',c.public_reference,'asset_id',c.asset_id,'ends_at',c.ends_at,'state',c.state) AS item FROM vehicle_access.access_contract c WHERE (vehicle_access.is_operator(p_actor) OR c.worker_user_id=p_actor) AND c.state IN ('active','return_pending') AND c.ends_at BETWEEN clock_timestamp() AND clock_timestamp()+interval '7 days' ORDER BY c.ends_at LIMIT 25) return_rows), '[]'::jsonb)
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
  END IF;
END $$;

-- Replace the original request authority so all existing and add-on contract requests
-- share the same availability-block and per-asset serialization checks.
CREATE OR REPLACE FUNCTION vehicle_access.request_contract(
  p_worker integer,p_offer uuid,p_starts timestamptz,p_ends timestamptz,p_key text,p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vehicle_access AS $$
DECLARE v_offer vehicle_access.vehicle_offer%ROWTYPE; v_id uuid;
BEGIN
  IF p_starts < p_now OR p_ends <= p_starts OR p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid contract request' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_offer FROM vehicle_access.vehicle_offer WHERE id=p_offer AND active AND effective_from <= p_now AND (effective_to IS NULL OR effective_to > p_now) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active offer required' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM vehicle_access.vehicle_asset WHERE id=v_offer.asset_id AND state='available' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'available offer required' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM vehicle_access.asset_availability_block b WHERE b.asset_id=v_offer.asset_id AND b.state='active' AND tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(p_starts,p_ends,'[)')) THEN RAISE EXCEPTION 'contract conflicts with availability block' USING ERRCODE='23P01'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM vehicle_access.worker_eligibility eligibility
    JOIN vehicle_access.vehicle_asset asset ON asset.id=v_offer.asset_id
    WHERE eligibility.worker_user_id=p_worker AND eligibility.state='verified' AND eligibility.expires_at > p_now
      AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(eligibility.allowed_work_categories) AS worker_category(category)
                  JOIN jsonb_array_elements_text(asset.allowed_work_categories) AS asset_category(category) ON asset_category.category=worker_category.category)
  ) THEN RAISE EXCEPTION 'verified worker eligibility required' USING ERRCODE='23514'; END IF;
  IF p_ends < p_starts + make_interval(days => v_offer.minimum_days) THEN RAISE EXCEPTION 'minimum contract term not met' USING ERRCODE='23514'; END IF;
  SELECT contract_id INTO v_id FROM vehicle_access.contract_event WHERE idempotency_key=p_key AND actor_user_id=p_worker LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO vehicle_access.access_contract(worker_user_id,provider_id,asset_id,offer_id,starts_at,ends_at,price_snapshot,created_at,updated_at)
  VALUES(p_worker,v_offer.provider_id,v_offer.asset_id,v_offer.id,p_starts,p_ends,jsonb_build_object('currency',v_offer.currency,'weekly_price_minor',v_offer.weekly_price_minor,'deposit_minor',v_offer.deposit_minor,'included_km_per_week',v_offer.included_km_per_week,'excess_km_price_minor',v_offer.excess_km_price_minor),p_now,p_now) RETURNING id INTO v_id;
  PERFORM vehicle_access.append_event(v_id,p_worker,'vehicle_access.contract.requested',NULL,'requested',jsonb_build_object('offer_id',p_offer),p_key,p_now);
  PERFORM vehicle_access.enqueue_event(v_id,'vehicle_access.contract.requested',p_key,p_now);
  RETURN v_id;
END; $$;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='vehicle_access_service') THEN
    GRANT EXECUTE ON FUNCTION vehicle_access.request_contract(integer,uuid,timestamptz,timestamptz,text,timestamptz) TO vehicle_access_service;
  END IF;
END $$;

-- Preserve an explicit authority timestamp for offer activation so all later request
-- checks use a single auditable time basis rather than a table-default wall clock.
CREATE OR REPLACE FUNCTION vehicle_access.create_offer(
  p_actor integer,p_provider uuid,p_asset uuid,p_currency char(3),p_weekly bigint,p_deposit bigint,p_included_km integer,p_excess bigint,p_minimum_days smallint,p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vehicle_access AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM vehicle_access.vehicle_asset WHERE id=p_asset AND provider_id=p_provider AND state='available') THEN RAISE EXCEPTION 'available provider asset required' USING ERRCODE='23514'; END IF;
  INSERT INTO vehicle_access.vehicle_offer(provider_id,asset_id,currency,weekly_price_minor,deposit_minor,included_km_per_week,excess_km_price_minor,minimum_days,effective_from,created_by_user_id,created_at)
  VALUES(p_provider,p_asset,p_currency,p_weekly,p_deposit,p_included_km,p_excess,p_minimum_days,p_now,p_actor,p_now) RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='vehicle_access_service') THEN
    GRANT EXECUTE ON FUNCTION vehicle_access.create_offer(integer,uuid,uuid,char(3),bigint,bigint,integer,bigint,smallint,timestamptz) TO vehicle_access_service;
  END IF;
END $$;
