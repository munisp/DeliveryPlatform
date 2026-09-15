-- Worker transition protocol (R13).
-- Voluntary exit, role change, vehicle ownership and severance programs are
-- published with explicit terms (gratuity_minor, deficit_forgiveness) after a
-- worker-council consultation. On completion the exit gratuity and the waived
-- deficits are recorded EXPLICITLY on the enrollment row — the transcript
-- grievance was opaque deficit deductions silently eating a N40k gratuity, so
-- both figures must be visible, auditable columns, never implicit arithmetic.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.transition_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('voluntary_exit', 'role_change', 'vehicle_ownership', 'severance')),
  terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  open boolean NOT NULL DEFAULT true,
  consultation_id uuid REFERENCES public.consultation_objects(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transition_programs_open_idx
  ON public.transition_programs (open, kind);

CREATE TABLE IF NOT EXISTS public.transition_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES public.transition_programs(id) ON DELETE RESTRICT,
  worker_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled', 'in_progress', 'completed', 'withdrawn')),
  exit_gratuity_minor bigint NOT NULL DEFAULT 0 CHECK (exit_gratuity_minor >= 0),
  deficits_waived_minor bigint NOT NULL DEFAULT 0 CHECK (deficits_waived_minor >= 0),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, worker_id)
);
CREATE INDEX IF NOT EXISTS transition_enrollments_worker_idx
  ON public.transition_enrollments (worker_id, status);
CREATE INDEX IF NOT EXISTS transition_enrollments_program_idx
  ON public.transition_enrollments (program_id, status);
