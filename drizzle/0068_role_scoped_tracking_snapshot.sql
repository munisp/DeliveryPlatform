-- Cursor-watermarked bootstrap for browser SSE clients. The source remains
-- operations.delivery_tracking_delta; no browser is permitted to join or infer
-- cross-tenant tracking state locally.
CREATE OR REPLACE FUNCTION operations.list_role_scoped_delivery_tracking_snapshot(
  p_actor_user_id integer,
  p_scope text,
  p_limit integer DEFAULT 250
) RETURNS TABLE(
  stream_cursor bigint,
  truncated boolean,
  cursor bigint,
  order_id integer,
  observed_at timestamptz,
  latitude numeric,
  longitude numeric,
  accuracy_m numeric,
  eta_seconds integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,operations,commerce,public
AS $$
BEGIN
  IF p_scope NOT IN ('admin','customer','merchant','driver') OR p_limit NOT BETWEEN 1 AND 250 THEN
    RAISE EXCEPTION 'invalid tracking snapshot input' USING ERRCODE='22023';
  END IF;

  IF p_scope='admin' AND NOT EXISTS(
    SELECT 1
    FROM public.users
    WHERE id=p_actor_user_id
      AND role::text IN ('admin','platform_admin','super_admin')
  ) THEN
    RAISE EXCEPTION 'administrator tracking scope denied' USING ERRCODE='42501';
  END IF;

  RETURN QUERY
  WITH authorized AS (
    SELECT d.cursor,d.order_id,d.occurred_at,d.latitude,d.longitude,d.accuracy_m,d.eta_seconds
    FROM operations.delivery_tracking_delta d
    WHERE
      p_scope='admin' OR
      (p_scope='customer' AND d.customer_user_id=p_actor_user_id) OR
      (p_scope='merchant' AND EXISTS(
        SELECT 1
        FROM commerce.merchant_user_access m
        WHERE m.provider_id=d.provider_id
          AND m.user_id=p_actor_user_id
          AND m.active
          AND m.role=ANY(ARRAY['owner','catalog_manager','inventory_manager']::commerce.merchant_access_role[])
      )) OR
      (p_scope='driver' AND EXISTS(
        SELECT 1
        FROM public.drivers dr
        JOIN public.users u ON u.open_id=dr.open_id
        WHERE dr.id=d.driver_id AND u.id=p_actor_user_id
      ))
  ), watermark AS (
    SELECT COALESCE(max(a.cursor),0)::bigint AS stream_cursor
    FROM authorized a
  ), latest AS (
    SELECT DISTINCT ON (a.order_id)
      a.cursor,a.order_id,a.occurred_at,a.latitude,a.longitude,a.accuracy_m,a.eta_seconds
    FROM authorized a
    ORDER BY a.order_id,a.cursor DESC
  ), limited AS (
    SELECT l.*,count(*) OVER() AS total_positions
    FROM latest l
    ORDER BY l.cursor DESC
    LIMIT p_limit
  )
  SELECT
    w.stream_cursor,
    (limited.total_positions > p_limit),
    limited.cursor,
    limited.order_id,
    limited.occurred_at,
    limited.latitude,
    limited.longitude,
    limited.accuracy_m,
    limited.eta_seconds
  FROM limited
  CROSS JOIN watermark w
  ORDER BY limited.cursor DESC;
END;
$$;

REVOKE ALL ON FUNCTION operations.list_role_scoped_delivery_tracking_snapshot(integer,text,integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_gateway_service') THEN
    GRANT EXECUTE ON FUNCTION operations.list_role_scoped_delivery_tracking_snapshot(integer,text,integer)
      TO commerce_gateway_service;
  END IF;
END;
$$;
