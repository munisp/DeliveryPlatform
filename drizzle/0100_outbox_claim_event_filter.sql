-- Outbox claim event-type filter wave.
-- 0098's vehicle_access.claim_outbox_events claimed ALL unpublished
-- outbox_event rows and marked them published, but the notification sweep only
-- handles settlement_dispute_opened / settlement_dispute_decided payloads —
-- every other event type (e.g. vehicle_access.contract.settlement_computed)
-- was permanently consumed and silently dropped. This migration narrows the
-- claim subquery to the event types the sweep actually handles; unknown events
-- intentionally remain unpublished for future consumers.
-- Identical signature and return shape as 0098 (CREATE OR REPLACE preserves
-- existing grants; the guarded GRANT block below mirrors 0098 for safety).
-- Applies after 0098_outbox_notification_claim.sql (next migration number after 0099).

CREATE OR REPLACE FUNCTION vehicle_access.claim_outbox_events(p_limit integer)
RETURNS TABLE(id uuid, aggregate_id uuid, event_type text, payload jsonb, idempotency_key text, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
BEGIN
  -- p_limit is clamped 1..500 so a misconfigured caller can neither claim an
  -- unbounded batch nor disable the sweep with 0/negative input.
  RETURN QUERY
  UPDATE vehicle_access.outbox_event o
  SET published_at = now()
  WHERE o.id IN (
    SELECT p.id
    FROM vehicle_access.outbox_event p
    WHERE p.published_at IS NULL
      AND p.event_type IN ('vehicle_access.contract.settlement_dispute_opened','vehicle_access.contract.settlement_dispute_decided')
    ORDER BY p.created_at
    LIMIT LEAST(GREATEST(p_limit, 1), 500)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING o.id, o.aggregate_id, o.event_type, o.payload, o.idempotency_key, o.created_at;
END;
$$;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='vehicle_access_service') THEN
    GRANT EXECUTE ON FUNCTION vehicle_access.claim_outbox_events(integer) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.get_contract_event_detail(uuid,text) TO vehicle_access_service;
  END IF;
END $$;
