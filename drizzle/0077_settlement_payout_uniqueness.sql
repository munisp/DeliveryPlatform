-- Settlement payout uniqueness: prevent double-payout of the same driver
-- settlement period under concurrent settlement-job retries/workers.
--
-- payout_settlements previously had no in-repo DDL (only the ORM model in
-- drizzle/schema.ts), which broke fresh deploys. This migration therefore
-- creates the table idempotently (columns mirror drizzle/schema.ts
-- payoutSettlements) before hardening it; on environments where the table
-- was provisioned externally the CREATE is a no-op and only the dedupe +
-- unique index apply.
--
CREATE TABLE IF NOT EXISTS public.payout_settlements (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL,
  period_start TIMESTAMP NOT NULL,
  period_end TIMESTAMP NOT NULL,
  base_earnings NUMERIC(12,2) NOT NULL DEFAULT '0',
  bonus_amount NUMERIC(12,2) NOT NULL DEFAULT '0',
  total_amount NUMERIC(12,2) NOT NULL DEFAULT '0',
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  approved_by INTEGER,
  approved_at TIMESTAMP,
  processed_at TIMESTAMP,
  payment_method VARCHAR(64),
  payment_reference VARCHAR(160),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

-- 1) Defensive dedupe: if historical duplicates for the same
--    (driver_id, period_start, period_end) window exist, keep the oldest row
--    (lowest id) and remove the rest. On the expected empty/dev-scale table
--    this is a no-op scan. It runs inside the migration transaction and takes
--    a brief table lock, which is acceptable here because the table is small
--    and this is a one-time append-only migration; for a large production
--    table the dedupe would be batched and the index built CONCURRENTLY
--    outside a transaction instead.
-- 2) Unique index enforcing one settlement row per driver + period window.
--    Writers use INSERT ... ON CONFLICT DO NOTHING and treat a zero-row
--    insert as "already settled" (idempotent retry), skipping the payout leg.

BEGIN;

DELETE FROM public.payout_settlements a
USING public.payout_settlements b
WHERE a.driver_id = b.driver_id
  AND a.period_start = b.period_start
  AND a.period_end = b.period_end
  AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS payout_settlements_driver_period_unique
  ON public.payout_settlements (driver_id, period_start, period_end);

COMMENT ON INDEX public.payout_settlements_driver_period_unique IS
  'Exactly one settlement per driver and [period_start, period_end) window; settlement generation inserts with ON CONFLICT DO NOTHING and skips the payout leg on conflict.';

COMMIT;
