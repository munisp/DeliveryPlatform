-- MIT-core Medusa integration boundary. DeliveryPlatform retains its PostgreSQL fulfillment authority.
CREATE SCHEMA IF NOT EXISTS commerce;

CREATE TYPE commerce.medusa_event_state AS ENUM ('received', 'fulfillment_requested', 'ignored');
CREATE TYPE commerce.fulfillment_state AS ENUM ('requested', 'accepted', 'assigned', 'out_for_delivery', 'delivered', 'cancelled', 'failed');

CREATE TABLE commerce.medusa_store_connection (
  provider_id integer PRIMARY KEY REFERENCES public.service_providers(id) ON DELETE RESTRICT,
  medusa_store_id text NOT NULL UNIQUE CHECK (length(medusa_store_id) BETWEEN 3 AND 160 AND medusa_store_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'),
  base_url text NOT NULL CHECK (length(base_url) BETWEEN 9 AND 1908 AND base_url ~ '^https://[^[:space:]]+$'),
  webhook_secret_ref text NOT NULL CHECK (length(webhook_secret_ref) BETWEEN 3 AND 256 AND webhook_secret_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]+$'),
  active boolean NOT NULL DEFAULT true,
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CHECK ((active AND disabled_at IS NULL) OR (NOT active AND disabled_at IS NOT NULL))
);

CREATE TABLE commerce.medusa_event (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  provider_id integer NOT NULL REFERENCES public.service_providers(id) ON DELETE RESTRICT,
  medusa_event_id text NOT NULL CHECK (length(medusa_event_id) BETWEEN 8 AND 160 AND medusa_event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'),
  event_type text NOT NULL CHECK (event_type IN ('commerce.order.placed', 'commerce.order.cancelled', 'commerce.fulfillment.ready', 'commerce.fulfillment.delivered')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  state commerce.medusa_event_state NOT NULL DEFAULT 'received',
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider_id, medusa_event_id)
);
CREATE INDEX commerce_medusa_event_pending_idx ON commerce.medusa_event (received_at) WHERE state = 'received';

CREATE TABLE commerce.fulfillment_request (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  provider_id integer NOT NULL REFERENCES public.service_providers(id) ON DELETE RESTRICT,
  medusa_order_id text NOT NULL CHECK (length(medusa_order_id) BETWEEN 3 AND 160 AND medusa_order_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'),
  source_event_id uuid NOT NULL UNIQUE REFERENCES commerce.medusa_event(id) ON DELETE RESTRICT,
  state commerce.fulfillment_state NOT NULL DEFAULT 'requested',
  delivery_order_id integer REFERENCES public.orders(id) ON DELETE RESTRICT,
  delivery_reference text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  assigned_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  failure_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, medusa_order_id),
  CHECK ((state IN ('accepted','assigned','out_for_delivery','delivered') AND accepted_at IS NOT NULL) OR state IN ('requested','cancelled','failed')),
  CHECK ((state IN ('assigned','out_for_delivery','delivered') AND assigned_at IS NOT NULL) OR state NOT IN ('assigned','out_for_delivery','delivered')),
  CHECK ((state = 'delivered' AND delivered_at IS NOT NULL) OR state <> 'delivered'),
  CHECK ((state = 'cancelled' AND cancelled_at IS NOT NULL) OR state <> 'cancelled'),
  CHECK ((state = 'failed' AND length(failure_reason) BETWEEN 3 AND 1000) OR state <> 'failed')
);
CREATE INDEX commerce_fulfillment_provider_state_idx ON commerce.fulfillment_request (provider_id, state, requested_at DESC);

CREATE TABLE commerce.fulfillment_event (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  fulfillment_request_id uuid NOT NULL REFERENCES commerce.fulfillment_request(id) ON DELETE RESTRICT,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  actor_user_id integer REFERENCES public.users(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.]{2,95}$'),
  previous_state commerce.fulfillment_state,
  next_state commerce.fulfillment_state NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fulfillment_request_id, sequence_no),
  UNIQUE (fulfillment_request_id, idempotency_key)
);

CREATE OR REPLACE FUNCTION commerce.prevent_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, commerce AS $$
BEGIN RAISE EXCEPTION 'commerce fulfillment evidence is append-only' USING ERRCODE = '55000'; END; $$;
CREATE TRIGGER commerce_fulfillment_event_append_only BEFORE UPDATE OR DELETE ON commerce.fulfillment_event FOR EACH ROW EXECUTE FUNCTION commerce.prevent_evidence_mutation();

CREATE OR REPLACE FUNCTION commerce.is_platform_operator(p_user_id integer)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, commerce AS $$
  SELECT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id AND role::text = 'admin');
