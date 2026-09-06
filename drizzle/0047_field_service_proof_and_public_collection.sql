-- P1 technician proof capture and P2 provider-scoped developer collection.
-- Extends migration 0044/0045. PostgreSQL remains the authoritative lifecycle/evidence store.

CREATE OR REPLACE FUNCTION field_service.record_work_order_proof(
  p_work_order_id uuid,
  p_technician_user_id integer,
  p_kind text,
  p_object_key text,
  p_content_type text,
  p_sha256_hex text,
  p_idempotency_key text,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, field_service AS $$
DECLARE v_order field_service.work_order%ROWTYPE; v_proof_id uuid;
BEGIN
  IF p_kind NOT IN ('arrival','customer_signature','equipment_serial')
    OR length(p_object_key) NOT BETWEEN 3 AND 512
    OR p_object_key !~ '^[A-Za-z0-9][A-Za-z0-9._/-]+$'
    OR p_content_type NOT IN ('image/jpeg','image/png','image/heic','application/pdf')
    OR p_sha256_hex !~ '^[a-f0-9]{64}$'
    OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN
    RAISE EXCEPTION 'invalid work-order proof input' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_order FROM field_service.work_order WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.assigned_technician_user_id <> p_technician_user_id THEN
    RAISE EXCEPTION 'work order is not assigned to technician' USING ERRCODE = '42501';
  END IF;
  IF v_order.state NOT IN ('on_site','completed') THEN
    RAISE EXCEPTION 'proof capture requires on-site work order' USING ERRCODE = '23514';
  END IF;
  SELECT id INTO v_proof_id FROM field_service.work_order_proof
    WHERE work_order_id = p_work_order_id AND kind = p_kind AND idempotency_key = p_idempotency_key;
  IF FOUND THEN RETURN v_proof_id; END IF;
  INSERT INTO field_service.work_order_proof (work_order_id,captured_by_user_id,object_key,content_type,sha256_hex,kind,idempotency_key,captured_at)
  VALUES (p_work_order_id,p_technician_user_id,p_object_key,p_content_type,p_sha256_hex,p_kind,p_idempotency_key,p_now)
  RETURNING id INTO v_proof_id;
  PERFORM field_service.append_work_order_event(p_work_order_id,p_technician_user_id,'work_order.proof_recorded',v_order.state,v_order.state,jsonb_build_object('kind',p_kind,'proof_sha256',p_sha256_hex),p_idempotency_key,p_now);
  PERFORM field_service.enqueue_work_order_outbox(p_work_order_id,'field_service.work_order.proof_recorded',p_idempotency_key,p_now);
  RETURN v_proof_id;
END;
$$;

CREATE OR REPLACE FUNCTION developer.public_list_field_service_work_orders(
  p_api_client_id uuid,
  p_limit integer DEFAULT 50,
  p_updated_before timestamptz DEFAULT NULL
)
RETURNS TABLE (id uuid, reference text, state text, priority text, scheduled_start_at timestamptz, scheduled_end_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, developer AS $$
DECLARE v_provider_id integer;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid list limit' USING ERRCODE = '22023'; END IF;
  SELECT client.provider_id INTO v_provider_id FROM developer.api_client AS client WHERE client.id = p_api_client_id AND client.state = 'active';
  IF v_provider_id IS NULL THEN RAISE EXCEPTION 'developer API client is unavailable' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT work.id, work.public_reference, work.state::text, work.priority::text, work.scheduled_start_at, work.scheduled_end_at, work.updated_at
  FROM field_service.work_order work
  WHERE work.provider_id = v_provider_id AND (p_updated_before IS NULL OR work.updated_at < p_updated_before)
  ORDER BY work.updated_at DESC, work.id DESC LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION field_service.record_work_order_proof(uuid,integer,text,text,text,text,text,timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION developer.public_list_field_service_work_orders(uuid,integer,timestamp with time zone) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_service_api') THEN
    GRANT EXECUTE ON FUNCTION field_service.record_work_order_proof(uuid,integer,text,text,text,text,text,timestamp with time zone) TO field_service_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'developer_api_service') THEN
    GRANT EXECUTE ON FUNCTION developer.public_list_field_service_work_orders(uuid,integer,timestamp with time zone) TO developer_api_service;
  END IF;
END $$;
