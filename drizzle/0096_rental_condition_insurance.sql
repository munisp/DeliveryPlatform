-- Rental condition & insurance hardening wave.
-- Adds zone-photo condition reports with odometer monotonicity, insurance tiers with
-- deposit recomputation, and a return settlement that finally advances the asset odometer.
-- Extends vehicle_access without changing financial settlement authority.
-- Applies after 0058_gig_vehicle_rental_operations.sql (next migration number after 0095).

DO $$ BEGIN
  CREATE TYPE vehicle_access.condition_phase AS ENUM ('check_out','check_in');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE vehicle_access.condition_grade AS ENUM ('excellent','good','fair','poor','damaged');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE vehicle_access.photo_zone AS ENUM ('front','rear','left','right','interior_front','interior_rear','dashboard_odometer','wheels','roof','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The 0058 CHECK limits aggregate_type to the original six values; extend it for this wave.
ALTER TABLE vehicle_access.rental_operations_event DROP CONSTRAINT IF EXISTS rental_operations_event_aggregate_type_check;
ALTER TABLE vehicle_access.rental_operations_event ADD CONSTRAINT rental_operations_event_aggregate_type_check
  CHECK (aggregate_type IN ('location','asset','availability_block','add_on','agreement','extension','insurance_tier','condition_report','settlement'));

CREATE TABLE IF NOT EXISTS vehicle_access.insurance_tier (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES vehicle_access.fleet_provider(id) ON DELETE RESTRICT,
  tier_code text NOT NULL CHECK (tier_code ~ '^[a-z][a-z0-9_-]{1,62}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 120),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  daily_rate_minor bigint NOT NULL CHECK (daily_rate_minor >= 0),
  excess_minor bigint NOT NULL CHECK (excess_minor >= 0),
  liability_cap_minor bigint NOT NULL CHECK (liability_cap_minor >= 0),
  damage_cap_minor bigint NOT NULL CHECK (damage_cap_minor >= 0),
  theft_covered boolean NOT NULL,
  deposit_multiplier_bp integer NOT NULL CHECK (deposit_multiplier_bp BETWEEN 0 AND 100000),
  active boolean NOT NULL DEFAULT true,
  created_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider_id, tier_code)
);
CREATE INDEX IF NOT EXISTS vehicle_access_insurance_tier_provider_active_idx
  ON vehicle_access.insurance_tier(provider_id, display_name) WHERE active;

CREATE TABLE IF NOT EXISTS vehicle_access.contract_insurance_selection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES vehicle_access.access_contract(id) ON DELETE RESTRICT,
  tier_id uuid NOT NULL REFERENCES vehicle_access.insurance_tier(id) ON DELETE RESTRICT,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  selected_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (contract_id),
  UNIQUE (contract_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS vehicle_access_contract_insurance_selection_tier_idx
  ON vehicle_access.contract_insurance_selection(tier_id, created_at DESC);

CREATE TABLE IF NOT EXISTS vehicle_access.condition_report (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES vehicle_access.access_contract(id) ON DELETE RESTRICT,
  phase vehicle_access.condition_phase NOT NULL,
  odometer_km integer NOT NULL CHECK (odometer_km >= 0),
  fuel_pct smallint NOT NULL CHECK (fuel_pct BETWEEN 0 AND 100),
  overall_condition vehicle_access.condition_grade NOT NULL,
  notes text CHECK (notes IS NULL OR length(notes) BETWEEN 3 AND 1000),
  captured_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (contract_id, phase),
  UNIQUE (contract_id, phase, idempotency_key)
);
CREATE INDEX IF NOT EXISTS vehicle_access_condition_report_contract_idx
  ON vehicle_access.condition_report(contract_id, created_at DESC);

CREATE TABLE IF NOT EXISTS vehicle_access.condition_photo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES vehicle_access.condition_report(id) ON DELETE RESTRICT,
  zone vehicle_access.photo_zone NOT NULL,
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 3 AND 512 AND object_key ~ '^[A-Za-z0-9][A-Za-z0-9._/-]+$'),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/heic')),
  sha256_hex text NOT NULL CHECK (sha256_hex ~ '^[a-f0-9]{64}$'),
  damage_flag boolean NOT NULL DEFAULT false,
  note text CHECK (note IS NULL OR length(note) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (report_id, zone, sha256_hex)
);
CREATE INDEX IF NOT EXISTS vehicle_access_condition_photo_report_idx
  ON vehicle_access.condition_photo(report_id, zone);

CREATE TABLE IF NOT EXISTS vehicle_access.return_settlement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL UNIQUE REFERENCES vehicle_access.access_contract(id) ON DELETE RESTRICT,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  odometer_out_km integer NOT NULL CHECK (odometer_out_km >= 0),
  odometer_in_km integer NOT NULL CHECK (odometer_in_km >= 0),
  distance_km integer NOT NULL,
  billed_weeks integer NOT NULL CHECK (billed_weeks >= 1),
  included_km integer NOT NULL CHECK (included_km >= 0),
  excess_km integer NOT NULL CHECK (excess_km >= 0),
  excess_km_charge_minor bigint NOT NULL CHECK (excess_km_charge_minor >= 0),
  fuel_out_pct smallint NOT NULL CHECK (fuel_out_pct BETWEEN 0 AND 100),
  fuel_in_pct smallint NOT NULL CHECK (fuel_in_pct BETWEEN 0 AND 100),
  fuel_charge_minor bigint NOT NULL CHECK (fuel_charge_minor >= 0),
  new_damage_zones jsonb NOT NULL CHECK (jsonb_typeof(new_damage_zones) = 'array'),
  damage_charge_minor bigint NOT NULL CHECK (damage_charge_minor >= 0),
  renter_damage_liability_minor bigint NOT NULL CHECK (renter_damage_liability_minor >= 0),
  insurance_credit_minor bigint NOT NULL CHECK (insurance_credit_minor >= 0),
  total_charge_minor bigint NOT NULL CHECK (total_charge_minor >= 0),
  assessed_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (distance_km = odometer_in_km - odometer_out_km AND distance_km >= 0),
  CHECK (total_charge_minor = excess_km_charge_minor + fuel_charge_minor + renter_damage_liability_minor)
);