$$;

CREATE OR REPLACE FUNCTION commerce.upsert_medusa_store_connection(
  p_actor_user_id integer, p_provider_id integer, p_medusa_store_id text, p_base_url text, p_webhook_secret_ref text, p_active boolean, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, commerce AS $$
BEGIN
  IF NOT commerce.is_platform_operator(p_actor_user_id) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  IF p_medusa_store_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$' OR length(p_medusa_store_id) NOT BETWEEN 3 AND 160 OR p_base_url !~ '^https://[^[:space:]]+$' OR length(p_base_url) NOT BETWEEN 9 AND 1908 OR p_webhook_secret_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]+$' OR length(p_webhook_secret_ref) NOT BETWEEN 3 AND 256 THEN RAISE EXCEPTION 'invalid Medusa connection input' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.service_providers WHERE id = p_provider_id AND status::text = 'active') THEN RAISE EXCEPTION 'active provider required' USING ERRCODE = '23514'; END IF;
  INSERT INTO commerce.medusa_store_connection (provider_id,medusa_store_id,base_url,webhook_secret_ref,active,created_by,created_at,disabled_at)
  VALUES (p_provider_id,p_medusa_store_id,p_base_url,p_webhook_secret_ref,p_active,p_actor_user_id,p_now,CASE WHEN p_active THEN NULL ELSE p_now END)
  ON CONFLICT (provider_id) DO UPDATE SET medusa_store_id=EXCLUDED.medusa_store_id,base_url=EXCLUDED.base_url,webhook_secret_ref=EXCLUDED.webhook_secret_ref,active=EXCLUDED.active,disabled_at=EXCLUDED.disabled_at;
  RETURN p_provider_id;
END; $$;

CREATE OR REPLACE FUNCTION commerce.ingest_medusa_event(
  p_provider_id integer, p_medusa_event_id text, p_event_type text, p_payload jsonb, p_payload_sha256 bytea, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, commerce AS $$
DECLARE v_event commerce.medusa_event%ROWTYPE; v_order_id text; v_fulfillment_id uuid;
BEGIN
  IF p_medusa_event_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$' OR length(p_medusa_event_id) NOT BETWEEN 8 AND 160 OR p_event_type NOT IN ('commerce.order.placed','commerce.order.cancelled','commerce.fulfillment.ready','commerce.fulfillment.delivered') OR jsonb_typeof(p_payload) <> 'object' OR octet_length(p_payload_sha256) <> 32 THEN RAISE EXCEPTION 'invalid Medusa event input' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM commerce.medusa_store_connection WHERE provider_id = p_provider_id AND active) THEN RAISE EXCEPTION 'active Medusa store connection required' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_provider_id::text || ':' || p_medusa_event_id, 0));
  SELECT * INTO v_event FROM commerce.medusa_event WHERE provider_id=p_provider_id AND medusa_event_id=p_medusa_event_id FOR UPDATE;
  IF FOUND THEN
    IF v_event.payload_sha256 <> p_payload_sha256 OR v_event.event_type <> p_event_type THEN RAISE EXCEPTION 'Medusa event identifier reused with different payload' USING ERRCODE = '23505'; END IF;
    RETURN v_event.id;
  END IF;
  INSERT INTO commerce.medusa_event(provider_id,medusa_event_id,event_type,payload,payload_sha256,state,received_at) VALUES(p_provider_id,p_medusa_event_id,p_event_type,p_payload,p_payload_sha256,'received'::commerce.medusa_event_state,p_now) RETURNING * INTO v_event;
  v_order_id := COALESCE(p_payload->>'order_id', p_payload#>>'{data,id}');
  IF p_event_type = 'commerce.order.placed' AND v_order_id IS NOT NULL AND v_order_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$' AND length(v_order_id) BETWEEN 3 AND 160 THEN
    INSERT INTO commerce.fulfillment_request(provider_id,medusa_order_id,source_event_id,state,requested_at,updated_at) VALUES(p_provider_id,v_order_id,v_event.id,'requested'::commerce.fulfillment_state,p_now,p_now) ON CONFLICT (provider_id,medusa_order_id) DO NOTHING RETURNING id INTO v_fulfillment_id;
    IF v_fulfillment_id IS NOT NULL THEN INSERT INTO commerce.fulfillment_event(fulfillment_request_id,sequence_no,event_type,next_state,detail,idempotency_key,created_at) VALUES(v_fulfillment_id,1,'commerce.fulfillment.requested','requested'::commerce.fulfillment_state,jsonb_build_object('medusa_event_id',p_medusa_event_id),'medusa-' || p_medusa_event_id,p_now); END IF;
    UPDATE commerce.medusa_event SET state='fulfillment_requested'::commerce.medusa_event_state,processed_at=p_now WHERE id=v_event.id;
  ELSIF p_event_type = 'commerce.order.cancelled' AND v_order_id IS NOT NULL THEN
    UPDATE commerce.fulfillment_request SET state='cancelled'::commerce.fulfillment_state,cancelled_at=p_now,updated_at=p_now WHERE provider_id=p_provider_id AND medusa_order_id=v_order_id AND state IN ('requested'::commerce.fulfillment_state,'accepted'::commerce.fulfillment_state);
    UPDATE commerce.medusa_event SET state='ignored'::commerce.medusa_event_state,processed_at=p_now WHERE id=v_event.id;
  END IF;
  RETURN v_event.id;
END; $$;

CREATE OR REPLACE FUNCTION commerce.transition_fulfillment(
  p_fulfillment_id uuid, p_actor_user_id integer, p_action text, p_detail jsonb, p_idempotency_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS commerce.fulfillment_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, commerce AS $$
DECLARE v_order commerce.fulfillment_request%ROWTYPE; v_next commerce.fulfillment_state; v_sequence integer;
BEGIN
  IF NOT commerce.is_platform_operator(p_actor_user_id) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  IF p_action NOT IN ('accept','assign','dispatch','deliver','cancel','fail') OR jsonb_typeof(p_detail) <> 'object' OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' OR (p_action = 'assign' AND (COALESCE(p_detail->>'delivery_reference','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$')) THEN RAISE EXCEPTION 'invalid fulfillment transition input' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_order FROM commerce.fulfillment_request WHERE id=p_fulfillment_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment request not found' USING ERRCODE='P0002'; END IF;
  IF EXISTS(SELECT 1 FROM commerce.fulfillment_event WHERE fulfillment_request_id=p_fulfillment_id AND idempotency_key=p_idempotency_key) THEN RETURN v_order.state; END IF;
  v_next := CASE WHEN p_action='accept' AND v_order.state='requested' THEN 'accepted'::commerce.fulfillment_state WHEN p_action='assign' AND v_order.state='accepted' THEN 'assigned'::commerce.fulfillment_state WHEN p_action='dispatch' AND v_order.state='assigned' THEN 'out_for_delivery'::commerce.fulfillment_state WHEN p_action='deliver' AND v_order.state='out_for_delivery' THEN 'delivered'::commerce.fulfillment_state WHEN p_action='cancel' AND v_order.state IN ('requested'::commerce.fulfillment_state,'accepted'::commerce.fulfillment_state) THEN 'cancelled'::commerce.fulfillment_state WHEN p_action='fail' AND v_order.state IN ('requested'::commerce.fulfillment_state,'accepted'::commerce.fulfillment_state,'assigned'::commerce.fulfillment_state) THEN 'failed'::commerce.fulfillment_state ELSE NULL END;
  IF v_next IS NULL THEN RAISE EXCEPTION 'invalid fulfillment transition' USING ERRCODE='23514'; END IF;
  UPDATE commerce.fulfillment_request SET state=v_next,accepted_at=CASE WHEN v_next='accepted'::commerce.fulfillment_state THEN p_now ELSE accepted_at END,assigned_at=CASE WHEN v_next='assigned'::commerce.fulfillment_state THEN p_now ELSE assigned_at END,delivery_reference=CASE WHEN v_next='assigned'::commerce.fulfillment_state THEN p_detail->>'delivery_reference' ELSE delivery_reference END,delivered_at=CASE WHEN v_next='delivered'::commerce.fulfillment_state THEN p_now ELSE delivered_at END,cancelled_at=CASE WHEN v_next='cancelled'::commerce.fulfillment_state THEN p_now ELSE cancelled_at END,failure_reason=CASE WHEN v_next='failed'::commerce.fulfillment_state THEN left(COALESCE(p_detail->>'reason',''),1000) ELSE failure_reason END,updated_at=p_now WHERE id=p_fulfillment_id;
  SELECT COALESCE(max(sequence_no),0)+1 INTO v_sequence FROM commerce.fulfillment_event WHERE fulfillment_request_id=p_fulfillment_id;
  INSERT INTO commerce.fulfillment_event(fulfillment_request_id,sequence_no,actor_user_id,event_type,previous_state,next_state,detail,idempotency_key,created_at) VALUES(p_fulfillment_id,v_sequence,p_actor_user_id,'commerce.fulfillment.' || v_next::text,v_order.state,v_next,p_detail,p_idempotency_key,p_now);
  RETURN v_next;
END; $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='commerce_gateway_service') THEN
    GRANT USAGE ON SCHEMA commerce TO commerce_gateway_service;
    GRANT EXECUTE ON FUNCTION commerce.ingest_medusa_event(integer,text,text,jsonb,bytea,timestamp with time zone) TO commerce_gateway_service;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='commerce_operator_service') THEN
    GRANT USAGE ON SCHEMA commerce TO commerce_operator_service;
    GRANT EXECUTE ON FUNCTION commerce.upsert_medusa_store_connection(integer,integer,text,text,text,boolean,timestamp with time zone) TO commerce_operator_service;
    GRANT EXECUTE ON FUNCTION commerce.transition_fulfillment(uuid,integer,text,jsonb,text,timestamp with time zone) TO commerce_operator_service;
  END IF;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA commerce FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA commerce FROM PUBLIC;

CREATE OR REPLACE FUNCTION commerce.ingest_medusa_event_for_store(
  p_medusa_store_id text, p_medusa_event_id text, p_event_type text, p_payload jsonb, p_payload_sha256 bytea, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, commerce AS $$
DECLARE v_provider_id integer;
BEGIN
  SELECT provider_id INTO v_provider_id FROM commerce.medusa_store_connection WHERE medusa_store_id = p_medusa_store_id AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'active Medusa store connection not found' USING ERRCODE = '42501'; END IF;
  RETURN commerce.ingest_medusa_event(v_provider_id, p_medusa_event_id, p_event_type, p_payload, p_payload_sha256, p_now);
END; $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='commerce_gateway_service') THEN
    GRANT EXECUTE ON FUNCTION commerce.ingest_medusa_event_for_store(text,text,text,jsonb,bytea,timestamp with time zone) TO commerce_gateway_service;
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION commerce.ingest_medusa_event_for_store(text,text,text,jsonb,bytea,timestamp with time zone) FROM PUBLIC;

CREATE OR REPLACE FUNCTION commerce.list_fulfillment_requests(p_actor_user_id integer, p_limit integer DEFAULT 50)
RETURNS TABLE (id uuid, provider_id integer, medusa_order_id text, state commerce.fulfillment_state, delivery_order_id integer, delivery_reference text, requested_at timestamptz, updated_at timestamptz, failure_reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, commerce AS $$
BEGIN
  IF NOT commerce.is_platform_operator(p_actor_user_id) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  IF p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid fulfillment list limit' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT request.id, request.provider_id, request.medusa_order_id, request.state, request.delivery_order_id, request.delivery_reference, request.requested_at, request.updated_at, request.failure_reason FROM commerce.fulfillment_request request ORDER BY request.requested_at DESC, request.id DESC LIMIT p_limit;
END; $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='commerce_operator_service') THEN
    GRANT EXECUTE ON FUNCTION commerce.list_fulfillment_requests(integer,integer) TO commerce_operator_service;
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION commerce.list_fulfillment_requests(integer,integer) FROM PUBLIC;
