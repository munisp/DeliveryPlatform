-- Onboarding integration (Audit A P1-5..10, cross-cutting 1-2,5).
--
-- 1. verification.case_state gains 'appealed' so a rejected/suspended case can
--    be appealed through the new public.verification_appeals due-process table
--    (14-day SLA, reviewer != original decider enforced in server code, see
--    server/_core/verificationAppeals.ts). The enum value is added OUTSIDE the
--    transaction below: PostgreSQL < 12 forbids ALTER TYPE ... ADD VALUE inside
--    a transaction, and even on 12+ the new value may not be used in the same
--    transaction. ADD VALUE IF NOT EXISTS keeps the migration replay-safe.
-- 2. verification.outbox_event gains consumed_at so the server-side consumer
--    sweep (server/_core/scheduledJobs.ts) can mark events idempotently.
-- 3. commerce.merchant_portal gains rejection_reason (P1-10: merchant reject
--    stored no reason).
-- 4. vehicle_access.create_provider now provisions fleet providers in
--    'pending' (P1-5: providers were created instantly 'active', ignoring the
--    pending state) and the new vehicle_access.activate_provider requires a
--    VERIFIED verification case with subject_type='fleet_provider' bound to
--    the provider (subject_key 'fleet-provider:<uuid>').
-- 5. field_service.upsert_technician (signature identical to drizzle/0044):
--    p_state='active' now requires a VERIFIED field_technician case for the
--    technician user (P1-5 technician activation was operator attestation).
-- 6. vehicle_access.upsert_worker_eligibility (signature identical to
--    drizzle/0050): 'verified' eligibility now requires a VERIFIED driver
--    verification case for the worker and persists the binding in the new
--    verification_case_id column (P1-7: operator-attested eligibility bypassed
--    KYC, weakening the 0058 rental gate).
-- 7. public.market_economics_reports: latest machine-readable market reports
--    produced via the market-economics service (server/_core/economicsPolicy.ts).
--
-- Every CREATE OR REPLACE keeps the original signature so existing grants
-- carry over; grants are restated defensively in role-guarded DO blocks.

