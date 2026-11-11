-- Rollback for 0101_evidence_access_and_fuel_ceiling.sql: drop the evidence
-- access gate and restore decide_settlement_dispute to its exact 0097 body (the
-- 'adjusted' ceiling again excludes the fuel charge). CREATE OR REPLACE
-- preserves the grants from 0097/0101.
DROP FUNCTION IF EXISTS vehicle_access.can_view_contract_evidence(integer,uuid);

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
