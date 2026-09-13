-- PostgreSQL-authoritative foundation for role-scoped delivery tracking,
-- offline client synchronization, and tenant-isolated merchant API credentials.
CREATE SCHEMA IF NOT EXISTS commerce;
CREATE SCHEMA IF NOT EXISTS operations;

CREATE TABLE IF NOT EXISTS commerce.merchant_api_credential (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  provider_id integer NOT NULL REFERENCES commerce.merchant_portal(provider_id) ON DELETE RESTRICT,
  key_id text NOT NULL UNIQUE CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  secret_sha256 bytea NOT NULL CHECK (octet_length(secret_sha256)=32),
  scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 8 AND scopes <@ ARRAY['catalog:write','inventory:write','fulfillment:read','tracking:read']::text[]),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked','expired')),
  created_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK ((state='active' AND revoked_at IS NULL) OR (state<>'active' AND revoked_at IS NOT NULL OR state='expired'))
);
CREATE INDEX IF NOT EXISTS merchant_api_credential_provider_active_idx
  ON commerce.merchant_api_credential(provider_id, expires_at) WHERE state='active';

CREATE TABLE IF NOT EXISTS commerce.offline_sync_action (
  id uuid PRIMARY KEY,
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  provider_id integer REFERENCES commerce.merchant_portal(provider_id) ON DELETE RESTRICT,
  lane text NOT NULL CHECK (lane IN ('merchant_catalog','merchant_inventory','driver_delivery')),
  action_type text NOT NULL CHECK (action_type IN ('catalog.create','inventory.set_level','delivery.location','delivery.proof')),
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256)=32),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  outcome text NOT NULL DEFAULT 'received' CHECK (outcome IN ('received','accepted','rejected','conflict')),
  receipt jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(receipt)='object'),
  UNIQUE(actor_user_id,id),
  CHECK ((lane='merchant_catalog' AND action_type='catalog.create') OR (lane='merchant_inventory' AND action_type='inventory.set_level') OR (lane='driver_delivery' AND action_type IN ('delivery.location','delivery.proof')))
);
CREATE INDEX IF NOT EXISTS offline_sync_action_actor_received_idx ON commerce.offline_sync_action(actor_user_id, received_at DESC);

CREATE TABLE IF NOT EXISTS operations.delivery_tracking_delta (
  cursor bigserial PRIMARY KEY,
  order_id integer NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  customer_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  provider_id integer REFERENCES public.service_providers(id) ON DELETE RESTRICT,
  driver_id integer REFERENCES public.drivers(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  latitude numeric(9,6) NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude numeric(9,6) NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  accuracy_m numeric(8,2),
  eta_seconds integer CHECK(eta_seconds IS NULL OR eta_seconds BETWEEN 0 AND 172800),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS delivery_tracking_delta_customer_cursor_idx ON operations.delivery_tracking_delta(customer_user_id,cursor DESC);
CREATE INDEX IF NOT EXISTS delivery_tracking_delta_provider_cursor_idx ON operations.delivery_tracking_delta(provider_id,cursor DESC);
CREATE INDEX IF NOT EXISTS delivery_tracking_delta_driver_cursor_idx ON operations.delivery_tracking_delta(driver_id,cursor DESC);

CREATE OR REPLACE FUNCTION operations.append_delivery_tracking_delta()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,operations,public AS $$
DECLARE v_order public.orders%ROWTYPE;
BEGIN
  IF NEW.delivery_id !~ '^[0-9]+$' THEN RETURN NEW; END IF;
  SELECT * INTO v_order FROM public.orders WHERE id=NEW.delivery_id::integer;
  IF NOT FOUND OR v_order.driver_id IS NULL THEN RETURN NEW; END IF;
  INSERT INTO operations.delivery_tracking_delta(order_id,customer_user_id,provider_id,driver_id,occurred_at,latitude,longitude,accuracy_m)
  VALUES(v_order.id,v_order.customer_id,v_order.provider_id,v_order.driver_id,NEW.occurred_at,NEW.latitude,NEW.longitude,NEW.accuracy_meters);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS delivery_tracking_delta_append ON public.delivery_tracking_events;
CREATE TRIGGER delivery_tracking_delta_append AFTER INSERT ON public.delivery_tracking_events
FOR EACH ROW EXECUTE FUNCTION operations.append_delivery_tracking_delta();

CREATE OR REPLACE FUNCTION operations.list_role_scoped_delivery_tracking(
  p_actor_user_id integer,p_scope text,p_cursor bigint DEFAULT 0,p_limit integer DEFAULT 100
) RETURNS TABLE(cursor bigint,order_id integer,observed_at timestamptz,latitude numeric,longitude numeric,accuracy_m numeric,eta_seconds integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,operations,commerce,public AS $$
BEGIN
  IF p_scope NOT IN ('admin','customer','merchant','driver') OR p_cursor<0 OR p_limit NOT BETWEEN 1 AND 250 THEN RAISE EXCEPTION 'invalid tracking sync input' USING ERRCODE='22023'; END IF;
  IF p_scope='admin' AND NOT EXISTS(SELECT 1 FROM public.users WHERE id=p_actor_user_id AND role::text IN ('admin','platform_admin','super_admin')) THEN RAISE EXCEPTION 'administrator tracking scope denied' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT d.cursor,d.order_id,d.occurred_at,d.latitude,d.longitude,d.accuracy_m,d.eta_seconds
  FROM operations.delivery_tracking_delta d
  WHERE d.cursor>p_cursor AND (
    p_scope='admin' OR
    (p_scope='customer' AND d.customer_user_id=p_actor_user_id) OR
    (p_scope='merchant' AND EXISTS(SELECT 1 FROM commerce.merchant_user_access m WHERE m.provider_id=d.provider_id AND m.user_id=p_actor_user_id AND m.active AND m.role=ANY(ARRAY['owner','catalog_manager','inventory_manager']::commerce.merchant_access_role[]))) OR
    (p_scope='driver' AND EXISTS(SELECT 1 FROM public.drivers dr JOIN public.users u ON u.open_id=dr.open_id WHERE dr.id=d.driver_id AND u.id=p_actor_user_id))
  ) ORDER BY d.cursor ASC LIMIT p_limit;
END $$;

REVOKE ALL ON TABLE commerce.merchant_api_credential,commerce.offline_sync_action,operations.delivery_tracking_delta FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.append_delivery_tracking_delta(),operations.list_role_scoped_delivery_tracking(integer,text,bigint,integer) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_gateway_service') THEN
    GRANT EXECUTE ON FUNCTION operations.list_role_scoped_delivery_tracking(integer,text,bigint,integer) TO commerce_gateway_service;
  END IF;
END $$;
