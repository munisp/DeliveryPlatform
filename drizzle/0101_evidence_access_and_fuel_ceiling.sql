-- Evidence access & dispute adjustment ceiling wave (P2 closures).
-- (a) vehicle_access.can_view_contract_evidence: party gate for the rental
--     condition photo download endpoint (GET /api/rental-condition/photo/<key>)
--     and any future evidence readers — true iff the actor is an operator
--     (is_operator) or the contract's renter (access_contract.worker_user_id,
--     see 0058_gig_vehicle_rental_operations.sql). Read-only: STABLE.
-- (b) decide_settlement_dispute: the 'adjusted' ceiling in 0097 covered only
--     renter_damage_liability_minor + excess_km_charge_minor, excluding the
--     fuel charge even though fuel_charge_minor is a renter-disputable line
--     item (dispute_reason 'fuel_charge'). The ceiling is now
--     renter_damage_liability_minor + excess_km_charge_minor + fuel_charge_minor
--     (= total_charge_minor by the return_settlement CHECK). Every other aspect
--     of the function — validation, error codes, event payloads, idempotency —
--     is byte-identical to 0097_settlement_disputes.sql.
-- Applies after 0100_outbox_claim_event_filter.sql.

CREATE OR REPLACE FUNCTION vehicle_access.can_view_contract_evidence(
  p_actor integer, p_contract uuid
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
  SELECT vehicle_access.is_operator(p_actor)
         OR EXISTS (
           SELECT 1
           FROM vehicle_access.access_contract c
           WHERE c.id = p_contract AND c.worker_user_id = p_actor
         );
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

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='vehicle_access_service') THEN
    GRANT EXECUTE ON FUNCTION vehicle_access.can_view_contract_evidence(integer,uuid) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.decide_settlement_dispute(integer,uuid,vehicle_access.dispute_status,bigint,text,text,timestamptz) TO vehicle_access_service;
  END IF;
END $$;