DROP TRIGGER IF EXISTS vehicle_access_contract_insurance_selection_append_only ON vehicle_access.contract_insurance_selection;
CREATE TRIGGER vehicle_access_contract_insurance_selection_append_only
  BEFORE UPDATE OR DELETE ON vehicle_access.contract_insurance_selection
  FOR EACH ROW EXECUTE FUNCTION vehicle_access.prevent_rental_operations_mutation();
DROP TRIGGER IF EXISTS vehicle_access_condition_report_append_only ON vehicle_access.condition_report;
CREATE TRIGGER vehicle_access_condition_report_append_only
  BEFORE UPDATE OR DELETE ON vehicle_access.condition_report
  FOR EACH ROW EXECUTE FUNCTION vehicle_access.prevent_rental_operations_mutation();
DROP TRIGGER IF EXISTS vehicle_access_condition_photo_append_only ON vehicle_access.condition_photo;
CREATE TRIGGER vehicle_access_condition_photo_append_only
  BEFORE UPDATE OR DELETE ON vehicle_access.condition_photo
  FOR EACH ROW EXECUTE FUNCTION vehicle_access.prevent_rental_operations_mutation();
DROP TRIGGER IF EXISTS vehicle_access_return_settlement_append_only ON vehicle_access.return_settlement;
CREATE TRIGGER vehicle_access_return_settlement_append_only
  BEFORE UPDATE OR DELETE ON vehicle_access.return_settlement
  FOR EACH ROW EXECUTE FUNCTION vehicle_access.prevent_rental_operations_mutation();

