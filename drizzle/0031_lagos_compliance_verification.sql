CREATE TABLE IF NOT EXISTS mobility.compliance_requirement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_code text NOT NULL CHECK (city_code = 'LAG'),
  subject_kind text NOT NULL CHECK (subject_kind IN ('driver', 'vehicle', 'operator')),
  evidence_type text NOT NULL,
  policy_version text NOT NULL,
  required_for_dispatch boolean NOT NULL DEFAULT true,
  requires_human_approval boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT NOW(),
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (city_code, subject_kind, evidence_type, policy_version),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX IF NOT EXISTS mobility_compliance_requirement_active_idx
  ON mobility.compliance_requirement (city_code, subject_kind, evidence_type)
  WHERE active = true;

ALTER TABLE mobility.compliance_evidence
  ADD COLUMN IF NOT EXISTS verification_reference text,
  ADD COLUMN IF NOT EXISTS source_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS human_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_policy_version text;

CREATE TABLE IF NOT EXISTS mobility.compliance_verification_review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id uuid NOT NULL REFERENCES mobility.compliance_evidence(id) ON DELETE CASCADE,
  provider_name text NOT NULL,
  request_digest bytea NOT NULL,
  provider_reference text,
  outcome text NOT NULL CHECK (outcome IN ('verified', 'rejected', 'manual_review', 'retryable_error')),
  response_status integer,
  response_digest bytea,
  response_recorded_at timestamptz NOT NULL DEFAULT NOW(),
  error_code text,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  next_attempt_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (evidence_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS mobility_compliance_review_due_idx
  ON mobility.compliance_verification_review (next_attempt_at)
  WHERE outcome = 'retryable_error' AND resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS mobility_compliance_review_evidence_idx
  ON mobility.compliance_verification_review (evidence_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mobility.compliance_decision_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id uuid REFERENCES mobility.compliance_evidence(id) ON DELETE RESTRICT,
  driver_user_id integer REFERENCES mobility.driver_profile(user_id) ON DELETE SET NULL,
  vehicle_id uuid REFERENCES mobility.vehicle(id) ON DELETE SET NULL,
  decision_kind text NOT NULL CHECK (decision_kind IN ('submitted', 'provider_verified', 'provider_rejected', 'human_approved', 'human_rejected', 'expired', 'eligibility_enabled', 'eligibility_disabled')),
  decision_reason text NOT NULL,
  policy_version text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('system', 'provider', 'operator')),
  actor_user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS mobility_compliance_decision_audit_subject_idx
  ON mobility.compliance_decision_audit (driver_user_id, vehicle_id, created_at DESC);

INSERT INTO mobility.compliance_requirement (city_code, subject_kind, evidence_type, policy_version, required_for_dispatch, requires_human_approval, active)
VALUES
  ('LAG','driver','national_driver_license','lagos-private-beta-v1',true,false,true),
  ('LAG','driver','lasdri_certificate','lagos-private-beta-v1',true,false,true),
  ('LAG','driver','identity_check','lagos-private-beta-v1',true,false,true),
  ('LAG','driver','background_screening','lagos-private-beta-v1',true,true,true),
  ('LAG','driver','training','lagos-private-beta-v1',true,false,true),
  ('LAG','vehicle','vehicle_registration','lagos-private-beta-v1',true,false,true),
  ('LAG','vehicle','roadworthiness','lagos-private-beta-v1',true,true,true),
  ('LAG','vehicle','vehicle_inspection','lagos-private-beta-v1',true,true,true),
  ('LAG','vehicle','commercial_motor_insurance','lagos-private-beta-v1',true,true,true),
  ('LAG','vehicle','passenger_liability_cover','lagos-private-beta-v1',true,true,true),
  ('LAG','operator','operator_permit','lagos-private-beta-v1',true,true,true)
ON CONFLICT (city_code, subject_kind, evidence_type, policy_version) DO UPDATE
SET required_for_dispatch = EXCLUDED.required_for_dispatch,
    requires_human_approval = EXCLUDED.requires_human_approval,
    active = EXCLUDED.active;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'switchos_service') THEN
    GRANT SELECT, INSERT, UPDATE ON mobility.compliance_requirement, mobility.compliance_evidence, mobility.compliance_verification_review, mobility.compliance_decision_audit, mobility.driver_eligibility, mobility.driver_presence TO switchos_service;
  END IF;
END $$;
