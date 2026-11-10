-- Vehicle access outbox notification claim wave.
-- vehicle_access.outbox_event accumulates contract lifecycle events (notably
-- settlement dispute opened/decided from 0097_settlement_disputes.sql) but had
-- no consumer: vehicle_access tables are REVOKED from PUBLIC and the app role
-- only holds EXECUTE on SECURITY DEFINER functions, so the notification sweep
-- cannot claim rows with a direct UPDATE. These functions close that gap:
-- claim_outbox_events marks a batch published (published_at marker + FOR
-- UPDATE SKIP LOCKED, idempotent under concurrent sweeps) and
-- get_contract_event_detail exposes the matching contract_event detail
-- (decision status / adjustment) that the outbox payload does not carry.
-- Applies after 0097_settlement_disputes.sql (next migration number after 0097).

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
    ORDER BY p.created_at
    LIMIT LEAST(GREATEST(p_limit, 1), 500)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING o.id, o.aggregate_id, o.event_type, o.payload, o.idempotency_key, o.created_at;
END;
$$;

-- The outbox payload carries worker_user_id but not the dispute decision
-- outcome; that lives in vehicle_access.contract_event.detail keyed by
-- (contract_id, idempotency_key). Enriched with the settlement currency (via
-- detail->>'settlement_id') so notifications can render amounts in major
-- units when the currency is known. Returns NULL when no event matches.
CREATE OR REPLACE FUNCTION vehicle_access.get_contract_event_detail(p_contract_id uuid, p_idempotency_key text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
  SELECT ce.detail || CASE
           WHEN rs.currency IS NOT NULL THEN jsonb_build_object('currency', rs.currency)
           ELSE '{}'::jsonb
         END
  FROM vehicle_access.contract_event ce
  LEFT JOIN vehicle_access.return_settlement rs ON rs.id::text = ce.detail->>'settlement_id'
  WHERE ce.contract_id = p_contract_id
    AND ce.idempotency_key = p_idempotency_key
  ORDER BY ce.created_at DESC, ce.sequence_no DESC
  LIMIT 1;
$$;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='vehicle_access_service') THEN
    GRANT EXECUTE ON FUNCTION vehicle_access.claim_outbox_events(integer) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.get_contract_event_detail(uuid,text) TO vehicle_access_service;
  END IF;
END $$;