CREATE OR REPLACE FUNCTION vehicle_access.create_insurance_tier(
  p_actor integer, p_provider uuid, p_code text, p_name text, p_currency char(3), p_daily_rate bigint, p_excess bigint, p_liability_cap bigint, p_damage_cap bigint, p_theft_covered boolean, p_deposit_multiplier_bp integer, p_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR coalesce(p_code,'') !~ '^[a-z][a-z0-9_-]{1,62}$'
     OR length(coalesce(p_name,'')) NOT BETWEEN 2 AND 120
     OR coalesce(p_currency::text,'') !~ '^[A-Z]{3}$'
     OR p_daily_rate < 0
     OR p_excess < 0
     OR p_liability_cap < 0
     OR p_damage_cap < 0
     OR p_theft_covered IS NULL
     OR p_deposit_multiplier_bp NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'invalid insurance tier input' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicle_access.fleet_provider WHERE id = p_provider AND state = 'active') THEN
    RAISE EXCEPTION 'active provider required' USING ERRCODE = '23514';
  END IF;
  SELECT aggregate_id INTO v_id FROM vehicle_access.rental_operations_event
    WHERE aggregate_type = 'insurance_tier' AND actor_user_id = p_actor AND idempotency_key = p_key LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO vehicle_access.insurance_tier(provider_id, tier_code, display_name, currency, daily_rate_minor, excess_minor, liability_cap_minor, damage_cap_minor, theft_covered, deposit_multiplier_bp, created_by_user_id, created_at, updated_at)
  VALUES (p_provider, p_code, p_name, p_currency, p_daily_rate, p_excess, p_liability_cap, p_damage_cap, p_theft_covered, p_deposit_multiplier_bp, p_actor, p_now, p_now) RETURNING id INTO v_id;
  PERFORM vehicle_access.append_rental_operations_event('insurance_tier', v_id, p_actor, 'vehicle_access.insurance_tier.created', jsonb_build_object('provider_id', p_provider, 'tier_code', p_code), p_key, p_now);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.retire_insurance_tier(
  p_actor integer, p_tier uuid, p_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_tier vehicle_access.insurance_tier%ROWTYPE;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid idempotency key' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_tier FROM vehicle_access.insurance_tier WHERE id = p_tier FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'insurance tier not found' USING ERRCODE = 'P0002'; END IF;
  IF EXISTS (SELECT 1 FROM vehicle_access.rental_operations_event WHERE aggregate_type = 'insurance_tier' AND aggregate_id = p_tier AND idempotency_key = p_key) THEN RETURN true; END IF;
  IF NOT v_tier.active THEN RAISE EXCEPTION 'insurance tier already retired' USING ERRCODE = '23505'; END IF;
  UPDATE vehicle_access.insurance_tier SET active = false, updated_at = p_now WHERE id = p_tier;
  PERFORM vehicle_access.append_rental_operations_event('insurance_tier', p_tier, p_actor, 'vehicle_access.insurance_tier.retired', jsonb_build_object('tier_code', v_tier.tier_code), p_key, p_now);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.select_contract_insurance(
  p_worker integer, p_contract uuid, p_tier uuid, p_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_contract vehicle_access.access_contract%ROWTYPE; v_tier vehicle_access.insurance_tier%ROWTYPE; v_existing vehicle_access.contract_insurance_selection%ROWTYPE; v_base_deposit bigint; v_deposit bigint; v_snapshot jsonb; v_id uuid;
BEGIN
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid idempotency key' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_contract FROM vehicle_access.access_contract WHERE id = p_contract FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract not found' USING ERRCODE = 'P0002'; END IF;
  IF v_contract.worker_user_id <> p_worker THEN RAISE EXCEPTION 'contract worker required' USING ERRCODE = '42501'; END IF;
  IF v_contract.state NOT IN ('requested','approved') THEN RAISE EXCEPTION 'insurance not selectable in current state' USING ERRCODE = '23514'; END IF;
  SELECT * INTO v_existing FROM vehicle_access.contract_insurance_selection WHERE contract_id = p_contract;
  IF FOUND THEN
    IF v_existing.idempotency_key = p_key AND v_existing.tier_id = p_tier THEN RETURN v_existing.id; END IF;
    IF v_existing.idempotency_key = p_key THEN RAISE EXCEPTION 'idempotency key reused with different insurance tier' USING ERRCODE = '23505'; END IF;
    RAISE EXCEPTION 'insurance already selected for contract' USING ERRCODE = '23505';
  END IF;
  SELECT * INTO v_tier FROM vehicle_access.insurance_tier WHERE id = p_tier AND active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active insurance tier required' USING ERRCODE = '23514'; END IF;
  IF v_tier.provider_id <> v_contract.provider_id THEN RAISE EXCEPTION 'insurance tier provider mismatch' USING ERRCODE = '23514'; END IF;
  IF v_tier.currency <> (v_contract.price_snapshot->>'currency')::char(3) THEN RAISE EXCEPTION 'insurance tier currency mismatch' USING ERRCODE = '23514'; END IF;
  v_base_deposit := coalesce((v_contract.price_snapshot->>'deposit_minor')::bigint, 0);
  IF v_tier.deposit_multiplier_bp > 0 AND v_base_deposit > 9223372036854775807 / v_tier.deposit_multiplier_bp THEN
    RAISE EXCEPTION 'insurance deposit exceeds bigint range' USING ERRCODE = '22003';
  END IF;
  v_deposit := round((v_base_deposit * v_tier.deposit_multiplier_bp)::numeric / 10000)::bigint;
  v_snapshot := jsonb_build_object(
    'tier_id', v_tier.id,
    'tier_code', v_tier.tier_code,
    'display_name', v_tier.display_name,
    'daily_rate_minor', v_tier.daily_rate_minor,
    'excess_minor', v_tier.excess_minor,
    'liability_cap_minor', v_tier.liability_cap_minor,
    'damage_cap_minor', v_tier.damage_cap_minor,
    'theft_covered', v_tier.theft_covered,
    'deposit_multiplier_bp', v_tier.deposit_multiplier_bp,
    'deposit_minor', v_deposit
  );
  INSERT INTO vehicle_access.contract_insurance_selection(contract_id, tier_id, snapshot, selected_by_user_id, idempotency_key, created_at)
  VALUES (p_contract, p_tier, v_snapshot, p_worker, p_key, p_now) RETURNING id INTO v_id;
  UPDATE vehicle_access.access_contract SET price_snapshot = price_snapshot || jsonb_build_object('insurance', v_snapshot), updated_at = p_now WHERE id = p_contract;
  PERFORM vehicle_access.append_rental_operations_event('insurance_tier', v_id, p_worker, 'vehicle_access.contract.insurance_selected', jsonb_build_object('contract_id', p_contract, 'tier_id', p_tier, 'deposit_minor', v_deposit), p_key, p_now);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.list_insurance_tiers_for_offer(p_offer uuid, p_limit integer DEFAULT 24)
RETURNS TABLE(id uuid, tier_code text, display_name text, currency char(3), daily_rate_minor bigint, excess_minor bigint, liability_cap_minor bigint, damage_cap_minor bigint, theft_covered boolean, deposit_multiplier_bp integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
  SELECT t.id, t.tier_code, t.display_name, t.currency, t.daily_rate_minor, t.excess_minor, t.liability_cap_minor, t.damage_cap_minor, t.theft_covered, t.deposit_multiplier_bp
  FROM vehicle_access.vehicle_offer o
  JOIN vehicle_access.insurance_tier t ON t.provider_id = o.provider_id AND t.active AND t.currency = o.currency
  WHERE o.id = p_offer AND o.active
  ORDER BY t.daily_rate_minor, t.tier_code
  LIMIT LEAST(GREATEST(p_limit, 1), 24);
$$;

CREATE OR REPLACE FUNCTION vehicle_access.record_condition_report(
  p_actor integer, p_contract uuid, p_phase vehicle_access.condition_phase, p_odometer integer, p_fuel_pct smallint, p_overall vehicle_access.condition_grade, p_notes text, p_photos jsonb, p_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_contract vehicle_access.access_contract%ROWTYPE; v_existing vehicle_access.condition_report%ROWTYPE; v_check_out vehicle_access.condition_report%ROWTYPE; v_photo jsonb; v_id uuid;
BEGIN
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR p_odometer < 0
     OR p_fuel_pct NOT BETWEEN 0 AND 100
     OR p_phase IS NULL
     OR p_overall IS NULL
     OR (p_notes IS NOT NULL AND length(p_notes) NOT BETWEEN 3 AND 1000) THEN
    RAISE EXCEPTION 'invalid condition report input' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_photos) IS DISTINCT FROM 'array' OR jsonb_array_length(p_photos) NOT BETWEEN 1 AND 24 THEN
    RAISE EXCEPTION 'invalid condition photo set' USING ERRCODE = '22023';
  END IF;
  FOR v_photo IN SELECT value FROM jsonb_array_elements(p_photos) AS photo(value) LOOP
    IF jsonb_typeof(v_photo) <> 'object'
       OR coalesce(v_photo->>'zone','') NOT IN ('front','rear','left','right','interior_front','interior_rear','dashboard_odometer','wheels','roof','other')
       OR length(coalesce(v_photo->>'object_key','')) NOT BETWEEN 3 AND 512
       OR coalesce(v_photo->>'object_key','') !~ '^[A-Za-z0-9][A-Za-z0-9._/-]+$'
       OR coalesce(v_photo->>'content_type','') NOT IN ('image/jpeg','image/png','image/heic')
       OR coalesce(v_photo->>'sha256_hex','') !~ '^[a-f0-9]{64}$'
       OR jsonb_typeof(v_photo->'damage_flag') IS DISTINCT FROM 'boolean'
       OR (v_photo->>'note' IS NOT NULL AND length(v_photo->>'note') NOT BETWEEN 3 AND 500) THEN
      RAISE EXCEPTION 'invalid condition photo' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_photos) AS photo(value) GROUP BY photo.value->>'zone', photo.value->>'sha256_hex' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'duplicate condition photo' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_photos) AS photo(value) WHERE photo.value->>'zone' = 'dashboard_odometer') THEN
    RAISE EXCEPTION 'dashboard_odometer photo required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_contract FROM vehicle_access.access_contract WHERE id = p_contract FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract not found' USING ERRCODE = 'P0002'; END IF;
  IF v_contract.worker_user_id <> p_actor AND NOT vehicle_access.is_operator(p_actor) THEN
    RAISE EXCEPTION 'contract worker or operator required' USING ERRCODE = '42501';
  END IF;
  IF p_phase = 'check_out' AND v_contract.state NOT IN ('approved','active') THEN
    RAISE EXCEPTION 'check-out report not permitted in current state' USING ERRCODE = '23514';
  END IF;
  IF p_phase = 'check_in' AND v_contract.state NOT IN ('active','return_pending') THEN
    RAISE EXCEPTION 'check-in report not permitted in current state' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_existing FROM vehicle_access.condition_report WHERE contract_id = p_contract AND phase = p_phase;
  IF FOUND THEN
    IF v_existing.idempotency_key = p_key THEN RETURN v_existing.id; END IF;
    RAISE EXCEPTION 'condition report already recorded for phase' USING ERRCODE = '23505';
  END IF;
  IF p_phase = 'check_in' THEN
    SELECT * INTO v_check_out FROM vehicle_access.condition_report WHERE contract_id = p_contract AND phase = 'check_out';
    IF FOUND AND p_odometer < v_check_out.odometer_km THEN
      RAISE EXCEPTION 'odometer regression' USING ERRCODE = '23514';
    END IF;
  END IF;
  INSERT INTO vehicle_access.condition_report(contract_id, phase, odometer_km, fuel_pct, overall_condition, notes, captured_by_user_id, idempotency_key, created_at)
  VALUES (p_contract, p_phase, p_odometer, p_fuel_pct, p_overall, p_notes, p_actor, p_key, p_now) RETURNING id INTO v_id;
  INSERT INTO vehicle_access.condition_photo(report_id, zone, object_key, content_type, sha256_hex, damage_flag, note, created_at)
  SELECT v_id,
         (photo.value->>'zone')::vehicle_access.photo_zone,
         photo.value->>'object_key',
         photo.value->>'content_type',
         photo.value->>'sha256_hex',
         (photo.value->>'damage_flag')::boolean,
         photo.value->>'note',
         p_now
  FROM jsonb_array_elements(p_photos) AS photo(value);
  PERFORM vehicle_access.append_rental_operations_event('condition_report', v_id, p_actor, 'vehicle_access.condition_report.recorded', jsonb_build_object('contract_id', p_contract, 'phase', p_phase, 'odometer_km', p_odometer, 'fuel_pct', p_fuel_pct, 'photo_count', jsonb_array_length(p_photos)), p_key, p_now);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.compute_return_settlement(
  p_actor integer, p_contract uuid, p_damage_charge_minor bigint, p_fuel_charge_minor bigint, p_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE
  v_contract vehicle_access.access_contract%ROWTYPE;
  v_check_out vehicle_access.condition_report%ROWTYPE;
  v_check_in vehicle_access.condition_report%ROWTYPE;
  v_selection vehicle_access.contract_insurance_selection%ROWTYPE;
  v_existing uuid;
  v_billed_weeks integer;
  v_included_km_per_week integer;
  v_included_km integer;
  v_distance integer;
  v_excess_km integer;
  v_excess_km_price bigint;
  v_excess_charge bigint;
  v_excess_minor bigint;
  v_damage_cap bigint;
  v_renter_liability bigint;
  v_insurance_credit bigint;
  v_total bigint;
  v_new_damage jsonb;
  v_id uuid;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR p_damage_charge_minor < 0
     OR p_fuel_charge_minor < 0 THEN
    RAISE EXCEPTION 'invalid return settlement input' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_contract FROM vehicle_access.access_contract WHERE id = p_contract FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM vehicle_access.vehicle_asset WHERE id = v_contract.asset_id FOR UPDATE;
  SELECT id INTO v_existing FROM vehicle_access.return_settlement WHERE contract_id = p_contract;
  IF v_existing IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM vehicle_access.return_settlement WHERE contract_id = p_contract AND idempotency_key = p_key) THEN RETURN v_existing; END IF;
    RAISE EXCEPTION 'return settlement already computed' USING ERRCODE = '23505';
  END IF;
  IF v_contract.state <> 'return_pending' THEN RAISE EXCEPTION 'return settlement requires return_pending state' USING ERRCODE = '23514'; END IF;
  SELECT * INTO v_check_out FROM vehicle_access.condition_report WHERE contract_id = p_contract AND phase = 'check_out';
  IF NOT FOUND THEN RAISE EXCEPTION 'check-out condition report required' USING ERRCODE = '23514'; END IF;
  SELECT * INTO v_check_in FROM vehicle_access.condition_report WHERE contract_id = p_contract AND phase = 'check_in';
  IF NOT FOUND THEN RAISE EXCEPTION 'check-in condition report required' USING ERRCODE = '23514'; END IF;
  IF v_contract.activated_at IS NULL THEN RAISE EXCEPTION 'contract activation timestamp missing' USING ERRCODE = '23514'; END IF;
  v_distance := v_check_in.odometer_km - v_check_out.odometer_km;
  IF v_distance < 0 THEN RAISE EXCEPTION 'odometer regression' USING ERRCODE = '23514'; END IF;
  v_billed_weeks := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (p_now - v_contract.activated_at))/604800.0)::integer);
  v_included_km_per_week := coalesce((v_contract.price_snapshot->>'included_km_per_week')::integer, 0);
  v_excess_km_price := coalesce((v_contract.price_snapshot->>'excess_km_price_minor')::bigint, 0);
  IF v_included_km_per_week > 0 AND v_billed_weeks > 2147483647 / v_included_km_per_week THEN
    RAISE EXCEPTION 'included km exceeds integer range' USING ERRCODE = '22003';
  END IF;
  v_included_km := v_included_km_per_week * v_billed_weeks;
  v_excess_km := GREATEST(0, v_distance - v_included_km);
  IF v_excess_km > 0 AND v_excess_km_price > 9223372036854775807 / v_excess_km THEN
    RAISE EXCEPTION 'excess km charge exceeds bigint range' USING ERRCODE = '22003';
  END IF;
  v_excess_charge := v_excess_km::bigint * v_excess_km_price;
  SELECT COALESCE(jsonb_agg(zone ORDER BY zone), '[]'::jsonb) INTO v_new_damage
  FROM (
    SELECT DISTINCT check_in_photo.zone::text AS zone
    FROM vehicle_access.condition_photo check_in_photo
    WHERE check_in_photo.report_id = v_check_in.id AND check_in_photo.damage_flag
    EXCEPT
    SELECT DISTINCT check_out_photo.zone::text
    FROM vehicle_access.condition_photo check_out_photo
    WHERE check_out_photo.report_id = v_check_out.id AND check_out_photo.damage_flag
  ) new_damage(zone);
  SELECT * INTO v_selection FROM vehicle_access.contract_insurance_selection WHERE contract_id = p_contract;
  IF FOUND THEN
    v_excess_minor := coalesce((v_selection.snapshot->>'excess_minor')::bigint, 0);
    v_damage_cap := coalesce((v_selection.snapshot->>'damage_cap_minor')::bigint, 0);
    v_renter_liability := LEAST(p_damage_charge_minor, v_excess_minor);
    v_insurance_credit := LEAST(GREATEST(p_damage_charge_minor - v_excess_minor, 0), v_damage_cap);
  ELSE
    v_renter_liability := p_damage_charge_minor;
    v_insurance_credit := 0;
  END IF;
  IF v_excess_charge > 9223372036854775807 - p_fuel_charge_minor
     OR v_excess_charge + p_fuel_charge_minor > 9223372036854775807 - v_renter_liability THEN
    RAISE EXCEPTION 'settlement total exceeds bigint range' USING ERRCODE = '22003';
  END IF;
  v_total := v_excess_charge + p_fuel_charge_minor + v_renter_liability;
  INSERT INTO vehicle_access.return_settlement(
    contract_id, currency, odometer_out_km, odometer_in_km, distance_km, billed_weeks, included_km, excess_km,
    excess_km_charge_minor, fuel_out_pct, fuel_in_pct, fuel_charge_minor, new_damage_zones, damage_charge_minor,
    renter_damage_liability_minor, insurance_credit_minor, total_charge_minor, assessed_by_user_id, idempotency_key, created_at
  ) VALUES (
    p_contract, (v_contract.price_snapshot->>'currency')::char(3), v_check_out.odometer_km, v_check_in.odometer_km, v_distance,
    v_billed_weeks, v_included_km, v_excess_km, v_excess_charge, v_check_out.fuel_pct, v_check_in.fuel_pct, p_fuel_charge_minor,
    v_new_damage, p_damage_charge_minor, v_renter_liability, v_insurance_credit, v_total, p_actor, p_key, p_now
  ) RETURNING id INTO v_id;
  UPDATE vehicle_access.vehicle_asset SET odometer_km = v_check_in.odometer_km, updated_at = p_now WHERE id = v_contract.asset_id;
  PERFORM vehicle_access.append_rental_operations_event('settlement', v_id, p_actor, 'vehicle_access.return_settlement.computed', jsonb_build_object('contract_id', p_contract, 'distance_km', v_distance, 'billed_weeks', v_billed_weeks, 'excess_km', v_excess_km, 'excess_km_charge_minor', v_excess_charge, 'renter_damage_liability_minor', v_renter_liability, 'insurance_credit_minor', v_insurance_credit, 'total_charge_minor', v_total), p_key, p_now);
  PERFORM vehicle_access.append_event(p_contract, p_actor, 'vehicle_access.contract.settlement_computed', 'return_pending', 'return_pending', jsonb_build_object('settlement_id', v_id, 'total_charge_minor', v_total), p_key, p_now);
  PERFORM vehicle_access.enqueue_event(p_contract, 'vehicle_access.contract.settlement_computed', p_key, p_now);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.condition_delta_report(p_actor integer, p_contract uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE
  v_contract vehicle_access.access_contract%ROWTYPE;
  v_check_out jsonb;
  v_check_in jsonb;
  v_settlement jsonb;
  v_deltas jsonb;
  v_new_damage jsonb;
BEGIN
  SELECT * INTO v_contract FROM vehicle_access.access_contract WHERE id = p_contract;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract not found' USING ERRCODE = 'P0002'; END IF;
  IF v_contract.worker_user_id <> p_actor AND NOT vehicle_access.is_operator(p_actor) THEN
    RAISE EXCEPTION 'operator or contract worker required' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    'id', r.id, 'contract_id', r.contract_id, 'phase', r.phase, 'odometer_km', r.odometer_km,
    'fuel_pct', r.fuel_pct, 'overall_condition', r.overall_condition, 'notes', r.notes,
    'captured_by_user_id', r.captured_by_user_id, 'idempotency_key', r.idempotency_key, 'created_at', r.created_at,
    'photos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', p.id, 'zone', p.zone, 'object_key', p.object_key, 'content_type', p.content_type, 'sha256_hex', p.sha256_hex, 'damage_flag', p.damage_flag, 'note', p.note, 'created_at', p.created_at) ORDER BY p.zone, p.created_at)
      FROM vehicle_access.condition_photo p WHERE p.report_id = r.id
    ), '[]'::jsonb)
  ) INTO v_check_out
  FROM vehicle_access.condition_report r WHERE r.contract_id = p_contract AND r.phase = 'check_out';
  SELECT jsonb_build_object(
    'id', r.id, 'contract_id', r.contract_id, 'phase', r.phase, 'odometer_km', r.odometer_km,
    'fuel_pct', r.fuel_pct, 'overall_condition', r.overall_condition, 'notes', r.notes,
    'captured_by_user_id', r.captured_by_user_id, 'idempotency_key', r.idempotency_key, 'created_at', r.created_at,
    'photos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', p.id, 'zone', p.zone, 'object_key', p.object_key, 'content_type', p.content_type, 'sha256_hex', p.sha256_hex, 'damage_flag', p.damage_flag, 'note', p.note, 'created_at', p.created_at) ORDER BY p.zone, p.created_at)
      FROM vehicle_access.condition_photo p WHERE p.report_id = r.id
    ), '[]'::jsonb)
  ) INTO v_check_in
  FROM vehicle_access.condition_report r WHERE r.contract_id = p_contract AND r.phase = 'check_in';
  IF v_check_out IS NOT NULL AND v_check_in IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(zone ORDER BY zone), '[]'::jsonb) INTO v_new_damage
    FROM (
      SELECT DISTINCT check_in_photo.value->>'zone' AS zone
      FROM jsonb_array_elements(v_check_in->'photos') AS check_in_photo(value)
      WHERE (check_in_photo.value->>'damage_flag')::boolean
      EXCEPT
      SELECT DISTINCT check_out_photo.value->>'zone'
      FROM jsonb_array_elements(v_check_out->'photos') AS check_out_photo(value)
      WHERE (check_out_photo.value->>'damage_flag')::boolean
    ) new_damage(zone);
    v_deltas := jsonb_build_object(
      'odometer_km', (v_check_in->>'odometer_km')::integer - (v_check_out->>'odometer_km')::integer,
      'fuel_pct', (v_check_in->>'fuel_pct')::smallint - (v_check_out->>'fuel_pct')::smallint,
      'new_damage_zones', v_new_damage
    );
  ELSE
    v_deltas := jsonb_build_object('odometer_km', NULL, 'fuel_pct', NULL, 'new_damage_zones', '[]'::jsonb);
  END IF;
  SELECT jsonb_build_object(
    'id', s.id, 'contract_id', s.contract_id, 'currency', s.currency,
    'odometer_out_km', s.odometer_out_km, 'odometer_in_km', s.odometer_in_km, 'distance_km', s.distance_km,
    'billed_weeks', s.billed_weeks, 'included_km', s.included_km, 'excess_km', s.excess_km,
    'excess_km_charge_minor', s.excess_km_charge_minor,
    'fuel_out_pct', s.fuel_out_pct, 'fuel_in_pct', s.fuel_in_pct, 'fuel_charge_minor', s.fuel_charge_minor,
    'new_damage_zones', s.new_damage_zones, 'damage_charge_minor', s.damage_charge_minor,
    'renter_damage_liability_minor', s.renter_damage_liability_minor, 'insurance_credit_minor', s.insurance_credit_minor,
    'total_charge_minor', s.total_charge_minor, 'assessed_by_user_id', s.assessed_by_user_id, 'created_at', s.created_at
  ) INTO v_settlement
  FROM vehicle_access.return_settlement s WHERE s.contract_id = p_contract;
  RETURN jsonb_build_object(
    'contract_id', p_contract,
    'check_out', v_check_out,
    'check_in', v_check_in,
    'deltas', v_deltas,
    'settlement', v_settlement
  );
