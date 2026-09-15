-- Just-cause deactivation due process (R4: union executives were deactivated
-- at home for protesting, with no notice and no appeal channel).
--
-- Every deactivation becomes a case with a bounded cause taxonomy, 14-day
-- notice for non-egregious causes, and an appeal path with a 14-day SLA
-- decided by a reviewer who is NOT the original decider (separation of
-- duties). protected_activity marks union/protest activity so retaliatory
-- deactivations require an elevated justification.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.deactivation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  subject_role text NOT NULL
    CHECK (subject_role IN ('driver', 'courier', 'merchant', 'rider')),
  cause_code text NOT NULL
    CHECK (cause_code IN ('SAFETY', 'FRAUD', 'DOCUMENTS', 'CONDUCT', 'POLICY', 'OTHER')),
  egregious boolean NOT NULL DEFAULT false,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'notice'
    CHECK (status IN ('notice', 'active', 'appealed', 'reinstated', 'upheld', 'closed')),
  notice_sent_at timestamptz,
  effective_at timestamptz,
  decided_by bigint REFERENCES public.users(id) ON DELETE RESTRICT,
  protected_activity boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deactivation_cases_subject_idx
  ON public.deactivation_cases (subject_user_id);
CREATE INDEX IF NOT EXISTS deactivation_cases_status_idx
  ON public.deactivation_cases (status);

CREATE TABLE IF NOT EXISTS public.deactivation_appeals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.deactivation_cases(id) ON DELETE CASCADE,
  appellant_user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  statement text NOT NULL,
  status text NOT NULL DEFAULT 'filed'
    CHECK (status IN ('filed', 'in_review', 'decided')),
  reviewer_id bigint REFERENCES public.users(id) ON DELETE RESTRICT,
  decided_at timestamptz,
  decision text
    CHECK (decision IN ('upheld', 'reinstated', 'reinstated_with_backpay')),
  rationale text,
  sla_due_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deactivation_appeals_case_idx
  ON public.deactivation_appeals (case_id);
CREATE INDEX IF NOT EXISTS deactivation_appeals_status_idx
  ON public.deactivation_appeals (status);
CREATE INDEX IF NOT EXISTS deactivation_appeals_sla_due_at_idx
  ON public.deactivation_appeals (sla_due_at);

-- Backpay credits awarded on 'reinstated_with_backpay' decisions. The
-- settlement/payout store has no public credit API today (payout_settlements
-- is read-only from the server tier), so Wave A1 records the award here as a
-- pending credit for the finance reconciliation flow to pick up.
CREATE TABLE IF NOT EXISTS public.backpay_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appeal_id uuid NOT NULL REFERENCES public.deactivation_appeals(id) ON DELETE RESTRICT,
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL DEFAULT 'NGN',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'settled', 'void')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backpay_credits_user_idx
  ON public.backpay_credits (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS backpay_credits_status_idx
  ON public.backpay_credits (status);

