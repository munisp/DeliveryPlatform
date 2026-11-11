-- Rollback for 0096_rental_condition_insurance.sql: drop the insurance tier,
-- condition report/photo and return settlement objects in reverse dependency
-- order, restore transition_contract to its exact 0058 body (removing the
-- check-out/check-in condition report and return settlement gates), and restore
-- the rental_operations_event aggregate_type CHECK to the 0058 set (NOT VALID
-- so pre-existing event rows do not block the rollback).
DROP TRIGGER IF EXISTS vehicle_access_return_settlement_append_only ON vehicle_access.return_settlement;
DROP TRIGGER IF EXISTS vehicle_access_condition_photo_append_only ON vehicle_access.condition_photo;
DROP TRIGGER IF EXISTS vehicle_access_condition_report_append_only ON vehicle_access.condition_report;
DROP TRIGGER IF EXISTS vehicle_access_contract_insurance_selection_append_only ON vehicle_access.contract_insurance_selection;
DROP FUNCTION IF EXISTS vehicle_access.condition_delta_report(integer,uuid);
DROP FUNCTION IF EXISTS vehicle_access.compute_return_settlement(integer,uuid,bigint,bigint,text,timestamptz);
DROP FUNCTION IF EXISTS vehicle_access.record_condition_report(integer,uuid,vehicle_access.condition_phase,integer,smallint,vehicle_access.condition_grade,text,jsonb,text,timestamptz);
DROP FUNCTION IF EXISTS vehicle_access.list_insurance_tiers_for_offer(uuid,integer);
DROP FUNCTION IF EXISTS vehicle_access.select_contract_insurance(integer,uuid,uuid,text,timestamptz);
DROP FUNCTION IF EXISTS vehicle_access.retire_insurance_tier(integer,uuid,text,timestamptz);
DROP FUNCTION IF EXISTS vehicle_access.create_insurance_tier(integer,uuid,text,text,char(3),bigint,bigint,bigint,bigint,boolean,integer,text,timestamptz);
DROP TABLE IF EXISTS vehicle_access.condition_photo;
DROP TABLE IF EXISTS vehicle_access.condition_report;
DROP TABLE IF EXISTS vehicle_access.return_settlement;
DROP TABLE IF EXISTS vehicle_access.contract_insurance_selection;
DROP TABLE IF EXISTS vehicle_access.insurance_tier;
DROP TYPE IF EXISTS vehicle_access.photo_zone;
DROP TYPE IF EXISTS vehicle_access.condition_grade;
DROP TYPE IF EXISTS vehicle_access.condition_phase;

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

ALTER TABLE vehicle_access.rental_operations_event DROP CONSTRAINT IF EXISTS rental_operations_event_aggregate_type_check;
ALTER TABLE vehicle_access.rental_operations_event ADD CONSTRAINT rental_operations_event_aggregate_type_check
  CHECK (aggregate_type IN ('location','asset','availability_block','add_on','agreement','extension')) NOT VALID;
