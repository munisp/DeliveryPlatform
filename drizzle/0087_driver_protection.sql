-- Driver protection (R11 insurance/downtime, R12 remittance-aware floor).
-- Group protection policies carry a per-trip micro-premium and protection
-- levy priced into the market cost index; accident-downtime stipends pay out
-- of claims. Remittance schedules (hire-purchase/rental) require driver
-- re-acceptance on change and a mediation window before any enforcement —
-- the repossess-without-notice pattern is structurally blocked.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.protection_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id text NOT NULL UNIQUE,
  micro_premium_minor bigint NOT NULL DEFAULT 0 CHECK (micro_premium_minor >= 0),
  downtime_daily_stipend_minor bigint NOT NULL DEFAULT 0,
  protection_levy_minor bigint NOT NULL DEFAULT 0,
  opt_out_allowed boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  consultation_id uuid REFERENCES public.consultation_objects(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.protection_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  policy_id uuid NOT NULL REFERENCES public.protection_policies(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled', 'opted_out', 'suspended')),
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  opt_out_at timestamptz,
  UNIQUE (driver_id)
);
CREATE INDEX IF NOT EXISTS protection_enrollments_policy_idx
  ON public.protection_enrollments (policy_id, status);

CREATE TABLE IF NOT EXISTS public.protection_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id uuid NOT NULL REFERENCES public.protection_enrollments(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('accident_downtime', 'maintenance', 'other')),
  status text NOT NULL DEFAULT 'filed' CHECK (status IN ('filed', 'approved', 'rejected', 'paid')),
  amount_minor bigint,
  currency text NOT NULL DEFAULT 'NGN',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  filed_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by bigint REFERENCES public.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS protection_claims_enrollment_idx
  ON public.protection_claims (enrollment_id);
CREATE INDEX IF NOT EXISTS protection_claims_status_idx
  ON public.protection_claims (status, filed_at DESC);

CREATE TABLE IF NOT EXISTS public.maintenance_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  city text NOT NULL,
  services jsonb NOT NULL DEFAULT '[]'::jsonb,
  vetted boolean NOT NULL DEFAULT false,
  contact jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maintenance_providers_city_vetted_idx
  ON public.maintenance_providers (city, vetted);

CREATE TABLE IF NOT EXISTS public.remittance_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  vehicle_contract_ref text,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL DEFAULT 'NGN',
  frequency text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  next_due_at timestamptz,
  status text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'renegotiating', 'mediation', 'defaulted')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (driver_id, version)
);
CREATE INDEX IF NOT EXISTS remittance_schedules_driver_idx
  ON public.remittance_schedules (driver_id, version DESC);

CREATE TABLE IF NOT EXISTS public.remittance_change_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES public.remittance_schedules(id) ON DELETE RESTRICT,
  old_amount_minor bigint NOT NULL,
  new_amount_minor bigint NOT NULL,
  effective_at timestamptz NOT NULL,
  requires_reacceptance boolean NOT NULL DEFAULT true,
  accepted_at timestamptz,
  mediation_window_ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS remittance_change_notices_schedule_idx
  ON public.remittance_change_notices (schedule_id, created_at DESC);
