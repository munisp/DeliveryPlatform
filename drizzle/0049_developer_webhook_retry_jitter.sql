-- Deterministic retry jitter for developer webhook deliveries.
-- Deployment safety: apply only after 0048_developer_webhook_delivery_leases.sql.
-- The jitter is derived from delivery ID and claimed attempt count, so it is reproducible
-- for audit and test assertions while spreading otherwise synchronized retry cohorts.

DROP FUNCTION IF EXISTS developer.complete_webhook_delivery(uuid, uuid, boolean, integer, text, timestamptz);
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
  v_backoff_seconds integer;
  v_jitter_window_seconds integer;
  v_jitter_seconds integer;
  v_jitter_seed bytea;
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

  IF v_state = 'retrying'::developer.webhook_delivery_state THEN
    v_backoff_seconds := LEAST(
      3600,
      (2::numeric ^ v_delivery.attempt_count)::integer
    );
    v_jitter_window_seconds := GREATEST(
      1,
      ceil(v_backoff_seconds / 4.0)::integer
    );
    v_jitter_seed := public.digest(
      v_delivery.id::text || ':' || v_delivery.attempt_count::text,
      'sha256'
    );
    v_jitter_seconds := mod(
      get_byte(v_jitter_seed, 0) * 256 + get_byte(v_jitter_seed, 1),
      v_jitter_window_seconds + 1
    );
  END IF;

  UPDATE developer.webhook_delivery
  SET
    state = v_state,
    last_status = p_status,
    last_error = left(COALESCE(p_error, 'delivery_failed'), 2048),
    next_attempt_at = CASE
      WHEN v_state = 'dead_letter'::developer.webhook_delivery_state THEN next_attempt_at
      ELSE p_now + make_interval(
        secs => v_backoff_seconds + v_jitter_seconds
      )
    END,
    claim_token = NULL,
    claim_expires_at = NULL
  WHERE id = p_delivery_id;

  RETURN v_state;
END;
$$;

REVOKE ALL ON FUNCTION developer.complete_webhook_delivery(uuid, uuid, boolean, integer, text, timestamptz) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'developer_api_service') THEN
    GRANT EXECUTE ON FUNCTION developer.complete_webhook_delivery(uuid, uuid, boolean, integer, text, timestamptz)
      TO developer_api_service;
  END IF;
END;
$$;
