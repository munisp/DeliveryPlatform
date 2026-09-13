-- Forward-only: publish only a cursor wake-up after the durable, authoritative delta insert.
-- SSE listeners always re-query operations.list_role_scoped_delivery_tracking with their own
-- session-scoped actor and cursor; no position or tenant data is placed in PostgreSQL NOTIFY.

CREATE OR REPLACE FUNCTION operations.append_delivery_tracking_delta()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,operations,public AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_cursor bigint;
BEGIN
  IF NEW.delivery_id !~ '^[0-9]+$' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_order
  FROM public.orders
  WHERE id = NEW.delivery_id::integer;

  IF NOT FOUND OR v_order.driver_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO operations.delivery_tracking_delta(
    order_id, customer_user_id, provider_id, driver_id,
    occurred_at, latitude, longitude, accuracy_m
  ) VALUES (
    v_order.id, v_order.customer_id, v_order.provider_id, v_order.driver_id,
    NEW.occurred_at, NEW.latitude, NEW.longitude, NEW.accuracy_meters
  )
  RETURNING cursor INTO v_cursor;

  -- A static channel and numeric cursor only: listeners fetch authorized data separately.
  PERFORM pg_notify('delivery_tracking_delta', v_cursor::text);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION operations.append_delivery_tracking_delta() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_gateway_service') THEN
    GRANT EXECUTE ON FUNCTION operations.append_delivery_tracking_delta() TO commerce_gateway_service;
  END IF;
END;
$$;
