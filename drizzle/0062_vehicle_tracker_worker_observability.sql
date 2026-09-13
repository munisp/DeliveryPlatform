-- Dedicated tracker-worker observability read model.
-- This migration deliberately exposes no credentials, external event IDs, cursor text, device IDs,
-- user information, payment data, or raw telemetry payloads to the metrics process.

-- The service role is created by the deployment environment; on fresh
-- databases (rehearsals, CI, local dev) it does not exist yet, so create a
-- NOLOGIN placeholder to keep REVOKE/GRANT statements below idempotent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vehicle_access_service') THEN
    CREATE ROLE vehicle_access_service NOLOGIN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION vehicle_access.list_tracker_provider_ingest_observability(
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE(
  provider_kind text,
  integration_key text,
  lease_expires_at_epoch numeric,
  cursor_age_seconds numeric,
  last_error_age_seconds numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, vehicle_access
AS $$
  SELECT
    p.provider_kind::text,
    p.integration_key,
    coalesce(extract(epoch FROM c.claim_expires_at), 0)::numeric,
    greatest(0, extract(epoch FROM p_now - coalesce(c.last_success_at, c.updated_at)))::numeric,
    CASE
      WHEN c.last_error_at IS NULL THEN NULL
      ELSE greatest(0, extract(epoch FROM p_now - c.last_error_at))::numeric
    END
  FROM vehicle_access.tracker_provider p
  JOIN vehicle_access.tracker_provider_ingest_cursor c
    ON c.tracker_provider_id = p.id
  WHERE p.state = 'active'
    AND p.provider_kind IN ('geotab_feed', 'traccar_rest')
  ORDER BY p.provider_kind, p.integration_key;
$$;

REVOKE ALL ON FUNCTION vehicle_access.list_tracker_provider_ingest_observability(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vehicle_access.list_tracker_provider_ingest_observability(timestamptz)
  TO vehicle_access_service;

-- The SECURITY DEFINER owner must hold PostgreSQL's pg_read_all_stats (or pg_monitor)
-- membership in the deployed database. If it does not, this function fails closed with
-- 42501 and the worker exposes its observability-up gauge as zero instead of fabricating
-- lock-wait metrics. The runtime service receives no direct pg_stat_activity access.
CREATE OR REPLACE FUNCTION vehicle_access.tracker_worker_database_lock_metrics()
RETURNS TABLE(
  active_transactions integer,
  lock_waiting_transactions integer,
  max_lock_wait_seconds numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, vehicle_access
AS $$
BEGIN
  RETURN QUERY
  SELECT
    count(*) FILTER (WHERE state = 'active')::integer,
    count(*) FILTER (WHERE wait_event_type = 'Lock')::integer,
    coalesce(
      max(extract(epoch FROM statement_timestamp() - query_start))
        FILTER (WHERE wait_event_type = 'Lock'),
      0
    )::numeric
  FROM pg_stat_activity
  WHERE datname = current_database()
    AND application_name = 'vehicle-tracker-ingest'
    AND pid <> pg_backend_pid();
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'tracker database lock observability privilege is required'
      USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION vehicle_access.tracker_worker_database_lock_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vehicle_access.tracker_worker_database_lock_metrics()
  TO vehicle_access_service;
