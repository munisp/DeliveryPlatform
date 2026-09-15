-- Worker council consultation (R5: the platform refused all roundtables with
-- the driver union). A formal consultation object is required for pricing,
-- commission, deactivation-policy, safety-policy, and transition changes;
-- it cannot be activated until the response SLA has elapsed or every active
-- council member has responded.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.council_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  constituency text NOT NULL DEFAULT 'drivers',
  role text NOT NULL DEFAULT 'representative',
  active boolean NOT NULL DEFAULT true,
  appointed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS public.consultation_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL
    CHECK (kind IN ('pricing', 'commission', 'deactivation_policy', 'safety_policy', 'transition', 'other')),
  title text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed', 'activated', 'withdrawn')),
  posted_by bigint REFERENCES public.users(id) ON DELETE RESTRICT,
  response_sla_at timestamptz NOT NULL,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consultation_objects_status_kind_idx
  ON public.consultation_objects (status, kind);

CREATE TABLE IF NOT EXISTS public.consultation_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES public.consultation_objects(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.council_members(id) ON DELETE RESTRICT,
  stance text NOT NULL
    CHECK (stance IN ('support', 'object', 'comment')),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (consultation_id, member_id)
);
CREATE INDEX IF NOT EXISTS consultation_responses_consultation_idx
  ON public.consultation_responses (consultation_id);

