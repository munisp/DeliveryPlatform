-- Settlement payout uniqueness: prevent double-payout of the same driver
-- settlement period under concurrent settlement-job retries/workers.
--
-- payout_settlements is provisioned outside the in-repo DDL (see the note on
-- the payoutSettlements definition in drizzle/schema.ts); this migration only
-- hardens the existing table.
--
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
