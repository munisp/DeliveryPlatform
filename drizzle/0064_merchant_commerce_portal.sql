-- Merchant portal authority for the Medusa gateway. PostgreSQL is authoritative
-- for membership, onboarding, merchant product ownership, and payment routing
-- configuration; Medusa is the commerce-catalog and inventory implementation.
CREATE SCHEMA IF NOT EXISTS commerce;

DO $$ BEGIN
  CREATE TYPE commerce.merchant_portal_state AS ENUM ('draft','verification_pending','active','suspended','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE commerce.merchant_access_role AS ENUM ('owner','catalog_manager','inventory_manager','finance_viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS commerce.merchant_portal (
  provider_id integer PRIMARY KEY REFERENCES public.service_providers(id) ON DELETE RESTRICT,
  owner_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  state commerce.merchant_portal_state NOT NULL DEFAULT 'draft',
  legal_name text NOT NULL CHECK (length(trim(legal_name)) BETWEEN 2 AND 255),
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 2 AND 160),
  medusa_store_id text NOT NULL UNIQUE CHECK (medusa_store_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$'),
  default_stock_location_id text CHECK (default_stock_location_id IS NULL OR default_stock_location_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$'),
  verification_case_id uuid,
  activated_at timestamptz,
  suspended_at timestamptz,
  rejected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'active' AND activated_at IS NOT NULL) OR state <> 'active'),
  CHECK ((state = 'suspended' AND suspended_at IS NOT NULL) OR state <> 'suspended'),
  CHECK ((state = 'rejected' AND rejected_at IS NOT NULL) OR state <> 'rejected')
);

