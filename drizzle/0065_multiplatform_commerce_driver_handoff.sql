-- Cross-platform commerce is a projection boundary. PostgreSQL remains authoritative
-- for merchant eligibility, fulfillment state, delivery-order binding, and evidence.
-- External systems can submit signed events and receive webhook projections, but cannot
-- directly mutate orders, drivers, inventory reservations, money, or safety state.

CREATE TABLE IF NOT EXISTS commerce.external_platform_connection (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  provider_id integer NOT NULL REFERENCES public.service_providers(id) ON DELETE RESTRICT,
  connection_key text NOT NULL UNIQUE CHECK (connection_key ~ '^[a-z][a-z0-9-]{2,63}$'),
  platform_name text NOT NULL CHECK (length(platform_name) BETWEEN 3 AND 120),
  inbound_enabled boolean NOT NULL DEFAULT true,
  outbound_enabled boolean NOT NULL DEFAULT true,
  inbound_signing_secret_ref text NOT NULL CHECK (inbound_signing_secret_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','suspended','revoked')),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'active') = (inbound_enabled OR outbound_enabled))
);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_external_platform_connection_provider_name_idx
  ON commerce.external_platform_connection (provider_id, lower(platform_name));

CREATE TABLE IF NOT EXISTS commerce.external_platform_event (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES commerce.external_platform_connection(id) ON DELETE RESTRICT,
  external_event_id text NOT NULL CHECK (external_event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$'),
  event_type text NOT NULL CHECK (event_type IN ('commerce.order.placed','commerce.order.cancelled','commerce.fulfillment.ready')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (connection_id, external_event_id)
);
CREATE TRIGGER commerce_external_platform_event_append_only
  BEFORE UPDATE OR DELETE ON commerce.external_platform_event
  FOR EACH ROW EXECUTE FUNCTION commerce.prevent_evidence_mutation();

ALTER TABLE commerce.fulfillment_request
  ALTER COLUMN source_event_id DROP NOT NULL;
ALTER TABLE commerce.fulfillment_request
  ADD COLUMN IF NOT EXISTS external_source_event_id uuid REFERENCES commerce.external_platform_event(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS assigned_driver_id integer REFERENCES public.drivers(id) ON DELETE RESTRICT;
ALTER TABLE commerce.fulfillment_request
  DROP CONSTRAINT IF EXISTS commerce_fulfillment_exactly_one_source_check;
ALTER TABLE commerce.fulfillment_request
  ADD CONSTRAINT commerce_fulfillment_exactly_one_source_check
  CHECK (num_nonnulls(source_event_id, external_source_event_id) = 1);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_fulfillment_external_source_idx
  ON commerce.fulfillment_request(external_source_event_id) WHERE external_source_event_id IS NOT NULL;

CREATE OR REPLACE FUNCTION commerce.register_external_platform_connection(
  p_actor_user_id integer,
  p_provider_id integer,
  p_connection_key text,
  p_platform_name text,
  p_inbound_enabled boolean,
  p_outbound_enabled boolean,
  p_inbound_signing_secret_ref text,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, commerce AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT commerce.is_platform_operator(p_actor_user_id) THEN
    RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501';
  END IF;
  IF p_connection_key !~ '^[a-z][a-z0-9-]{2,63}$'
     OR length(p_platform_name) NOT BETWEEN 3 AND 120
     OR p_inbound_signing_secret_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$'
     OR NOT (p_inbound_enabled OR p_outbound_enabled) THEN
    RAISE EXCEPTION 'invalid external platform connection input' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.service_providers WHERE id = p_provider_id AND status::text = 'active') THEN
    RAISE EXCEPTION 'active provider required' USING ERRCODE = '23514';
  END IF;
  INSERT INTO commerce.external_platform_connection(
    provider_id,connection_key,platform_name,inbound_enabled,outbound_enabled,inbound_signing_secret_ref,state,created_by,created_at,changed_at
  ) VALUES (
    p_provider_id,p_connection_key,p_platform_name,p_inbound_enabled,p_outbound_enabled,p_inbound_signing_secret_ref,'active',p_actor_user_id,p_now,p_now
  ) ON CONFLICT (connection_key) DO UPDATE
    SET platform_name=EXCLUDED.platform_name,
        inbound_enabled=EXCLUDED.inbound_enabled,
        outbound_enabled=EXCLUDED.outbound_enabled,
        inbound_signing_secret_ref=EXCLUDED.inbound_signing_secret_ref,
        state='active', changed_at=EXCLUDED.changed_at
    WHERE commerce.external_platform_connection.provider_id=EXCLUDED.provider_id
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'external platform connection key belongs to another provider' USING ERRCODE='23505';
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION commerce.ingest_external_platform_event(
  p_connection_key text,
  p_external_event_id text,
  p_event_type text,
  p_payload jsonb,
  p_payload_sha256 bytea,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, commerce AS $$
DECLARE v_connection commerce.external_platform_connection%ROWTYPE;
DECLARE v_event commerce.external_platform_event%ROWTYPE;
DECLARE v_order_id text;
DECLARE v_fulfillment_id uuid;
BEGIN
  IF p_connection_key !~ '^[a-z][a-z0-9-]{2,63}$'
     OR p_external_event_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$'
     OR p_event_type NOT IN ('commerce.order.placed','commerce.order.cancelled','commerce.fulfillment.ready')
     OR jsonb_typeof(p_payload) <> 'object' OR octet_length(p_payload_sha256) <> 32 THEN
    RAISE EXCEPTION 'invalid external platform event input' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_connection FROM commerce.external_platform_connection
    WHERE connection_key=p_connection_key AND state='active' AND inbound_enabled FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active inbound platform connection not found' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_connection.id::text || ':' || p_external_event_id, 0));
  SELECT * INTO v_event FROM commerce.external_platform_event
    WHERE connection_id=v_connection.id AND external_event_id=p_external_event_id FOR UPDATE;
  IF FOUND THEN
    IF v_event.payload_sha256 <> p_payload_sha256 OR v_event.event_type <> p_event_type THEN
      RAISE EXCEPTION 'external event identifier reused with different payload' USING ERRCODE='23505';
    END IF;
    RETURN v_event.id;
  END IF;
  INSERT INTO commerce.external_platform_event(connection_id,external_event_id,event_type,payload,payload_sha256,received_at)
    VALUES(v_connection.id,p_external_event_id,p_event_type,p_payload,p_payload_sha256,p_now) RETURNING * INTO v_event;
  v_order_id := COALESCE(p_payload->>'order_id', p_payload#>>'{data,id}');
  IF v_order_id IS NULL OR v_order_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$' OR length(v_order_id) NOT BETWEEN 3 AND 160 THEN
    RAISE EXCEPTION 'external commerce event requires bounded order_id' USING ERRCODE='22023';
  END IF;
  IF p_event_type='commerce.order.placed' THEN
    INSERT INTO commerce.fulfillment_request(provider_id,medusa_order_id,external_source_event_id,state,requested_at,updated_at)
      VALUES(v_connection.provider_id,v_order_id,v_event.id,'requested'::commerce.fulfillment_state,p_now,p_now)
      ON CONFLICT (provider_id,medusa_order_id) DO NOTHING RETURNING id INTO v_fulfillment_id;
    IF v_fulfillment_id IS NOT NULL THEN
      INSERT INTO commerce.fulfillment_event(fulfillment_request_id,sequence_no,event_type,next_state,detail,idempotency_key,created_at)
        VALUES(v_fulfillment_id,1,'commerce.fulfillment.requested','requested'::commerce.fulfillment_state,
          jsonb_build_object('connection_key',p_connection_key,'external_event_id',p_external_event_id),
          'platform-' || p_external_event_id,p_now);
    END IF;
  ELSIF p_event_type='commerce.order.cancelled' THEN
    UPDATE commerce.fulfillment_request SET state='cancelled'::commerce.fulfillment_state,cancelled_at=p_now,updated_at=p_now
      WHERE provider_id=v_connection.provider_id AND medusa_order_id=v_order_id
      AND state IN ('requested'::commerce.fulfillment_state,'accepted'::commerce.fulfillment_state);
  END IF;
  UPDATE commerce.external_platform_event SET processed_at=p_now WHERE id=v_event.id;
  RETURN v_event.id;
END;
$$;

CREATE OR REPLACE FUNCTION commerce.assign_fulfillment_delivery_driver(
  p_fulfillment_id uuid,
  p_actor_user_id integer,
  p_delivery_order_id integer,
  p_driver_id integer,
  p_idempotency_key text,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS commerce.fulfillment_state
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, commerce, developer AS $$
DECLARE v_fulfillment commerce.fulfillment_request%ROWTYPE;
DECLARE v_order public.orders%ROWTYPE;
DECLARE v_driver public.drivers%ROWTYPE;
DECLARE v_sequence integer;
DECLARE v_event_id uuid;
BEGIN
  IF NOT commerce.is_platform_operator(p_actor_user_id) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE='42501'; END IF;
  IF p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid idempotency key' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_fulfillment FROM commerce.fulfillment_request WHERE id=p_fulfillment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment request not found' USING ERRCODE='P0002'; END IF;
  IF EXISTS(SELECT 1 FROM commerce.fulfillment_event WHERE fulfillment_request_id=p_fulfillment_id AND idempotency_key=p_idempotency_key) THEN RETURN v_fulfillment.state; END IF;
  IF v_fulfillment.state <> 'accepted'::commerce.fulfillment_state THEN RAISE EXCEPTION 'fulfillment must be accepted before driver assignment' USING ERRCODE='23514'; END IF;
  SELECT * INTO v_order FROM public.orders WHERE id=p_delivery_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.provider_id IS DISTINCT FROM v_fulfillment.provider_id THEN RAISE EXCEPTION 'provider-matching delivery order required' USING ERRCODE='23514'; END IF;
  SELECT * INTO v_driver FROM public.drivers WHERE id=p_driver_id FOR UPDATE;
  IF NOT FOUND OR v_driver.status::text NOT IN ('online','busy') THEN RAISE EXCEPTION 'eligible online driver required' USING ERRCODE='23514'; END IF;
  IF v_order.driver_id IS NOT NULL AND v_order.driver_id <> p_driver_id THEN RAISE EXCEPTION 'delivery order already assigned to another driver' USING ERRCODE='55000'; END IF;
  UPDATE public.orders SET driver_id=p_driver_id,status='assigned'::public.order_status,updated_at=p_now WHERE id=p_delivery_order_id;
  UPDATE commerce.fulfillment_request SET state='assigned'::commerce.fulfillment_state,delivery_order_id=p_delivery_order_id,assigned_driver_id=p_driver_id,assigned_at=p_now,updated_at=p_now WHERE id=p_fulfillment_id;
  SELECT COALESCE(max(sequence_no),0)+1 INTO v_sequence FROM commerce.fulfillment_event WHERE fulfillment_request_id=p_fulfillment_id;
  INSERT INTO commerce.fulfillment_event(fulfillment_request_id,sequence_no,actor_user_id,event_type,previous_state,next_state,detail,idempotency_key,created_at)
    VALUES(p_fulfillment_id,v_sequence,p_actor_user_id,'commerce.fulfillment.driver_assigned',v_fulfillment.state,'assigned'::commerce.fulfillment_state,
      jsonb_build_object('delivery_order_id',p_delivery_order_id,'driver_id',p_driver_id),p_idempotency_key,p_now) RETURNING id INTO v_event_id;
  IF EXISTS (SELECT 1 FROM commerce.external_platform_connection WHERE provider_id=v_fulfillment.provider_id AND state='active' AND outbound_enabled) THEN
    PERFORM developer.enqueue_webhook_deliveries(v_fulfillment.provider_id,v_event_id,'commerce.fulfillment.ready',
      jsonb_build_object('fulfillment_id',p_fulfillment_id,'external_order_id',v_fulfillment.medusa_order_id,'state','assigned','delivery_order_id',p_delivery_order_id,'driver_assigned',true),p_now);
  END IF;
  RETURN 'assigned'::commerce.fulfillment_state;
END;
$$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='commerce_operator_service') THEN
    GRANT USAGE ON SCHEMA commerce TO commerce_operator_service;
    GRANT EXECUTE ON FUNCTION commerce.register_external_platform_connection(integer,integer,text,text,boolean,boolean,text,timestamp with time zone) TO commerce_operator_service;
    GRANT EXECUTE ON FUNCTION commerce.assign_fulfillment_delivery_driver(uuid,integer,integer,integer,text,timestamp with time zone) TO commerce_operator_service;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='commerce_gateway_service') THEN
    GRANT USAGE ON SCHEMA commerce TO commerce_gateway_service;
    GRANT EXECUTE ON FUNCTION commerce.ingest_external_platform_event(text,text,text,jsonb,bytea,timestamp with time zone) TO commerce_gateway_service;
  END IF;
END $$;
REVOKE ALL ON TABLE commerce.external_platform_connection, commerce.external_platform_event FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce.register_external_platform_connection(integer,integer,text,text,boolean,boolean,text,timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce.ingest_external_platform_event(text,text,text,jsonb,bytea,timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce.assign_fulfillment_delivery_driver(uuid,integer,integer,integer,text,timestamp with time zone) FROM PUBLIC;
