-- Performance hot-path indexes (performance audit findings 6, 11, 14, 19).
--
-- Targets (evidence: /perf-audit.md "Recommended migration 0093"):
--   * orders(created_at DESC)          — getOrderRevenueTrend 6-month range
--     scan (server/db.ts getOrderRevenueTrend); no orders created_at index
--     existed (0025 only covers dispatch status states).
--   * orders(vertical_id) partial      — getOrdersByVertical GROUP BY with
--     status NOT IN ('cancelled','refunded').
--   * transactions(type,status) INCLUDE(amount) — funds reconciliation
--     FILTER sums (getFundsReconciliationSnapshot).
--   * payout_settlements(status) INCLUDE(total_amount) — same snapshot leg.
--   * driver_incentives(status) WHERE settlement_id IS NULL — unsettled
--     incentive aggregate + settlement claim UPDATE (server/db.ts).
--   * support_tickets(status, priority) — open/critical dispute counts.
--   * mojaloop_transfers(state) — SETTLED count subquery in the snapshot's
--     mojaloop leg.
--   * verification.outbox_event unconsumed partial — restated from
--     drizzle/0092 (created_at WHERE consumed_at IS NULL) so the reviewed
--     index set is declared in one place; IF NOT EXISTS makes it a no-op.
--     NOTE: an index on (consumed_at) itself would be useless under the
--     `WHERE consumed_at IS NULL` predicate (all indexed rows are NULL), so
--     the (created_at) ordering index is the correct shape for the sweep's
--     ORDER BY created_at claim (server/_core/scheduledJobs.ts).
--   * verification.verification_case(state, updated_at) partial — SLA sweep
--     WHERE state = 'manual_review' ORDER BY updated_at.
--   * users(lower(email)) — resolvePublicUser email UNION leg
--     (server/_core/publicUsers.ts).
--   * loyalty_transactions(user_id, created_at DESC) — expirePointsJob
--     LEFT JOIN + MAX(created_at) (server/_core/scheduledJobs.ts).
--   * marketing_campaigns(updated_at DESC NULLS LAST, created_at DESC NULLS
--     LAST) — commerceSummaries campaign list ordering.
--   * operational_events(created_at DESC) — already created by
--     drizzle/0004_platform_integration_audit.sql and by ensureTables
--     (server/_core/operationalEvents.ts); restated here (IF NOT EXISTS
--     no-op) so prod receives it deterministically through reviewed
--     migrations only.
--
-- driver_incentives / loyalty_transactions / marketing_campaigns have no
-- in-repo migration DDL (DDL authority: scripts/init-local-postgres.sql or
-- external provisioning), so those indexes are wrapped in to_regclass
-- guards: the migration stays replay-safe on environments where the table
-- is absent, and applies the index wherever it exists.
--
-- All statements are idempotent (IF NOT EXISTS / guarded). Plain CREATE
-- INDEX (not CONCURRENTLY) keeps the migration transactional like the
-- surrounding 00xx migrations; the target tables are small-to-medium today
-- and the locks are brief.

BEGIN;

-- orders: revenue trend range scans + by-vertical grouping.
CREATE INDEX IF NOT EXISTS idx_orders_created_at_desc
  ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_vertical_active
  ON orders (vertical_id)
  WHERE status NOT IN ('cancelled', 'refunded');

-- transactions: reconciliation FILTER sums by (type, status).
CREATE INDEX IF NOT EXISTS idx_transactions_type_status_amount
  ON transactions (type, status) INCLUDE (amount);

-- payout_settlements: reconciliation FILTER sums by status.
CREATE INDEX IF NOT EXISTS idx_payout_settlements_status_amount
  ON public.payout_settlements (status) INCLUDE (total_amount);

-- support_tickets: open/critical dispute counts.
CREATE INDEX IF NOT EXISTS idx_support_tickets_status_priority
  ON support_tickets (status, priority);

-- mojaloop_transfers: SETTLED count subquery.
CREATE INDEX IF NOT EXISTS idx_mojaloop_transfers_state
  ON mojaloop_transfers (state);

-- verification outbox sweep claim (restated from 0092; no-op there).
CREATE INDEX IF NOT EXISTS verification_outbox_unconsumed_idx
  ON verification.outbox_event (created_at) WHERE consumed_at IS NULL;

-- verification SLA sweep: manual_review aging ordered by updated_at.
CREATE INDEX IF NOT EXISTS verification_case_manual_review_sla_idx
  ON verification.verification_case (state, updated_at)
  WHERE state = 'manual_review';

-- users: case-insensitive email lookup leg of resolvePublicUser.
CREATE INDEX IF NOT EXISTS idx_users_lower_email
  ON users (lower(email));

-- operational_events: ported from 0004/ensureTables (no-op where present).
CREATE INDEX IF NOT EXISTS idx_operational_events_created_at
  ON operational_events (created_at DESC);

-- Tables without in-repo migration DDL: guard on existence.
DO $$
BEGIN
  IF to_regclass('public.driver_incentives') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_driver_incentives_unsettled_status
      ON public.driver_incentives (status) WHERE settlement_id IS NULL;
  END IF;
  IF to_regclass('public.loyalty_transactions') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_user_created
      ON public.loyalty_transactions (user_id, created_at DESC);
  END IF;
  IF to_regclass('public.marketing_campaigns') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_activity
      ON public.marketing_campaigns (updated_at DESC NULLS LAST, created_at DESC NULLS LAST);
  END IF;
END $$;

COMMIT;