CREATE TABLE IF NOT EXISTS commerce.merchant_user_access (
  provider_id integer NOT NULL REFERENCES commerce.merchant_portal(provider_id) ON DELETE RESTRICT,
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  role commerce.merchant_access_role NOT NULL,
  active boolean NOT NULL DEFAULT true,
  granted_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (provider_id, user_id, role),
  CHECK ((active AND revoked_at IS NULL) OR (NOT active AND revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS merchant_user_access_active_idx
  ON commerce.merchant_user_access (user_id, provider_id) WHERE active;

CREATE TABLE IF NOT EXISTS commerce.merchant_catalog_product (
  provider_id integer NOT NULL REFERENCES commerce.merchant_portal(provider_id) ON DELETE RESTRICT,
  medusa_product_id text NOT NULL CHECK (medusa_product_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$'),
  product_handle text NOT NULL CHECK (product_handle ~ '^[a-z0-9][a-z0-9-]{1,158}$'),
  state text NOT NULL CHECK (state IN ('draft','published','archived')),
  created_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, medusa_product_id),
  UNIQUE (provider_id, product_handle)
);

CREATE TABLE IF NOT EXISTS commerce.merchant_payment_configuration (
  provider_id integer PRIMARY KEY REFERENCES commerce.merchant_portal(provider_id) ON DELETE RESTRICT,
  payment_provider_key text NOT NULL CHECK (payment_provider_key = 'deliveryplatform'),
  settlement_fsp_alias text NOT NULL CHECK (settlement_fsp_alias ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'),
  payout_reference_digest bytea NOT NULL CHECK (octet_length(payout_reference_digest) = 32),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  enabled boolean NOT NULL DEFAULT false,
  configured_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  configured_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CHECK ((enabled AND disabled_at IS NULL) OR (NOT enabled AND disabled_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS commerce.merchant_portal_audit_event (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  provider_id integer NOT NULL REFERENCES commerce.merchant_portal(provider_id) ON DELETE RESTRICT,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  actor_user_id integer REFERENCES public.users(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.]{2,95}$'),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, sequence_no),
  UNIQUE (provider_id, idempotency_key)
);

CREATE OR REPLACE FUNCTION commerce.prevent_merchant_portal_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, commerce AS $$
BEGIN RAISE EXCEPTION 'merchant portal audit evidence is append-only' USING ERRCODE = '55000'; END; $$;
DROP TRIGGER IF EXISTS merchant_portal_audit_append_only ON commerce.merchant_portal_audit_event;
CREATE TRIGGER merchant_portal_audit_append_only
  BEFORE UPDATE OR DELETE ON commerce.merchant_portal_audit_event
  FOR EACH ROW EXECUTE FUNCTION commerce.prevent_merchant_portal_audit_mutation();

CREATE OR REPLACE FUNCTION commerce.is_commerce_operator(p_user_id integer)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, commerce AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
     WHERE id = p_user_id AND role::text IN ('admin','platform_admin','super_admin')
  );
$$;

CREATE OR REPLACE FUNCTION commerce.append_merchant_portal_audit(
  p_provider_id integer, p_actor_user_id integer, p_event_type text, p_detail jsonb,
  p_idempotency_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, commerce AS $$
DECLARE v_sequence integer;
BEGIN
  SELECT COALESCE(MAX(sequence_no), 0) + 1 INTO v_sequence
    FROM commerce.merchant_portal_audit_event WHERE provider_id = p_provider_id;
  INSERT INTO commerce.merchant_portal_audit_event(
    provider_id,sequence_no,actor_user_id,event_type,detail,idempotency_key,created_at
  ) VALUES (p_provider_id,v_sequence,p_actor_user_id,p_event_type,p_detail,p_idempotency_key,p_now);
EXCEPTION WHEN unique_violation THEN NULL; END;
$$;

CREATE OR REPLACE FUNCTION commerce.begin_merchant_onboarding(
  p_actor_user_id integer, p_provider_id integer, p_legal_name text, p_display_name text,
  p_medusa_store_id text, p_idempotency_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS commerce.merchant_portal_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, commerce AS $$
DECLARE v_portal commerce.merchant_portal%ROWTYPE;
BEGIN
  IF p_provider_id <= 0 OR length(trim(p_legal_name)) NOT BETWEEN 2 AND 255
     OR length(trim(p_display_name)) NOT BETWEEN 2 AND 160
     OR p_medusa_store_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$'
     OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN
    RAISE EXCEPTION 'invalid merchant onboarding input' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.service_providers WHERE id = p_provider_id) THEN
    RAISE EXCEPTION 'merchant provider not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_portal FROM commerce.merchant_portal WHERE provider_id = p_provider_id FOR UPDATE;
  IF FOUND AND v_portal.owner_user_id <> p_actor_user_id AND NOT commerce.is_commerce_operator(p_actor_user_id) THEN
    RAISE EXCEPTION 'merchant owner or platform operator required' USING ERRCODE = '42501';
  END IF;
  IF FOUND AND v_portal.state IN ('active','suspended','rejected') THEN RETURN v_portal.state; END IF;
  INSERT INTO commerce.merchant_portal(provider_id,owner_user_id,state,legal_name,display_name,medusa_store_id,created_at,updated_at)
  VALUES(p_provider_id,p_actor_user_id,'verification_pending'::commerce.merchant_portal_state,trim(p_legal_name),trim(p_display_name),p_medusa_store_id,p_now,p_now)
  ON CONFLICT(provider_id) DO UPDATE SET legal_name=EXCLUDED.legal_name,display_name=EXCLUDED.display_name,medusa_store_id=EXCLUDED.medusa_store_id,state='verification_pending'::commerce.merchant_portal_state,updated_at=p_now
  RETURNING * INTO v_portal;
  INSERT INTO commerce.merchant_user_access(provider_id,user_id,role,active,granted_by_user_id,granted_at,revoked_at)
  VALUES(p_provider_id,v_portal.owner_user_id,'owner'::commerce.merchant_access_role,true,p_actor_user_id,p_now,NULL)
  ON CONFLICT(provider_id,user_id,role) DO UPDATE SET active=true,granted_by_user_id=EXCLUDED.granted_by_user_id,granted_at=p_now,revoked_at=NULL;
  PERFORM commerce.append_merchant_portal_audit(p_provider_id,p_actor_user_id,'merchant.onboarding.requested',jsonb_build_object('medusa_store_id',p_medusa_store_id),p_idempotency_key,p_now);
  RETURN v_portal.state;
END; $$;

CREATE OR REPLACE FUNCTION commerce.decide_merchant_onboarding(
  p_actor_user_id integer, p_provider_id integer, p_decision text, p_verification_case_id uuid,
  p_idempotency_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS commerce.merchant_portal_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, commerce AS $$
DECLARE v_portal commerce.merchant_portal%ROWTYPE;
BEGIN
  IF NOT commerce.is_commerce_operator(p_actor_user_id) THEN RAISE EXCEPTION 'commerce operator required' USING ERRCODE='42501'; END IF;
  IF p_decision NOT IN ('activate','suspend','reject') OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid merchant decision input' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_portal FROM commerce.merchant_portal WHERE provider_id=p_provider_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'merchant onboarding not found' USING ERRCODE='P0002'; END IF;
  IF p_decision='activate' AND (p_verification_case_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM verification.verification_case WHERE id=p_verification_case_id AND state='verified'::verification.case_state
  )) THEN RAISE EXCEPTION 'verified merchant verification case required' USING ERRCODE='23514'; END IF;
  UPDATE commerce.merchant_portal SET state=CASE p_decision WHEN 'activate' THEN 'active'::commerce.merchant_portal_state WHEN 'suspend' THEN 'suspended'::commerce.merchant_portal_state ELSE 'rejected'::commerce.merchant_portal_state END,
    verification_case_id=COALESCE(p_verification_case_id,verification_case_id),activated_at=CASE WHEN p_decision='activate' THEN p_now ELSE activated_at END,suspended_at=CASE WHEN p_decision='suspend' THEN p_now ELSE suspended_at END,rejected_at=CASE WHEN p_decision='reject' THEN p_now ELSE rejected_at END,updated_at=p_now
    WHERE provider_id=p_provider_id RETURNING * INTO v_portal;
  PERFORM commerce.append_merchant_portal_audit(p_provider_id,p_actor_user_id,'merchant.onboarding.' || p_decision,jsonb_build_object('verification_case_id',p_verification_case_id),p_idempotency_key,p_now);
  RETURN v_portal.state;
END; $$;

CREATE OR REPLACE FUNCTION commerce.authorize_merchant_portal(
  p_actor_user_id integer, p_provider_id integer, p_required_roles commerce.merchant_access_role[]
) RETURNS TABLE(provider_id integer, medusa_store_id text, default_stock_location_id text, payment_enabled boolean, settlement_fsp_alias text, currency_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, commerce AS $$
BEGIN
  IF p_provider_id <= 0 OR COALESCE(array_length(p_required_roles,1),0)=0 THEN RAISE EXCEPTION 'invalid merchant authorization input' USING ERRCODE='22023'; END IF;
  IF NOT commerce.is_commerce_operator(p_actor_user_id) AND NOT EXISTS (
    SELECT 1 FROM commerce.merchant_user_access a WHERE a.provider_id=p_provider_id AND a.user_id=p_actor_user_id AND a.active AND a.role=ANY(p_required_roles)
  ) THEN RAISE EXCEPTION 'merchant access denied' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT p.provider_id,p.medusa_store_id,p.default_stock_location_id,
    COALESCE(pay.enabled,false),pay.settlement_fsp_alias,pay.currency_code
  FROM commerce.merchant_portal p LEFT JOIN commerce.merchant_payment_configuration pay ON pay.provider_id=p.provider_id
  WHERE p.provider_id=p_provider_id AND p.state='active'::commerce.merchant_portal_state;
  IF NOT FOUND THEN RAISE EXCEPTION 'active merchant required' USING ERRCODE='23514'; END IF;
END; $$;

CREATE OR REPLACE FUNCTION commerce.record_merchant_catalog_product(
  p_actor_user_id integer,p_provider_id integer,p_medusa_product_id text,p_handle text,p_state text,p_idempotency_key text,p_now timestamptz DEFAULT clock_timestamp()
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,commerce AS $$
BEGIN
  PERFORM 1 FROM commerce.authorize_merchant_portal(p_actor_user_id,p_provider_id,ARRAY['owner','catalog_manager']::commerce.merchant_access_role[]);
  IF p_medusa_product_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$' OR p_handle !~ '^[a-z0-9][a-z0-9-]{1,158}$' OR p_state NOT IN ('draft','published','archived') OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid merchant catalog product input' USING ERRCODE='22023'; END IF;
  INSERT INTO commerce.merchant_catalog_product(provider_id,medusa_product_id,product_handle,state,created_by_user_id,created_at,updated_at)
  VALUES(p_provider_id,p_medusa_product_id,p_handle,p_state,p_actor_user_id,p_now,p_now)
  ON CONFLICT(provider_id,medusa_product_id) DO UPDATE SET product_handle=EXCLUDED.product_handle,state=EXCLUDED.state,updated_at=p_now;
  PERFORM commerce.append_merchant_portal_audit(p_provider_id,p_actor_user_id,'merchant.catalog.product.recorded',jsonb_build_object('medusa_product_id',p_medusa_product_id,'state',p_state),p_idempotency_key,p_now);
END; $$;

CREATE OR REPLACE FUNCTION commerce.configure_merchant_payment(
  p_actor_user_id integer,p_provider_id integer,p_settlement_fsp_alias text,p_payout_reference_digest bytea,p_currency_code text,p_enabled boolean,p_idempotency_key text,p_now timestamptz DEFAULT clock_timestamp()
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,commerce AS $$
BEGIN
  PERFORM 1 FROM commerce.authorize_merchant_portal(p_actor_user_id,p_provider_id,ARRAY['owner','finance_viewer']::commerce.merchant_access_role[]);
  IF p_settlement_fsp_alias !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$' OR octet_length(p_payout_reference_digest)<>32 OR p_currency_code !~ '^[A-Z]{3}$' OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid merchant payment configuration' USING ERRCODE='22023'; END IF;
  INSERT INTO commerce.merchant_payment_configuration(provider_id,payment_provider_key,settlement_fsp_alias,payout_reference_digest,currency_code,enabled,configured_by_user_id,configured_at,disabled_at)
  VALUES(p_provider_id,'deliveryplatform',p_settlement_fsp_alias,p_payout_reference_digest,p_currency_code,p_enabled,p_actor_user_id,p_now,CASE WHEN p_enabled THEN NULL ELSE p_now END)
  ON CONFLICT(provider_id) DO UPDATE SET settlement_fsp_alias=EXCLUDED.settlement_fsp_alias,payout_reference_digest=EXCLUDED.payout_reference_digest,currency_code=EXCLUDED.currency_code,enabled=EXCLUDED.enabled,configured_by_user_id=EXCLUDED.configured_by_user_id,configured_at=p_now,disabled_at=CASE WHEN EXCLUDED.enabled THEN NULL ELSE p_now END;
  PERFORM commerce.append_merchant_portal_audit(p_provider_id,p_actor_user_id,'merchant.payment.configured',jsonb_build_object('settlement_fsp_alias',p_settlement_fsp_alias,'currency_code',p_currency_code,'enabled',p_enabled),p_idempotency_key,p_now);
END; $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='commerce_operator_service') THEN
    GRANT USAGE ON SCHEMA commerce TO commerce_operator_service;
    GRANT EXECUTE ON FUNCTION commerce.begin_merchant_onboarding(integer,integer,text,text,text,text,timestamp with time zone) TO commerce_operator_service;
    GRANT EXECUTE ON FUNCTION commerce.decide_merchant_onboarding(integer,integer,text,uuid,text,timestamp with time zone) TO commerce_operator_service;
    GRANT EXECUTE ON FUNCTION commerce.authorize_merchant_portal(integer,integer,commerce.merchant_access_role[]) TO commerce_operator_service;
    GRANT EXECUTE ON FUNCTION commerce.record_merchant_catalog_product(integer,integer,text,text,text,text,timestamp with time zone) TO commerce_operator_service;
    GRANT EXECUTE ON FUNCTION commerce.configure_merchant_payment(integer,integer,text,bytea,text,boolean,text,timestamp with time zone) TO commerce_operator_service;
  END IF;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA commerce FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA commerce FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION commerce.prevent_merchant_portal_audit_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION commerce.is_commerce_operator(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION commerce.append_merchant_portal_audit(integer,integer,text,jsonb,text,timestamp with time zone) FROM PUBLIC;
