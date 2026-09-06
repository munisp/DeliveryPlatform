-- Public developer APIs are PostgreSQL-authoritative. Raw API key and webhook
-- signing secrets are never stored in this database.

CREATE SCHEMA IF NOT EXISTS developer;

DO $$ BEGIN
  CREATE TYPE developer.api_client_state AS ENUM ('active', 'suspended', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE developer.webhook_delivery_state AS ENUM ('pending', 'delivered', 'retrying', 'dead_letter');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS developer.api_client (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id integer REFERENCES public.service_providers(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 160),
  owner_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  state developer.api_client_state NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  suspended_at timestamptz,
  revoked_at timestamptz,
  CHECK ((state = 'suspended') = (suspended_at IS NOT NULL)),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS developer_api_client_provider_idx ON developer.api_client (provider_id, state) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS developer.api_key (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_client_id uuid NOT NULL REFERENCES developer.api_client(id) ON DELETE RESTRICT,
  key_prefix text NOT NULL CHECK (key_prefix ~ '^dpk_[a-f0-9]{12}$'),
  secret_digest bytea NOT NULL CHECK (octet_length(secret_digest) = 32),
  scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 8 AND scopes <@ ARRAY['field_service:read', 'field_service:write', 'webhook:manage']::text[]),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (key_prefix),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS developer_api_key_active_idx ON developer.api_key (api_client_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS developer.api_idempotency_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id uuid NOT NULL REFERENCES developer.api_key(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
  response_status smallint CHECK (response_status BETWEEN 200 AND 599),
  response_body jsonb CHECK (response_body IS NULL OR jsonb_typeof(response_body) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  UNIQUE (api_key_id, idempotency_key),
  CHECK ((completed_at IS NULL) = (response_status IS NULL)),
  CHECK ((completed_at IS NULL) = (response_body IS NULL))
);
CREATE INDEX IF NOT EXISTS developer_idempotency_expiry_idx ON developer.api_idempotency_record (expires_at);

CREATE TABLE IF NOT EXISTS developer.webhook_endpoint (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_client_id uuid NOT NULL REFERENCES developer.api_client(id) ON DELETE RESTRICT,
  url text NOT NULL CHECK (length(url) BETWEEN 9 AND 1908 AND url ~ '^https://[^[:space:]]+$'),
  event_types text[] NOT NULL CHECK (cardinality(event_types) BETWEEN 1 AND 24 AND event_types <@ ARRAY['field_service.work_order.created', 'field_service.work_order.scheduled', 'field_service.work_order.assigned', 'field_service.work_order.en_route', 'field_service.work_order.arrived', 'field_service.work_order.completed', 'field_service.work_order.cancelled', 'commerce.order.placed', 'commerce.order.cancelled', 'commerce.fulfillment.ready', 'commerce.fulfillment.delivered']::text[]),
  signing_secret_ref text NOT NULL CHECK (length(signing_secret_ref) BETWEEN 3 AND 256 AND signing_secret_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]+$'),
  active boolean NOT NULL DEFAULT true,
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CHECK ((active AND disabled_at IS NULL) OR (NOT active AND disabled_at IS NOT NULL)),
  UNIQUE (api_client_id, url)
);
CREATE INDEX IF NOT EXISTS developer_webhook_endpoint_dispatch_idx ON developer.webhook_endpoint (api_client_id) WHERE active;

CREATE TABLE IF NOT EXISTS developer.webhook_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_endpoint_id uuid NOT NULL REFERENCES developer.webhook_endpoint(id) ON DELETE RESTRICT,
  event_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.]{2,95}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state developer.webhook_delivery_state NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 16),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_status integer CHECK (last_status BETWEEN 100 AND 599),
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 2048),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (webhook_endpoint_id, event_id)
);
CREATE INDEX IF NOT EXISTS developer_webhook_delivery_dispatch_idx ON developer.webhook_delivery (next_attempt_at) WHERE state IN ('pending', 'retrying');

