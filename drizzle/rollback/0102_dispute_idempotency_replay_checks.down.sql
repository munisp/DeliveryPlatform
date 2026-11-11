-- Rollback for 0102_dispute_idempotency_replay_checks.sql: restore
-- open_settlement_dispute to its exact 0097 body and decide_settlement_dispute
-- to its exact 0101 body (same-key replays again return success without
-- parameter comparison). CREATE OR REPLACE preserves the existing grants.

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
  -- renter_damage_liability_minor + excess_km_charge_minor + fuel_charge_minor =
  -- total_charge_minor by the settlement CHECK, so the disputable ceiling can never
  -- overflow bigint. The fuel charge is a renter-disputable line item (dispute_reason
  -- 'fuel_charge'), so it is part of the ceiling (0101; 0097 excluded it).
  v_max_adjustment := v_settlement.renter_damage_liability_minor + v_settlement.excess_km_charge_minor + v_settlement.fuel_charge_minor;
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
