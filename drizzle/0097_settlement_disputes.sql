-- Settlement dispute wave.
-- Adds renter-opened disputes against a computed return settlement with an
-- operator decision workflow (upheld / rejected / adjusted).
-- Extends vehicle_access without changing financial settlement authority:
-- an 'adjusted' decision records the adjustment amount only; money movement
-- itself is performed by the operator through the existing financial ops.
-- Applies after 0096_rental_condition_insurance.sql (next migration number after 0096).
--
-- Mutability note: settlement_dispute follows the 0058 contract_extension_request
-- precedent for request/decision tables — mutable status + decided_* columns, a
-- partial unique index for the open state, and NO append-only trigger. The
-- append-only trigger (prevent_rental_operations_mutation) raises on EVERY
-- UPDATE/DELETE and is reserved for pure evidence tables; decision tables in this
-- schema (contract_extension_request, asset_availability_block) are mutable.

DO $$ BEGIN
  CREATE TYPE vehicle_access.dispute_status AS ENUM ('open','upheld','rejected','adjusted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE vehicle_access.dispute_reason AS ENUM ('damage_charge','excess_km_charge','fuel_charge','odometer_dispute','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Extend the aggregate_type CHECK with 'settlement_dispute' (10 values total).
ALTER TABLE vehicle_access.rental_operations_event DROP CONSTRAINT IF EXISTS rental_operations_event_aggregate_type_check;
ALTER TABLE vehicle_access.rental_operations_event ADD CONSTRAINT rental_operations_event_aggregate_type_check
  CHECK (aggregate_type IN ('location','asset','availability_block','add_on','agreement','extension','insurance_tier','condition_report','settlement','settlement_dispute'));

CREATE TABLE IF NOT EXISTS vehicle_access.settlement_dispute (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES vehicle_access.access_contract(id),
  settlement_id uuid NOT NULL REFERENCES vehicle_access.return_settlement(id),
  renter_user_id integer NOT NULL,
  reason vehicle_access.dispute_reason NOT NULL,
  detail text NOT NULL CHECK (char_length(detail) BETWEEN 10 AND 2000),
  status vehicle_access.dispute_status NOT NULL DEFAULT 'open',
  adjustment_minor bigint CHECK (adjustment_minor IS NULL OR adjustment_minor >= 0),
  operator_note text CHECK (operator_note IS NULL OR char_length(operator_note) <= 2000),
  decided_by integer,
  decided_at timestamptz,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key),
  CHECK ((status = 'open') = (decided_at IS NULL)),
  CHECK ((status = 'open') = (decided_by IS NULL)),
  CHECK (status = 'open' OR status = 'adjusted' OR adjustment_minor IS NULL),
  CHECK (status <> 'adjusted' OR adjustment_minor IS NOT NULL)
);