ALTER TYPE verification.case_state ADD VALUE IF NOT EXISTS 'appealed';

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Verification appeal due process (P1-10).
CREATE TABLE IF NOT EXISTS public.verification_appeals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES verification.verification_case(id) ON DELETE RESTRICT,
  appellant_user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  statement text NOT NULL CHECK (length(trim(statement)) BETWEEN 3 AND 4000),
  status text NOT NULL DEFAULT 'filed' CHECK (status IN ('filed', 'in_review', 'decided')),
  decision text CHECK (decision IS NULL OR decision IN ('upheld', 'overturned')),
  rationale text CHECK (rationale IS NULL OR length(rationale) <= 4000),
  reviewer_id bigint REFERENCES public.users(id) ON DELETE SET NULL,
  sla_due_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'decided') = (decision IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS verification_appeals_case_idx
  ON public.verification_appeals (case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS verification_appeals_open_sla_idx
  ON public.verification_appeals (sla_due_at) WHERE status <> 'decided';

-- Outbox consumer marker (cross-cutting 2: verification outbox had no consumer).
ALTER TABLE verification.outbox_event
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz;
CREATE INDEX IF NOT EXISTS verification_outbox_unconsumed_idx
  ON verification.outbox_event (created_at) WHERE consumed_at IS NULL;

-- Merchant rejection reason (P1-10).
ALTER TABLE commerce.merchant_portal
  ADD COLUMN IF NOT EXISTS rejection_reason text;

-- Latest published market economics reports (orphan service 8110 wiring).
CREATE TABLE IF NOT EXISTS public.market_economics_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id text NOT NULL CHECK (length(market_id) BETWEEN 1 AND 64),
  period jsonb NOT NULL CHECK (jsonb_typeof(period) = 'object'),
  report jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_economics_reports_market_idx
  ON public.market_economics_reports (market_id, created_at DESC);

-- Worker eligibility now binds to the verification case that justifies it.
ALTER TABLE vehicle_access.worker_eligibility
  ADD COLUMN IF NOT EXISTS verification_case_id uuid;

-- Fleet provider onboarding: providers start 'pending'; activation requires a
-- verified fleet_provider verification case bound to the provider.
CREATE OR REPLACE FUNCTION vehicle_access.create_provider(p_actor integer,p_display text,p_legal text,p_now timestamptz DEFAULT clock_timestamp())
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vehicle_access AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE='42501'; END IF;
  INSERT INTO vehicle_access.fleet_provider(display_name,legal_name,state,created_by_user_id,created_at,updated_at) VALUES(p_display,p_legal,'pending',p_actor,p_now,p_now) RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION vehicle_access.activate_provider(p_actor integer,p_provider uuid,p_verification_case uuid,p_now timestamptz DEFAULT clock_timestamp())
RETURNS vehicle_access.provider_state LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vehicle_access AS $$
DECLARE v_state vehicle_access.provider_state;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE='42501'; END IF;
  SELECT state INTO v_state FROM vehicle_access.fleet_provider WHERE id=p_provider FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fleet provider not found' USING ERRCODE='P0002'; END IF;
  IF v_state='active' THEN RETURN v_state; END IF;
  IF p_verification_case IS NULL OR NOT EXISTS (
    SELECT 1 FROM verification.verification_case
    WHERE id=p_verification_case
      AND state='verified'::verification.case_state
      AND subject_type='fleet_provider'::verification.subject_type
      AND subject_key='fleet-provider:'||p_provider::text
      AND (expires_at IS NULL OR expires_at>p_now)
  ) THEN RAISE EXCEPTION 'verified fleet provider verification case bound to this provider required' USING ERRCODE='23514'; END IF;
  UPDATE vehicle_access.fleet_provider SET state='active',updated_at=p_now WHERE id=p_provider;
  RETURN 'active';
END; $$;

-- Worker eligibility: 'verified' now requires a verified driver KYC case
-- (stored on the row); operator attestation alone no longer verifies.
CREATE OR REPLACE FUNCTION vehicle_access.upsert_worker_eligibility(p_actor integer,p_worker integer,p_categories jsonb,p_expires timestamptz,p_now timestamptz DEFAULT clock_timestamp())
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vehicle_access AS $$
DECLARE v_case_id uuid;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_categories) <> 'array' OR jsonb_array_length(p_categories) NOT BETWEEN 1 AND 4 OR p_expires <= p_now THEN RAISE EXCEPTION 'invalid worker eligibility' USING ERRCODE='22023'; END IF;
  SELECT c.id INTO v_case_id FROM verification.verification_case c
   WHERE c.subject_user_id=p_worker
     AND c.subject_type='driver'::verification.subject_type
     AND c.state='verified'::verification.case_state
     AND (c.expires_at IS NULL OR c.expires_at>p_now)
   ORDER BY c.verified_at DESC NULLS LAST, c.updated_at DESC
   LIMIT 1;
  IF v_case_id IS NULL THEN RAISE EXCEPTION 'verified driver verification case required for worker eligibility' USING ERRCODE='23514'; END IF;
  INSERT INTO vehicle_access.worker_eligibility(worker_user_id,state,allowed_work_categories,verified_by_user_id,verified_at,expires_at,verification_case_id,updated_at)
  VALUES(p_worker,'verified',p_categories,p_actor,p_now,p_expires,v_case_id,p_now)
  ON CONFLICT (worker_user_id) DO UPDATE SET state='verified',allowed_work_categories=EXCLUDED.allowed_work_categories,verified_by_user_id=EXCLUDED.verified_by_user_id,verified_at=EXCLUDED.verified_at,expires_at=EXCLUDED.expires_at,verification_case_id=EXCLUDED.verification_case_id,updated_at=EXCLUDED.updated_at;
  RETURN 'verified';
END; $$;

-- Technician activation gate: p_state='active' requires a verified
-- field_technician verification case for the technician user. Non-active
-- states (onboarding/suspended transitions) stay attestable.
CREATE OR REPLACE FUNCTION field_service.upsert_technician(
  p_actor_user_id integer, p_user_id integer, p_provider_id integer, p_display_name text, p_employee_reference text, p_skills jsonb, p_state field_service.technician_state, p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, field_service AS $$
BEGIN
  IF NOT field_service.is_platform_operator(p_actor_user_id) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE = '42501'; END IF;
  IF length(p_display_name) NOT BETWEEN 2 AND 160 OR jsonb_typeof(p_skills) <> 'array' OR jsonb_array_length(p_skills) > 48 OR (p_employee_reference IS NOT NULL AND p_employee_reference !~ '^[A-Za-z0-9._:-]{1,128}$') THEN RAISE EXCEPTION 'invalid technician input' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id) THEN RAISE EXCEPTION 'technician user does not exist' USING ERRCODE = 'P0002'; END IF;
  IF p_state = 'active'::field_service.technician_state AND NOT EXISTS (
    SELECT 1 FROM verification.verification_case c
    WHERE c.subject_user_id = p_user_id
      AND c.subject_type = 'field_technician'::verification.subject_type
      AND c.state = 'verified'::verification.case_state
      AND (c.expires_at IS NULL OR c.expires_at > p_now)
  ) THEN RAISE EXCEPTION 'verified field technician verification case required for activation' USING ERRCODE = '23514'; END IF;
  INSERT INTO field_service.technician_profile (user_id, provider_id, employee_reference, display_name, skills, state, activated_at, suspended_at, created_at, updated_at)
  VALUES (p_user_id, p_provider_id, p_employee_reference, p_display_name, p_skills, p_state, CASE WHEN p_state = 'active' THEN p_now END, CASE WHEN p_state = 'suspended' THEN p_now END, p_now, p_now)
  ON CONFLICT (user_id) DO UPDATE SET provider_id = EXCLUDED.provider_id, employee_reference = EXCLUDED.employee_reference, display_name = EXCLUDED.display_name, skills = EXCLUDED.skills, state = EXCLUDED.state, activated_at = CASE WHEN EXCLUDED.state = 'active' THEN p_now ELSE NULL END, suspended_at = CASE WHEN EXCLUDED.state = 'suspended' THEN p_now ELSE NULL END, updated_at = p_now;
  RETURN p_user_id;
END;
$$;

-- CREATE OR REPLACE preserves grants; restate them defensively (same guard
-- pattern as 0044/0058/0091) so replayed or out-of-order application stays
-- correct.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='vehicle_access_service') THEN
    GRANT EXECUTE ON FUNCTION vehicle_access.create_provider(integer,text,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.activate_provider(integer,uuid,uuid,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.upsert_worker_eligibility(integer,integer,jsonb,timestamptz,timestamptz) TO vehicle_access_service;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_service_api') THEN
    GRANT EXECUTE ON FUNCTION field_service.upsert_technician(integer,integer,integer,text,text,jsonb,field_service.technician_state,timestamp with time zone) TO field_service_api;
  END IF;
END $$;

COMMIT;
