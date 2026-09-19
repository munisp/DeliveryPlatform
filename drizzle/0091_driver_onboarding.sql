-- Driver onboarding + onboarding trust bindings (Audit A P0-1, P0-2 consent,
-- P0-4 merchant claim land-grab, P1-6 any-verified-case activation hole).
--
-- 1. public.driver_applications: the first real driver registration flow.
--    Drivers previously existed only via seed rows with silent open_id/email
--    linkage; now a user applies, a KYC case (verification engine,
--    subject_type 'driver') is opened, and an operator approves only against
--    a VERIFIED case. One active application per user (partial unique index).
-- 2. public.rider_verifications: consent receipt columns so rider
--    auto-verification can require captured consent (fail-closed, see
--    server/_core/riderVerification.ts).
-- 3. commerce.begin_merchant_onboarding / commerce.decide_merchant_onboarding
--    (from drizzle/0064, CREATE OR REPLACE with identical signatures so
--    existing grants carry over):
--    - claim now opens (or reuses) a verification case with
--      subject_type='merchant' and subject_key bound to the claimed provider
--      id BEFORE the portal can reach 'verification_pending', so the
--      claimant <-> business relation is forced through the KYC evidence
--      trail instead of being an unverified land-grab;
--    - activation requires a VERIFIED case whose subject_type='merchant'
--      AND whose subject_key matches THIS provider — any other verified case
--      (driver, technician, another merchant) no longer activates a portal.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.driver_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'in_review', 'approved', 'rejected', 'withdrawn')),
  verification_case_id uuid,
  full_name text NOT NULL,
  phone text,
  city text,
  vehicle jsonb NOT NULL DEFAULT '{}'::jsonb,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One active (submitted / in_review) application per user.
CREATE UNIQUE INDEX IF NOT EXISTS driver_applications_one_active_per_user_idx
  ON public.driver_applications (user_id) WHERE status IN ('submitted', 'in_review');
CREATE INDEX IF NOT EXISTS driver_applications_status_idx
  ON public.driver_applications (status, created_at DESC);

-- Rider verification consent receipt (fail-closed auto-approval requires it).
ALTER TABLE public.rider_verifications
  ADD COLUMN IF NOT EXISTS consent_captured_at timestamptz;
ALTER TABLE public.rider_verifications
  ADD COLUMN IF NOT EXISTS consent_version text;

-- Merchant claim: open/require a merchant-scoped verification case bound to
-- the claimed provider before the portal reaches verification_pending.
-- Subject key convention: 'provider:<service_providers.id>' — the activation
-- gate below matches on exactly this binding.
CREATE OR REPLACE FUNCTION commerce.begin_merchant_onboarding(
  p_actor_user_id integer, p_provider_id integer, p_legal_name text, p_display_name text,
  p_medusa_store_id text, p_idempotency_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS commerce.merchant_portal_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, commerce AS $$
DECLARE v_portal commerce.merchant_portal%ROWTYPE;
DECLARE v_case_id uuid;
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
  -- Claim binding: the claimant must hold a verification case with
  -- subject_type='merchant' bound to THIS provider before the portal moves
  -- to verification_pending. The request key is deterministic per provider,
  -- so repeat claims reuse the same case instead of flooding the engine.
  v_case_id := verification.start_case(
    p_actor_user_id,
    'merchant'::verification.subject_type,
    'provider:' || p_provider_id::text,
    p_actor_user_id,
    'NG',
    'merchant_onboarding',
    'merchant-claim-provider-' || p_provider_id::text,
    p_now
  );
  INSERT INTO commerce.merchant_portal(provider_id,owner_user_id,state,legal_name,display_name,medusa_store_id,verification_case_id,created_at,updated_at)
  VALUES(p_provider_id,p_actor_user_id,'verification_pending'::commerce.merchant_portal_state,trim(p_legal_name),trim(p_display_name),p_medusa_store_id,v_case_id,p_now,p_now)
  ON CONFLICT(provider_id) DO UPDATE SET legal_name=EXCLUDED.legal_name,display_name=EXCLUDED.display_name,medusa_store_id=EXCLUDED.medusa_store_id,state='verification_pending'::commerce.merchant_portal_state,verification_case_id=EXCLUDED.verification_case_id,updated_at=p_now
  RETURNING * INTO v_portal;
  INSERT INTO commerce.merchant_user_access(provider_id,user_id,role,active,granted_by_user_id,granted_at,revoked_at)
  VALUES(p_provider_id,v_portal.owner_user_id,'owner'::commerce.merchant_access_role,true,p_actor_user_id,p_now,NULL)
  ON CONFLICT(provider_id,user_id,role) DO UPDATE SET active=true,granted_by_user_id=EXCLUDED.granted_by_user_id,granted_at=p_now,revoked_at=NULL;
  PERFORM commerce.append_merchant_portal_audit(p_provider_id,p_actor_user_id,'merchant.onboarding.requested',jsonb_build_object('medusa_store_id',p_medusa_store_id,'verification_case_id',v_case_id),p_idempotency_key,p_now);
  RETURN v_portal.state;
END; $$;

-- Merchant activation: the required case must be VERIFIED *and* bound to this
-- provider (subject_type='merchant', subject_key='provider:<id>'). Closes the
-- any-verified-case hole from 0064.
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
    SELECT 1 FROM verification.verification_case
    WHERE id = p_verification_case_id
      AND state = 'verified'::verification.case_state
      AND subject_type = 'merchant'::verification.subject_type
      AND subject_key = 'provider:' || p_provider_id::text
  )) THEN RAISE EXCEPTION 'verified merchant verification case bound to this provider required' USING ERRCODE='23514'; END IF;
  UPDATE commerce.merchant_portal SET state=CASE p_decision WHEN 'activate' THEN 'active'::commerce.merchant_portal_state WHEN 'suspend' THEN 'suspended'::commerce.merchant_portal_state ELSE 'rejected'::commerce.merchant_portal_state END,
    verification_case_id=COALESCE(p_verification_case_id,verification_case_id),activated_at=CASE WHEN p_decision='activate' THEN p_now ELSE activated_at END,suspended_at=CASE WHEN p_decision='suspend' THEN p_now ELSE suspended_at END,rejected_at=CASE WHEN p_decision='reject' THEN p_now ELSE rejected_at END,updated_at=p_now
    WHERE provider_id=p_provider_id RETURNING * INTO v_portal;
  PERFORM commerce.append_merchant_portal_audit(p_provider_id,p_actor_user_id,'merchant.onboarding.' || p_decision,jsonb_build_object('verification_case_id',p_verification_case_id),p_idempotency_key,p_now);
  RETURN v_portal.state;
END; $$;

-- CREATE OR REPLACE preserves grants, but restate them defensively (same
-- guard pattern as 0064) so a replayed/out-of-order migration stays correct.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='commerce_operator_service') THEN
    GRANT EXECUTE ON FUNCTION commerce.begin_merchant_onboarding(integer,integer,text,text,text,text,timestamp with time zone) TO commerce_operator_service;
    GRANT EXECUTE ON FUNCTION commerce.decide_merchant_onboarding(integer,integer,text,uuid,text,timestamp with time zone) TO commerce_operator_service;
  END IF;
END $$;
