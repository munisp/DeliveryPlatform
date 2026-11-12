-- Growth tables promotion (P5-PILOT consumer-parity wave, lead-approved
-- migration exception per P5_SPEC.md "P5-PILOT").
--
-- Promotion rationale: the referral/loyalty/campaign engine in server/db.ts
-- (applyReferralCode :1672, completeReferral :1770, redeemPoints :1541,
-- loyalty account helpers, campaign CRUD :1851-1949, referral leaderboard
-- :2258-2450) is live production code, but the CREATE TABLE DDL for its nine
-- backing tables has ONLY ever existed in the dev bootstrap
-- scripts/init-local-postgres.sql. Fresh production deploys that run only
-- drizzle/ therefore never get these tables, and they retroactively miss:
--   * the 0093 performance indexes, which are guarded with
--     to_regclass()/pg_class EXISTS and so silently no-op'd when the tables
--     were absent (drizzle/0093_performance_indexes.sql:93-110);
--   * the 0103 PowerSync publication adds for the four loyalty tables, which
--     no-op'd for the same reason
--     (drizzle/0103_powersync_sync_support.sql:106-138). The five
--     referral/campaign tables were never published at all.
-- This migration promotes the dev-bootstrap DDL into the migration chain:
-- column definitions below are copied VERBATIM from
-- scripts/init-local-postgres.sql so dev and prod schemas converge.
--
-- Also promoted: users.referral_code / users.referred_by_code, which the
-- referral engine reads/writes (server/db.ts:1695,1733) but which likewise
-- only exist in the dev bootstrap (init-local-postgres.sql:1-2). The
-- users.phone column is NOT re-added here — 0005 already carries it.
--
-- The entire file is idempotent: every DDL statement is guarded
-- (IF NOT EXISTS, pg_publication_tables NOT EXISTS, pg_roles/pg_class
-- EXISTS), so a double-run is a no-op.

BEGIN;

-- users identity columns required by the referral engine (verbatim from
-- scripts/init-local-postgres.sql:1-2).
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_code VARCHAR(50);

