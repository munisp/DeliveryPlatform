-- Rollback for 0100_outbox_claim_event_filter.sql: restore claim_outbox_events
-- to its exact 0098 body (claims every unpublished outbox row; no event-type
-- filter). CREATE OR REPLACE preserves the 0098 grant to vehicle_access_service.
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
