-- Verified rider identity (R1: riders registered as "Snake" / "Mr. Dot"
-- murdered drivers in Nigeria; the union demands riders be verified before
-- they can be matched to a driver).
--
-- Privacy rule: raw national ID numbers (NIN, BVN, etc.) are NEVER stored.
-- Only the sha256 hex digest of the ID reference is persisted
-- (id_ref_hash). Raw values stay inside the verification-intelligence
-- service request/response path and are dropped by the caller.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.rider_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'unverified'
    CHECK (status IN ('unverified', 'pending', 'verified', 'rejected', 'suspended')),
  id_type text,
  id_ref_hash text,
  name_plausibility_score numeric(4,3),
  name_screening_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);
CREATE INDEX IF NOT EXISTS rider_verifications_status_idx
  ON public.rider_verifications (status);

-- Append-only audit trail of every name screening. Keeps the raw input name
-- (already stored on public.users) plus the score/flags returned by the
-- verification-intelligence service so disputed decisions can be re-reviewed
-- without re-running the model.
CREATE TABLE IF NOT EXISTS public.rider_name_screenings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id bigint REFERENCES public.users(id) ON DELETE SET NULL,
  input_name text NOT NULL,
  score numeric(4,3),
  flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  screened_by text NOT NULL DEFAULT 'verification-intelligence',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rider_name_screenings_user_idx
  ON public.rider_name_screenings (user_id, created_at DESC);

