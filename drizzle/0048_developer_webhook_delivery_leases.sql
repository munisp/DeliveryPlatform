-- Durable ownership lease and retry hardening for developer webhook delivery.
-- Deployment safety: stop or disable all pre-0048 dispatchers before applying this migration,
-- then deploy code that passes claim_token to completion before re-enabling dispatch.

ALTER TABLE developer.webhook_delivery
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;

ALTER TABLE developer.webhook_delivery
  DROP CONSTRAINT IF EXISTS developer_webhook_delivery_claim_pair_check;
ALTER TABLE developer.webhook_delivery
  ADD CONSTRAINT developer_webhook_delivery_claim_pair_check
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL));

CREATE INDEX IF NOT EXISTS developer_webhook_delivery_claim_lease_idx
  ON developer.webhook_delivery (claim_expires_at)
  WHERE state = 'retrying'::developer.webhook_delivery_state;

DROP FUNCTION IF EXISTS developer.claim_webhook_deliveries(integer, timestamptz);
CREATE FUNCTION developer.claim_webhook_deliveries(
  p_limit integer,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (
  delivery_id uuid,
  endpoint_url text,
  signing_secret_ref text,
  event_id uuid,
  event_type text,
  payload jsonb,
  created_at timestamptz,
  attempt_count integer,
  claim_token uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, developer
AS $$
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid webhook claim limit' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT delivery.id
    FROM developer.webhook_delivery AS delivery
    WHERE delivery.state IN (
      'pending'::developer.webhook_delivery_state,
      'retrying'::developer.webhook_delivery_state
    )
      AND delivery.next_attempt_at <= p_now
      AND delivery.attempt_count < 16
      AND (
        delivery.state = 'pending'::developer.webhook_delivery_state
        OR delivery.claim_expires_at IS NULL
        OR delivery.claim_expires_at <= p_now
      )
    ORDER BY delivery.next_attempt_at, delivery.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE developer.webhook_delivery AS delivery
    SET
      state = 'retrying'::developer.webhook_delivery_state,
      attempt_count = delivery.attempt_count + 1,
      last_error = NULL,
      claim_token = gen_random_uuid(),
      claim_expires_at = p_now + interval '30 seconds'
    FROM candidates
    WHERE delivery.id = candidates.id
    RETURNING delivery.*
  )
  SELECT
    claimed.id,
    endpoint.url,
    endpoint.signing_secret_ref,
    claimed.event_id,
    claimed.event_type,
    claimed.payload,
    claimed.created_at,
    claimed.attempt_count,
    claimed.claim_token
  FROM claimed
  JOIN developer.webhook_endpoint AS endpoint ON endpoint.id = claimed.webhook_endpoint_id;
END;
$$;

DROP FUNCTION IF EXISTS developer.complete_webhook_delivery(uuid, boolean, integer, text, timestamptz);
CREATE FUNCTION developer.complete_webhook_delivery(
  p_delivery_id uuid,
  p_claim_token uuid,
  p_succeeded boolean,
  p_status integer,
  p_error text DEFAULT NULL,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS developer.webhook_delivery_state
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, developer
AS $$
DECLARE
  v_delivery developer.webhook_delivery%ROWTYPE;
  v_state developer.webhook_delivery_state;
BEGIN
  SELECT *
  INTO v_delivery
  FROM developer.webhook_delivery
  WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'webhook delivery not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_delivery.state <> 'retrying'::developer.webhook_delivery_state THEN
    RETURN v_delivery.state;
  END IF;
  IF v_delivery.claim_token IS DISTINCT FROM p_claim_token
    OR v_delivery.claim_expires_at IS NULL
    OR v_delivery.claim_expires_at < p_now THEN
    RAISE EXCEPTION 'webhook delivery claim is stale or owned by another worker'
      USING ERRCODE = '55000';
  END IF;

  IF p_succeeded THEN
    UPDATE developer.webhook_delivery
    SET
      state = 'delivered'::developer.webhook_delivery_state,
      delivered_at = p_now,
      last_status = p_status,
      last_error = NULL,
      claim_token = NULL,
      claim_expires_at = NULL
    WHERE id = p_delivery_id;
    RETURN 'delivered'::developer.webhook_delivery_state;
  END IF;

  v_state := CASE
    WHEN v_delivery.attempt_count >= 16 THEN 'dead_letter'::developer.webhook_delivery_state
    ELSE 'retrying'::developer.webhook_delivery_state
  END;

  UPDATE developer.webhook_delivery
  SET
    state = v_state,
    last_status = p_status,
    last_error = left(COALESCE(p_error, 'delivery_failed'), 2048),
    next_attempt_at = CASE
      WHEN v_state = 'dead_letter'::developer.webhook_delivery_state THEN next_attempt_at
      ELSE p_now + make_interval(secs => LEAST(3600, 2 ^ v_delivery.attempt_count))
    END,
    claim_token = NULL,
    claim_expires_at = NULL
  WHERE id = p_delivery_id;

  RETURN v_state;
END;
$$;

REVOKE ALL ON FUNCTION developer.claim_webhook_deliveries(integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION developer.complete_webhook_delivery(uuid, uuid, boolean, integer, text, timestamptz) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'developer_api_service') THEN
    GRANT EXECUTE ON FUNCTION developer.claim_webhook_deliveries(integer, timestamptz)
      TO developer_api_service;
    GRANT EXECUTE ON FUNCTION developer.complete_webhook_delivery(uuid, uuid, boolean, integer, text, timestamptz)
      TO developer_api_service;
  END IF;
END;
$$;