END;
$$;

-- Extend handover and close authority with the condition-report and return-settlement prerequisites.
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
    IF NOT EXISTS(SELECT 1 FROM vehicle_access.condition_report WHERE contract_id=p_contract AND phase='check_out') THEN RAISE EXCEPTION 'check-out condition report required' USING ERRCODE='23514'; END IF;
    v_next='active'; v_event='vehicle_access.contract.activated'; UPDATE vehicle_access.vehicle_asset SET state='active_access',updated_at=p_now WHERE id=v_contract.asset_id;
  ELSIF p_action='close' AND v_contract.state='return_pending' THEN
    IF NOT EXISTS(SELECT 1 FROM vehicle_access.inspection_evidence WHERE contract_id=p_contract AND kind='return') THEN RAISE EXCEPTION 'return inspection required' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS(SELECT 1 FROM vehicle_access.condition_report WHERE contract_id=p_contract AND phase='check_in') THEN RAISE EXCEPTION 'check-in condition report required' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS(SELECT 1 FROM vehicle_access.return_settlement WHERE contract_id=p_contract) THEN RAISE EXCEPTION 'return settlement required' USING ERRCODE='23514'; END IF;
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

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='vehicle_access_service') THEN
    GRANT EXECUTE ON FUNCTION vehicle_access.create_insurance_tier(integer,uuid,text,text,char(3),bigint,bigint,bigint,bigint,boolean,integer,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.retire_insurance_tier(integer,uuid,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.select_contract_insurance(integer,uuid,uuid,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.list_insurance_tiers_for_offer(uuid,integer) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.record_condition_report(integer,uuid,vehicle_access.condition_phase,integer,smallint,vehicle_access.condition_grade,text,jsonb,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.compute_return_settlement(integer,uuid,bigint,bigint,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.condition_delta_report(integer,uuid) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.transition_contract(integer,uuid,text,text,text,timestamptz) TO vehicle_access_service;
  END IF;
END $$;
