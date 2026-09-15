-- Two-sided integrity incentives (R10). Rider and driver streaks keyed to
-- verified completion telemetry make fraud structurally expensive and honesty
-- structurally rewarded. Reward rules are published (listable by any
-- authenticated user) so there is no global bonus whiplash.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.integrity_streaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('rider', 'driver')),
  current_streak integer NOT NULL DEFAULT 0,
  longest_streak integer NOT NULL DEFAULT 0,
  last_event_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

CREATE TABLE IF NOT EXISTS public.integrity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('rider', 'driver')),
  event_type text NOT NULL CHECK (event_type IN (
    'verified_manifest',
    'verified_completion',
    'violation',
    'streak_reset',
    'reward_granted'
  )),
  trip_id bigint,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integrity_events_user_role_created_idx
  ON public.integrity_events (user_id, role, created_at);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'integrity_events_idempotency_idx'
  ) THEN
    CREATE UNIQUE INDEX integrity_events_idempotency_idx
      ON public.integrity_events (user_id, role, (detail ->> 'idempotency_key'))
      WHERE detail ->> 'idempotency_key' IS NOT NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.integrity_reward_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role text NOT NULL CHECK (role IN ('rider', 'driver')),
  rule_key text NOT NULL,
  threshold_streak integer NOT NULL CHECK (threshold_streak > 0),
  reward_type text NOT NULL CHECK (reward_type IN ('credit', 'badge', 'priority')),
  amount_minor bigint,
  currency text NOT NULL DEFAULT 'NGN',
  active boolean NOT NULL DEFAULT true,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role, rule_key),
  CHECK (reward_type != 'credit' OR amount_minor IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.integrity_rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  rule_id uuid NOT NULL REFERENCES public.integrity_reward_rules(id) ON DELETE RESTRICT,
  amount_minor bigint,
  currency text NOT NULL DEFAULT 'NGN',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'granted', 'revoked')),
  idempotency_key text UNIQUE,
  granted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integrity_rewards_user_idx
  ON public.integrity_rewards (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS integrity_rewards_status_idx
  ON public.integrity_rewards (status);