-- One OPEN dispute per contract (mirrors vehicle_access_contract_one_open_extension_idx).
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_access_settlement_dispute_one_open_idx
  ON vehicle_access.settlement_dispute(contract_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS vehicle_access_settlement_dispute_contract_idx
  ON vehicle_access.settlement_dispute(contract_id, created_at DESC);
CREATE INDEX IF NOT EXISTS vehicle_access_settlement_dispute_status_idx
  ON vehicle_access.settlement_dispute(status, created_at DESC);

CREATE OR REPLACE FUNCTION vehicle_access.open_settlement_dispute(
  p_actor integer, p_contract uuid, p_reason vehicle_access.dispute_reason, p_detail text, p_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE
  v_contract vehicle_access.access_contract%ROWTYPE;
  v_settlement vehicle_access.return_settlement%ROWTYPE;
  v_id uuid;
BEGIN
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR p_reason IS NULL
     OR char_length(coalesce(p_detail,'')) NOT BETWEEN 10 AND 2000 THEN
    RAISE EXCEPTION 'invalid settlement dispute input' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_contract FROM vehicle_access.access_contract WHERE id = p_contract FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract not found' USING ERRCODE = 'P0002'; END IF;
  IF v_contract.worker_user_id <> p_actor THEN RAISE EXCEPTION 'contract renter required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_settlement FROM vehicle_access.return_settlement WHERE contract_id = p_contract;
  IF NOT FOUND THEN RAISE EXCEPTION 'return settlement required' USING ERRCODE = '23514'; END IF;
  SELECT id INTO v_id FROM vehicle_access.settlement_dispute WHERE idempotency_key = p_key;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  IF EXISTS (SELECT 1 FROM vehicle_access.settlement_dispute WHERE contract_id = p_contract AND status = 'open') THEN
    RAISE EXCEPTION 'open dispute already exists for contract' USING ERRCODE = '23505';
  END IF;
  INSERT INTO vehicle_access.settlement_dispute(contract_id, settlement_id, renter_user_id, reason, detail, idempotency_key, created_at)
  VALUES (p_contract, v_settlement.id, p_actor, p_reason, p_detail, p_key, p_now) RETURNING id INTO v_id;
  PERFORM vehicle_access.append_rental_operations_event('settlement_dispute', v_id, p_actor, 'vehicle_access.settlement_dispute.opened', jsonb_build_object('contract_id', p_contract, 'settlement_id', v_settlement.id, 'reason', p_reason), p_key, p_now);
  PERFORM vehicle_access.append_event(p_contract, p_actor, 'vehicle_access.contract.settlement_dispute_opened', v_contract.state, v_contract.state, jsonb_build_object('dispute_id', v_id, 'settlement_id', v_settlement.id, 'reason', p_reason), p_key, p_now);
  PERFORM vehicle_access.enqueue_event(p_contract, 'vehicle_access.contract.settlement_dispute_opened', p_key, p_now);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.decide_settlement_dispute(
  p_actor integer, p_dispute uuid, p_status vehicle_access.dispute_status, p_adjustment_minor bigint, p_operator_note text, p_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE
  v_dispute vehicle_access.settlement_dispute%ROWTYPE;
  v_settlement vehicle_access.return_settlement%ROWTYPE;
  v_state vehicle_access.contract_state;
  v_max_adjustment bigint;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid idempotency key' USING ERRCODE = '22023'; END IF;
  IF p_status IS NULL OR p_status = 'open' THEN RAISE EXCEPTION 'invalid dispute decision' USING ERRCODE = '23514'; END IF;
  IF p_operator_note IS NOT NULL AND char_length(p_operator_note) > 2000 THEN RAISE EXCEPTION 'invalid operator note' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_dispute FROM vehicle_access.settlement_dispute WHERE id = p_dispute FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'settlement dispute not found' USING ERRCODE = 'P0002'; END IF;
  IF v_dispute.status <> 'open' THEN
    IF EXISTS (SELECT 1 FROM vehicle_access.rental_operations_event WHERE aggregate_type = 'settlement_dispute' AND aggregate_id = p_dispute AND idempotency_key = p_key) THEN RETURN p_dispute; END IF;
    RAISE EXCEPTION 'dispute_not_open' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_settlement FROM vehicle_access.return_settlement WHERE id = v_dispute.settlement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'return settlement missing for dispute' USING ERRCODE = '55000'; END IF;
  -- renter_damage_liability_minor + excess_km_charge_minor <= total_charge_minor by the
  -- settlement CHECK, so the disputable ceiling can never overflow bigint.
  v_max_adjustment := v_settlement.renter_damage_liability_minor + v_settlement.excess_km_charge_minor;
  IF p_status = 'adjusted' THEN
    IF p_adjustment_minor IS NULL OR p_adjustment_minor < 0 OR p_adjustment_minor > v_max_adjustment THEN
      RAISE EXCEPTION 'adjustment exceeds disputable charge total' USING ERRCODE = '23514';
    END IF;
  ELSIF p_adjustment_minor IS NOT NULL THEN
    RAISE EXCEPTION 'adjustment only permitted for adjusted disputes' USING ERRCODE = '23514';
  END IF;
  UPDATE vehicle_access.settlement_dispute
  SET status = p_status,
      adjustment_minor = CASE WHEN p_status = 'adjusted' THEN p_adjustment_minor ELSE NULL END,
      operator_note = p_operator_note,
      decided_by = p_actor,
      decided_at = p_now
  WHERE id = p_dispute;
  SELECT state INTO v_state FROM vehicle_access.access_contract WHERE id = v_dispute.contract_id;
  PERFORM vehicle_access.append_rental_operations_event('settlement_dispute', p_dispute, p_actor, 'vehicle_access.settlement_dispute.decided', jsonb_build_object('contract_id', v_dispute.contract_id, 'settlement_id', v_dispute.settlement_id, 'status', p_status, 'adjustment_minor', CASE WHEN p_status = 'adjusted' THEN p_adjustment_minor ELSE NULL END, 'money_movement', 'out_of_scope_operator_applies_via_financial_ops'), p_key, p_now);
  PERFORM vehicle_access.append_event(v_dispute.contract_id, p_actor, 'vehicle_access.contract.settlement_dispute_decided', v_state, v_state, jsonb_build_object('dispute_id', p_dispute, 'settlement_id', v_dispute.settlement_id, 'status', p_status, 'adjustment_minor', CASE WHEN p_status = 'adjusted' THEN p_adjustment_minor ELSE NULL END), p_key, p_now);
  PERFORM vehicle_access.enqueue_event(v_dispute.contract_id, 'vehicle_access.contract.settlement_dispute_decided', p_key, p_now);
  RETURN p_dispute;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.list_settlement_disputes(
  p_actor integer, p_contract uuid DEFAULT NULL, p_status vehicle_access.dispute_status DEFAULT NULL, p_limit integer DEFAULT 50
) RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
  SELECT jsonb_build_object(
    'id', d.id, 'contract_id', d.contract_id, 'settlement_id', d.settlement_id,
    'renter_user_id', d.renter_user_id, 'reason', d.reason, 'detail', d.detail,
    'status', d.status, 'adjustment_minor', d.adjustment_minor,
    'operator_note', d.operator_note, 'decided_by', d.decided_by, 'decided_at', d.decided_at,
    'idempotency_key', d.idempotency_key, 'created_at', d.created_at
  )
  FROM vehicle_access.settlement_dispute d
  WHERE (vehicle_access.is_operator(p_actor) OR d.renter_user_id = p_actor)
    AND (p_contract IS NULL OR d.contract_id = p_contract)
    AND (p_status IS NULL OR d.status = p_status)
  ORDER BY d.created_at DESC, d.id
  LIMIT LEAST(GREATEST(p_limit, 1), 200);
$$;

CREATE OR REPLACE FUNCTION vehicle_access.get_settlement_dispute(p_actor integer, p_dispute uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_dispute vehicle_access.settlement_dispute%ROWTYPE;
BEGIN
  SELECT * INTO v_dispute FROM vehicle_access.settlement_dispute WHERE id = p_dispute;
  IF NOT FOUND THEN RAISE EXCEPTION 'settlement dispute not found' USING ERRCODE = 'P0002'; END IF;
  IF v_dispute.renter_user_id <> p_actor AND NOT vehicle_access.is_operator(p_actor) THEN
    RAISE EXCEPTION 'dispute renter or operator required' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'id', v_dispute.id, 'contract_id', v_dispute.contract_id, 'settlement_id', v_dispute.settlement_id,
    'renter_user_id', v_dispute.renter_user_id, 'reason', v_dispute.reason, 'detail', v_dispute.detail,
    'status', v_dispute.status, 'adjustment_minor', v_dispute.adjustment_minor,
    'operator_note', v_dispute.operator_note, 'decided_by', v_dispute.decided_by, 'decided_at', v_dispute.decided_at,
    'idempotency_key', v_dispute.idempotency_key, 'created_at', v_dispute.created_at
  );
END;
$$;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='vehicle_access_service') THEN
    GRANT EXECUTE ON FUNCTION vehicle_access.open_settlement_dispute(integer,uuid,vehicle_access.dispute_reason,text,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.decide_settlement_dispute(integer,uuid,vehicle_access.dispute_status,bigint,text,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.list_settlement_disputes(integer,uuid,vehicle_access.dispute_status,integer) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.get_settlement_dispute(integer,uuid) TO vehicle_access_service;
  END IF;
END $$;