CREATE OR REPLACE FUNCTION developer.prevent_webhook_delivery_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, developer AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'webhook delivery evidence cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF OLD.event_id <> NEW.event_id OR OLD.webhook_endpoint_id <> NEW.webhook_endpoint_id OR OLD.event_type <> NEW.event_type OR OLD.payload <> NEW.payload OR OLD.created_at <> NEW.created_at THEN
    RAISE EXCEPTION 'webhook delivery request evidence is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS developer_webhook_delivery_immutable ON developer.webhook_delivery;
CREATE TRIGGER developer_webhook_delivery_immutable BEFORE UPDATE OR DELETE ON developer.webhook_delivery
FOR EACH ROW EXECUTE FUNCTION developer.prevent_webhook_delivery_mutation();

CREATE OR REPLACE FUNCTION developer.is_platform_operator(p_user_id integer)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, developer AS $$
  SELECT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id AND role = 'admin');
$$;

CREATE OR REPLACE FUNCTION developer.create_api_client(
  p_actor_user_id integer, p_provider_id integer, p_display_name text, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, developer AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT developer.is_platform_operator(p_actor_user_id) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  IF length(p_display_name) NOT BETWEEN 2 AND 160 OR NOT EXISTS (SELECT 1 FROM public.service_providers WHERE id = p_provider_id AND status = 'active') THEN RAISE EXCEPTION 'invalid API client input' USING ERRCODE = '22023'; END IF;
  INSERT INTO developer.api_client (provider_id, display_name, owner_user_id, created_at) VALUES (p_provider_id, p_display_name, p_actor_user_id, p_now) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION developer.create_api_key(
  p_actor_user_id integer, p_api_client_id uuid, p_key_prefix text, p_secret_digest bytea, p_scopes text[], p_expires_at timestamptz DEFAULT NULL, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, developer AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT developer.is_platform_operator(p_actor_user_id) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  IF p_key_prefix !~ '^dpk_[a-f0-9]{12}$' OR octet_length(p_secret_digest) <> 32 OR cardinality(p_scopes) NOT BETWEEN 1 AND 8 OR NOT p_scopes <@ ARRAY['field_service:read', 'field_service:write', 'webhook:manage']::text[] OR (p_expires_at IS NOT NULL AND p_expires_at <= p_now) THEN RAISE EXCEPTION 'invalid API key input' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM developer.api_client WHERE id = p_api_client_id AND state = 'active') THEN RAISE EXCEPTION 'API client is not active' USING ERRCODE = '23514'; END IF;
  INSERT INTO developer.api_key (api_client_id, key_prefix, secret_digest, scopes, created_by, expires_at, created_at) VALUES (p_api_client_id, p_key_prefix, p_secret_digest, p_scopes, p_actor_user_id, p_expires_at, p_now) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION developer.revoke_api_key(
  p_actor_user_id integer, p_api_key_id uuid, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, developer AS $$
BEGIN
  IF NOT developer.is_platform_operator(p_actor_user_id) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  UPDATE developer.api_key SET revoked_at = COALESCE(revoked_at, p_now) WHERE id = p_api_key_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'API key not found' USING ERRCODE = 'P0002'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION developer.authenticate_api_key(
  p_key_prefix text, p_secret_digest bytea, p_required_scope text, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (api_key_id uuid, api_client_id uuid, provider_id integer, owner_user_id integer, scopes text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, developer AS $$
DECLARE v_key developer.api_key%ROWTYPE; v_client developer.api_client%ROWTYPE;
BEGIN
  IF p_key_prefix !~ '^dpk_[a-f0-9]{12}$' OR octet_length(p_secret_digest) <> 32 OR p_required_scope NOT IN ('field_service:read','field_service:write','webhook:manage') THEN RAISE EXCEPTION 'invalid API authentication input' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_key FROM developer.api_key WHERE key_prefix = p_key_prefix FOR UPDATE;
  IF NOT FOUND OR v_key.revoked_at IS NOT NULL OR (v_key.expires_at IS NOT NULL AND v_key.expires_at <= p_now) OR NOT public.digest(v_key.secret_digest, 'sha256') = public.digest(p_secret_digest, 'sha256') THEN RAISE EXCEPTION 'API key authentication failed' USING ERRCODE = '28000'; END IF;
  IF NOT p_required_scope = ANY(v_key.scopes) THEN RAISE EXCEPTION 'API key scope denied' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_client FROM developer.api_client WHERE id = v_key.api_client_id;
  IF NOT FOUND OR v_client.state <> 'active' THEN RAISE EXCEPTION 'API client is inactive' USING ERRCODE = '28000'; END IF;
  UPDATE developer.api_key SET last_used_at = p_now WHERE id = v_key.id;
  RETURN QUERY SELECT v_key.id, v_client.id, v_client.provider_id, v_client.owner_user_id, v_key.scopes;
END;
$$;

CREATE OR REPLACE FUNCTION developer.begin_idempotent_request(
  p_api_key_id uuid, p_idempotency_key text, p_request_digest bytea, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (is_replay boolean, response_status smallint, response_body jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, developer AS $$
DECLARE v_record developer.api_idempotency_record%ROWTYPE;
BEGIN
  IF p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' OR octet_length(p_request_digest) <> 32 THEN RAISE EXCEPTION 'invalid idempotency input' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_record FROM developer.api_idempotency_record WHERE api_key_id = p_api_key_id AND idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_record.request_digest <> p_request_digest THEN RAISE EXCEPTION 'idempotency key was reused with a different request' USING ERRCODE = '23505'; END IF;
    IF v_record.completed_at IS NULL THEN RAISE EXCEPTION 'idempotent request is in progress' USING ERRCODE = '55P03'; END IF;
    RETURN QUERY SELECT true, v_record.response_status, v_record.response_body;
    RETURN;
  END IF;
  INSERT INTO developer.api_idempotency_record (api_key_id, idempotency_key, request_digest, created_at, expires_at)
  VALUES (p_api_key_id, p_idempotency_key, p_request_digest, p_now, p_now + interval '24 hours');
  RETURN QUERY SELECT false, NULL::smallint, NULL::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION developer.complete_idempotent_request(
  p_api_key_id uuid, p_idempotency_key text, p_response_status smallint, p_response_body jsonb, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, developer AS $$
BEGIN
  IF p_response_status NOT BETWEEN 200 AND 599 OR jsonb_typeof(p_response_body) <> 'object' THEN RAISE EXCEPTION 'invalid idempotent response' USING ERRCODE = '22023'; END IF;
  UPDATE developer.api_idempotency_record SET response_status = p_response_status, response_body = p_response_body, completed_at = p_now
  WHERE api_key_id = p_api_key_id AND idempotency_key = p_idempotency_key AND completed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'idempotency record is not pending' USING ERRCODE = 'P0002'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION developer.create_webhook_endpoint(
  p_actor_user_id integer, p_api_client_id uuid, p_url text, p_event_types text[], p_signing_secret_ref text, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, developer AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT developer.is_platform_operator(p_actor_user_id) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  IF length(p_url) NOT BETWEEN 9 AND 1908 OR p_url !~ '^https://[^[:space:]]+$' OR cardinality(p_event_types) NOT BETWEEN 1 AND 24 OR NOT p_event_types <@ ARRAY['field_service.work_order.created', 'field_service.work_order.scheduled', 'field_service.work_order.assigned', 'field_service.work_order.en_route', 'field_service.work_order.arrived', 'field_service.work_order.completed', 'field_service.work_order.cancelled', 'commerce.order.placed', 'commerce.order.cancelled', 'commerce.fulfillment.ready', 'commerce.fulfillment.delivered']::text[] OR length(p_signing_secret_ref) NOT BETWEEN 3 AND 256 OR p_signing_secret_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]+$' THEN RAISE EXCEPTION 'invalid webhook endpoint input' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM developer.api_client WHERE id = p_api_client_id AND state = 'active') THEN RAISE EXCEPTION 'API client is not active' USING ERRCODE = '23514'; END IF;
  INSERT INTO developer.webhook_endpoint (api_client_id, url, event_types, signing_secret_ref, created_by, created_at) VALUES (p_api_client_id, p_url, p_event_types, p_signing_secret_ref, p_actor_user_id, p_now) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION developer.public_field_service_work_order(
  p_api_client_id uuid, p_work_order_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, developer AS $$
DECLARE v_provider_id integer; v_work field_service.work_order%ROWTYPE;
BEGIN
  SELECT provider_id INTO v_provider_id FROM developer.api_client WHERE id = p_api_client_id AND state = 'active';
  SELECT * INTO v_work FROM field_service.work_order WHERE id = p_work_order_id;
  IF v_provider_id IS NULL OR NOT FOUND OR v_work.provider_id IS DISTINCT FROM v_provider_id THEN RAISE EXCEPTION 'work order not found' USING ERRCODE = 'P0002'; END IF;
  RETURN jsonb_build_object('id', v_work.id, 'reference', v_work.public_reference, 'state', v_work.state, 'priority', v_work.priority, 'scheduled_start_at', v_work.scheduled_start_at, 'scheduled_end_at', v_work.scheduled_end_at, 'updated_at', v_work.updated_at);
END;
$$;

REVOKE ALL ON SCHEMA developer FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA developer FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA developer FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'developer_api_service') THEN
    GRANT USAGE ON SCHEMA developer, field_service TO developer_api_service;
    GRANT EXECUTE ON FUNCTION developer.authenticate_api_key(text,bytea,text,timestamp with time zone) TO developer_api_service;
    GRANT EXECUTE ON FUNCTION developer.begin_idempotent_request(uuid,text,bytea,timestamp with time zone) TO developer_api_service;
    GRANT EXECUTE ON FUNCTION developer.complete_idempotent_request(uuid,text,smallint,jsonb,timestamp with time zone) TO developer_api_service;
    GRANT EXECUTE ON FUNCTION developer.public_field_service_work_order(uuid,uuid) TO developer_api_service;
    GRANT EXECUTE ON FUNCTION field_service.create_work_order(integer,integer,uuid,text,text,text,numeric,numeric,field_service.work_order_priority,timestamp with time zone,timestamp with time zone,integer,integer,text,timestamp with time zone) TO developer_api_service;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'developer_api_management') THEN
    GRANT USAGE ON SCHEMA developer TO developer_api_management;
    GRANT EXECUTE ON FUNCTION developer.create_api_client(integer,integer,text,timestamp with time zone) TO developer_api_management;
    GRANT EXECUTE ON FUNCTION developer.create_api_key(integer,uuid,text,bytea,text[],timestamp with time zone,timestamp with time zone) TO developer_api_management;
    GRANT EXECUTE ON FUNCTION developer.revoke_api_key(integer,uuid,timestamp with time zone) TO developer_api_management;
    GRANT EXECUTE ON FUNCTION developer.create_webhook_endpoint(integer,uuid,text,text[],text,timestamp with time zone) TO developer_api_management;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION developer.enqueue_webhook_deliveries(
  p_provider_id integer, p_event_id uuid, p_event_type text, p_payload jsonb, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, developer AS $$
DECLARE v_inserted integer;
BEGIN
  IF p_event_type !~ '^[a-z][a-z0-9_.]{2,95}$' OR jsonb_typeof(p_payload) <> 'object' THEN RAISE EXCEPTION 'invalid webhook event' USING ERRCODE = '22023'; END IF;
  INSERT INTO developer.webhook_delivery (webhook_endpoint_id, event_id, event_type, payload, state, next_attempt_at, created_at)
  SELECT endpoint.id, p_event_id, p_event_type, p_payload, 'pending'::developer.webhook_delivery_state, p_now, p_now
  FROM developer.webhook_endpoint endpoint
  JOIN developer.api_client client ON client.id = endpoint.api_client_id
  WHERE endpoint.active AND client.state = 'active' AND client.provider_id = p_provider_id AND p_event_type = ANY(endpoint.event_types)
  ON CONFLICT (webhook_endpoint_id, event_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION developer.claim_webhook_deliveries(p_limit integer, p_now timestamptz DEFAULT clock_timestamp())
RETURNS TABLE (delivery_id uuid, endpoint_url text, signing_secret_ref text, event_id uuid, event_type text, payload jsonb, attempt_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, developer AS $$
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid webhook claim limit' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT delivery.id
    FROM developer.webhook_delivery delivery
    WHERE delivery.state IN ('pending'::developer.webhook_delivery_state, 'retrying'::developer.webhook_delivery_state)
      AND delivery.next_attempt_at <= p_now
      AND delivery.attempt_count < 16
    ORDER BY delivery.next_attempt_at, delivery.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE developer.webhook_delivery delivery
    SET state = 'retrying'::developer.webhook_delivery_state, attempt_count = delivery.attempt_count + 1, last_error = NULL
    FROM candidates
    WHERE delivery.id = candidates.id
    RETURNING delivery.*
  )
  SELECT claimed.id, endpoint.url, endpoint.signing_secret_ref, claimed.event_id, claimed.event_type, claimed.payload, claimed.attempt_count
  FROM claimed JOIN developer.webhook_endpoint endpoint ON endpoint.id = claimed.webhook_endpoint_id;
END;
$$;

CREATE OR REPLACE FUNCTION developer.complete_webhook_delivery(
  p_delivery_id uuid, p_succeeded boolean, p_status integer, p_error text DEFAULT NULL, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS developer.webhook_delivery_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, developer AS $$
DECLARE v_delivery developer.webhook_delivery%ROWTYPE; v_state developer.webhook_delivery_state;
BEGIN
  SELECT * INTO v_delivery FROM developer.webhook_delivery WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'webhook delivery not found' USING ERRCODE = 'P0002'; END IF;
  IF v_delivery.state NOT IN ('retrying'::developer.webhook_delivery_state, 'pending'::developer.webhook_delivery_state) THEN RETURN v_delivery.state; END IF;
  IF p_succeeded THEN
    UPDATE developer.webhook_delivery SET state = 'delivered'::developer.webhook_delivery_state, delivered_at = p_now, last_status = p_status, last_error = NULL WHERE id = p_delivery_id;
    RETURN 'delivered'::developer.webhook_delivery_state;
  END IF;
  v_state := CASE WHEN v_delivery.attempt_count >= 16 THEN 'dead_letter'::developer.webhook_delivery_state ELSE 'retrying'::developer.webhook_delivery_state END;
  UPDATE developer.webhook_delivery
  SET state = v_state,
      last_status = p_status,
      last_error = left(COALESCE(p_error, 'delivery_failed'), 2048),
      next_attempt_at = CASE WHEN v_state = 'dead_letter'::developer.webhook_delivery_state THEN next_attempt_at ELSE p_now + make_interval(secs => LEAST(3600, 2 ^ LEAST(v_delivery.attempt_count, 11))) END
  WHERE id = p_delivery_id;
  RETURN v_state;
END;
$$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'developer_api_service') THEN
    GRANT EXECUTE ON FUNCTION developer.enqueue_webhook_deliveries(integer,uuid,text,jsonb,timestamp with time zone) TO developer_api_service;
    GRANT EXECUTE ON FUNCTION developer.claim_webhook_deliveries(integer,timestamp with time zone) TO developer_api_service;
    GRANT EXECUTE ON FUNCTION developer.complete_webhook_delivery(uuid,boolean,integer,text,timestamp with time zone) TO developer_api_service;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION developer.publish_field_service_outbox(p_limit integer, p_now timestamptz DEFAULT clock_timestamp())
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, developer AS $$
DECLARE v_event field_service.outbox_event%ROWTYPE; v_published integer := 0;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid field-service outbox publish limit' USING ERRCODE = '22023'; END IF;
  FOR v_event IN
    SELECT * FROM field_service.outbox_event
    WHERE published_at IS NULL
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  LOOP
    PERFORM developer.enqueue_webhook_deliveries(
      (v_event.payload ->> 'provider_id')::integer,
      v_event.id,
      v_event.event_type,
      jsonb_build_object(
        'event_id', v_event.id,
        'event_type', v_event.event_type,
        'occurred_at', v_event.created_at,
        'data', jsonb_build_object(
          'work_order_id', v_event.payload ->> 'work_order_id',
          'public_reference', v_event.payload ->> 'public_reference',
          'state', v_event.payload ->> 'state',
          'updated_at', v_event.payload ->> 'updated_at'
        )
      ),
      p_now
    );
    UPDATE field_service.outbox_event SET published_at = p_now, attempts = attempts + 1, last_error = NULL WHERE id = v_event.id;
    v_published := v_published + 1;
  END LOOP;
  RETURN v_published;
END;
$$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'developer_api_service') THEN
    GRANT EXECUTE ON FUNCTION developer.publish_field_service_outbox(integer,timestamp with time zone) TO developer_api_service;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION developer.list_api_clients(p_actor_user_id integer)
RETURNS TABLE (id uuid, provider_id integer, display_name text, state developer.api_client_state, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, developer AS $$
BEGIN
  IF NOT developer.is_platform_operator(p_actor_user_id) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT client.id, client.provider_id, client.display_name, client.state, client.created_at FROM developer.api_client client ORDER BY client.created_at DESC, client.id DESC;
END;
$$;

CREATE OR REPLACE FUNCTION developer.list_api_keys(p_actor_user_id integer, p_api_client_id uuid)
RETURNS TABLE (id uuid, key_prefix text, scopes text[], created_at timestamptz, expires_at timestamptz, revoked_at timestamptz, last_used_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, developer AS $$
BEGIN
  IF NOT developer.is_platform_operator(p_actor_user_id) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT key.id, key.key_prefix, key.scopes, key.created_at, key.expires_at, key.revoked_at, key.last_used_at FROM developer.api_key key WHERE key.api_client_id = p_api_client_id ORDER BY key.created_at DESC, key.id DESC;
END;
$$;

CREATE OR REPLACE FUNCTION developer.list_webhook_endpoints(p_actor_user_id integer, p_api_client_id uuid)
RETURNS TABLE (id uuid, url text, event_types text[], signing_secret_ref text, active boolean, created_at timestamptz, disabled_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, developer AS $$
BEGIN
  IF NOT developer.is_platform_operator(p_actor_user_id) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT endpoint.id, endpoint.url, endpoint.event_types, endpoint.signing_secret_ref, endpoint.active, endpoint.created_at, endpoint.disabled_at FROM developer.webhook_endpoint endpoint WHERE endpoint.api_client_id = p_api_client_id ORDER BY endpoint.created_at DESC, endpoint.id DESC;
END;
$$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'developer_api_management') THEN
    GRANT EXECUTE ON FUNCTION developer.list_api_clients(integer) TO developer_api_management;
    GRANT EXECUTE ON FUNCTION developer.list_api_keys(integer,uuid) TO developer_api_management;
    GRANT EXECUTE ON FUNCTION developer.list_webhook_endpoints(integer,uuid) TO developer_api_management;
  END IF;
END $$;
