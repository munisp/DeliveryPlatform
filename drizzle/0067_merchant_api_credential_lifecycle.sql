CREATE SCHEMA IF NOT EXISTS commerce;
CREATE OR REPLACE FUNCTION commerce.issue_merchant_api_credential(p_actor_user_id integer,p_provider_id integer,p_key_id text,p_secret_sha256 bytea,p_scopes text[],p_expires_at timestamptz,p_now timestamptz DEFAULT clock_timestamp()) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,commerce AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM 1 FROM commerce.authorize_merchant_portal(p_actor_user_id,p_provider_id,ARRAY['owner']::commerce.merchant_access_role[]);
  IF p_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' OR octet_length(p_secret_sha256)<>32 OR cardinality(p_scopes) NOT BETWEEN 1 AND 8 OR p_expires_at NOT BETWEEN p_now + interval '1 hour' AND p_now + interval '366 days' THEN RAISE EXCEPTION 'invalid merchant credential input' USING ERRCODE='22023'; END IF;
  INSERT INTO commerce.merchant_api_credential(provider_id,key_id,secret_sha256,scopes,state,created_by_user_id,created_at,expires_at) VALUES(p_provider_id,p_key_id,p_secret_sha256,p_scopes,'active',p_actor_user_id,p_now,p_expires_at) RETURNING id INTO v_id;
  PERFORM commerce.append_merchant_portal_audit(p_provider_id,p_actor_user_id,'merchant.api_credential.issued',jsonb_build_object('key_id',p_key_id,'scopes',p_scopes,'expires_at',p_expires_at),p_key_id,p_now);
  RETURN v_id;
END $$;
CREATE OR REPLACE FUNCTION commerce.revoke_merchant_api_credential(p_actor_user_id integer,p_provider_id integer,p_key_id text,p_now timestamptz DEFAULT clock_timestamp()) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,commerce AS $$
BEGIN
  PERFORM 1 FROM commerce.authorize_merchant_portal(p_actor_user_id,p_provider_id,ARRAY['owner']::commerce.merchant_access_role[]);
  UPDATE commerce.merchant_api_credential SET state='revoked',revoked_at=p_now WHERE provider_id=p_provider_id AND key_id=p_key_id AND state='active';
  IF NOT FOUND THEN RAISE EXCEPTION 'active merchant credential not found' USING ERRCODE='P0002'; END IF;
  PERFORM commerce.append_merchant_portal_audit(p_provider_id,p_actor_user_id,'merchant.api_credential.revoked',jsonb_build_object('key_id',p_key_id),p_key_id||'.revoke',p_now);
END $$;
CREATE OR REPLACE FUNCTION commerce.verify_merchant_api_credential(p_key_id text,p_secret_sha256 bytea,p_required_scope text,p_now timestamptz DEFAULT clock_timestamp()) RETURNS TABLE(provider_id integer,credential_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,commerce AS $$
DECLARE v_expires_at timestamptz;
BEGIN
  IF p_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' OR octet_length(p_secret_sha256)<>32 THEN RAISE EXCEPTION 'invalid merchant credential' USING ERRCODE='42501'; END IF;
  SELECT expires_at INTO v_expires_at FROM commerce.merchant_api_credential
   WHERE key_id=p_key_id AND state='active' AND secret_sha256=p_secret_sha256 AND p_required_scope=ANY(scopes)
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'merchant credential denied' USING ERRCODE='42501'; END IF;
  IF v_expires_at<=p_now THEN
    UPDATE commerce.merchant_api_credential SET state='expired',revoked_at=p_now WHERE key_id=p_key_id AND state='active';
    RETURN;
  END IF;
  UPDATE commerce.merchant_api_credential SET last_used_at=p_now WHERE key_id=p_key_id AND state='active'
    RETURNING merchant_api_credential.provider_id,id INTO provider_id,credential_id;
  RETURN NEXT;
END $$;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_gateway_service') THEN GRANT USAGE ON SCHEMA commerce TO commerce_gateway_service; GRANT EXECUTE ON FUNCTION commerce.verify_merchant_api_credential(text,bytea,text,timestamp with time zone) TO commerce_gateway_service; END IF; IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_operator_service') THEN GRANT EXECUTE ON FUNCTION commerce.issue_merchant_api_credential(integer,integer,text,bytea,text[],timestamp with time zone,timestamp with time zone),commerce.revoke_merchant_api_credential(integer,integer,text,timestamp with time zone) TO commerce_operator_service; END IF; END $$;
REVOKE ALL ON FUNCTION commerce.issue_merchant_api_credential(integer,integer,text,bytea,text[],timestamp with time zone,timestamp with time zone),commerce.revoke_merchant_api_credential(integer,integer,text,timestamp with time zone),commerce.verify_merchant_api_credential(text,bytea,text,timestamp with time zone) FROM PUBLIC;