CREATE TABLE IF NOT EXISTS loyalty_points (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  points_balance INTEGER NOT NULL DEFAULT 0,
  lifetime_points INTEGER NOT NULL DEFAULT 0,
  tier VARCHAR(32) NOT NULL DEFAULT 'bronze',
  tier_progress NUMERIC(10,2) NOT NULL DEFAULT 0,
  next_tier_threshold INTEGER NOT NULL DEFAULT 1000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_type VARCHAR(64) NOT NULL,
  points INTEGER NOT NULL,
  order_id INTEGER,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loyalty_rewards (
  id SERIAL PRIMARY KEY,
  reward_name VARCHAR(160) NOT NULL,
  description TEXT,
  points_cost INTEGER NOT NULL,
  points_required INTEGER NOT NULL,
  reward_type VARCHAR(64) NOT NULL,
  reward_value VARCHAR(160),
  min_tier VARCHAR(32),
  is_active BOOLEAN NOT NULL DEFAULT true,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loyalty_redemptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reward_id INTEGER NOT NULL REFERENCES loyalty_rewards(id) ON DELETE CASCADE,
  points_spent INTEGER NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'approved',
  voucher_code VARCHAR(255) NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_referrals (
  id SERIAL PRIMARY KEY,
  referrer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  referral_code VARCHAR(50) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  referrer_bonus_points INTEGER NOT NULL DEFAULT 500,
  referred_bonus_points INTEGER NOT NULL DEFAULT 200,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS referral_leaderboard_periods (
  id SERIAL PRIMARY KEY,
  period_name VARCHAR(32) NOT NULL UNIQUE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referral_leaderboard_entries (
  id SERIAL PRIMARY KEY,
  period_id INTEGER NOT NULL REFERENCES referral_leaderboard_periods(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referral_count INTEGER NOT NULL DEFAULT 0,
  successful_referrals INTEGER NOT NULL DEFAULT 0,
  points_earned INTEGER NOT NULL DEFAULT 0,
  rank INTEGER,
  reward_tier VARCHAR(32) NOT NULL DEFAULT 'none',
  reward_points INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(period_id, user_id)
);

CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id SERIAL PRIMARY KEY,
  campaign_name VARCHAR(255) NOT NULL,
  campaign_type VARCHAR(64) NOT NULL,
  email_template TEXT,
  sms_template TEXT,
  target_audience VARCHAR(64) NOT NULL DEFAULT 'all',
  trigger_condition JSONB,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  is_active BOOLEAN NOT NULL DEFAULT true,
  send_count INTEGER NOT NULL DEFAULT 0,
  open_count INTEGER NOT NULL DEFAULT 0,
  click_count INTEGER NOT NULL DEFAULT 0,
  open_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
  click_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
  budget NUMERIC(12,2) NOT NULL DEFAULT 0,
  spent NUMERIC(12,2) NOT NULL DEFAULT 0,
  channel VARCHAR(32) NOT NULL DEFAULT 'email',
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaign_variants (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  variant_name VARCHAR(160) NOT NULL,
  email_template TEXT,
  sms_template TEXT,
  traffic_allocation NUMERIC(10,2) NOT NULL DEFAULT 50,
  send_count INTEGER NOT NULL DEFAULT 0,
  open_count INTEGER NOT NULL DEFAULT 0,
  click_count INTEGER NOT NULL DEFAULT 0,
  conversion_count INTEGER NOT NULL DEFAULT 0,
  is_winner BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Re-issue the 0093 performance indexes. In 0093 they sit behind
-- to_regclass() guards (0093:100-108) and so no-op'd on fresh deploys where
-- these tables did not exist yet; the tables are guaranteed to exist from
-- this point in the chain, and CREATE INDEX IF NOT EXISTS keeps the
-- statements rerun-safe (identical index definitions as 0093).
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_user_created
  ON public.loyalty_transactions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_activity
  ON public.marketing_campaigns (updated_at DESC NULLS LAST, created_at DESC NULLS LAST);

-- Re-issue / issue the 0103-style PowerSync publication adds. The four
-- loyalty tables were already listed in 0103 but no-op'd on fresh deploys
-- (0103:106-138); the five referral/campaign tables are published here for
-- the first time. Guard mirrors 0103:122-128 exactly: pg_class EXISTS +
-- pg_publication_tables NOT EXISTS, so re-runs and deployments where the
-- publication already covers a table are no-ops.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'loyalty_points')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'powersync' AND schemaname = 'public' AND tablename = 'loyalty_points') THEN
    ALTER PUBLICATION powersync ADD TABLE public.loyalty_points;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'loyalty_transactions')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'powersync' AND schemaname = 'public' AND tablename = 'loyalty_transactions') THEN
    ALTER PUBLICATION powersync ADD TABLE public.loyalty_transactions;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'loyalty_rewards')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'powersync' AND schemaname = 'public' AND tablename = 'loyalty_rewards') THEN
    ALTER PUBLICATION powersync ADD TABLE public.loyalty_rewards;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'loyalty_redemptions')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'powersync' AND schemaname = 'public' AND tablename = 'loyalty_redemptions') THEN
    ALTER PUBLICATION powersync ADD TABLE public.loyalty_redemptions;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_referrals')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'powersync' AND schemaname = 'public' AND tablename = 'customer_referrals') THEN
    ALTER PUBLICATION powersync ADD TABLE public.customer_referrals;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'marketing_campaigns')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'powersync' AND schemaname = 'public' AND tablename = 'marketing_campaigns') THEN
    ALTER PUBLICATION powersync ADD TABLE public.marketing_campaigns;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'campaign_variants')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'powersync' AND schemaname = 'public' AND tablename = 'campaign_variants') THEN
    ALTER PUBLICATION powersync ADD TABLE public.campaign_variants;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'referral_leaderboard_entries')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'powersync' AND schemaname = 'public' AND tablename = 'referral_leaderboard_entries') THEN
    ALTER PUBLICATION powersync ADD TABLE public.referral_leaderboard_entries;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'referral_leaderboard_periods')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'powersync' AND schemaname = 'public' AND tablename = 'referral_leaderboard_periods') THEN
    ALTER PUBLICATION powersync ADD TABLE public.referral_leaderboard_periods;
  END IF;
END $$;

-- Read grants for the least-privilege PowerSync replication role, mirroring
-- the 0103 guard (role EXISTS + table EXISTS). The four loyalty tables were
-- in the 0103 grant list but no-op'd where the tables were absent; the five
-- referral/campaign tables are granted here so publishing them above does
-- not break the replication stream. GRANT is inherently rerun-safe.
DO $$
DECLARE
  v_table text;
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'powersync_replication') THEN
    FOREACH v_table IN ARRAY ARRAY[
      'loyalty_points', 'loyalty_transactions', 'loyalty_rewards',
      'loyalty_redemptions', 'customer_referrals', 'marketing_campaigns',
      'campaign_variants', 'referral_leaderboard_entries',
      'referral_leaderboard_periods'
    ] LOOP
      IF EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = v_table AND c.relkind IN ('r', 'p')
      ) THEN
        EXECUTE format('GRANT SELECT ON public.%I TO powersync_replication', v_table);
      END IF;
    END LOOP;
  END IF;
END $$;

COMMIT;
