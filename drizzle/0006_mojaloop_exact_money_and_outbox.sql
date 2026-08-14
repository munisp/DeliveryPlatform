-- Exact minor-unit monetary storage and durable funds side-effect intents.
-- This migration is additive so a controlled rollback can preserve legacy decimal columns.

CREATE TABLE IF NOT EXISTS mojaloop_transfers (
  transfer_id TEXT PRIMARY KEY,
  payer_fsp TEXT NOT NULL,
  payee_fsp TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  currency TEXT NOT NULL,
  ilp_packet TEXT NOT NULL,
  condition TEXT NOT NULL,
  expiration TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL,
  completed_time TIMESTAMPTZ,
  fulfilment_value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mojaloop_quotes (
  quote_id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  payer_fsp TEXT NOT NULL,
  payee_fsp TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  currency TEXT NOT NULL,
  fees NUMERIC(18,2) NOT NULL,
  expiration TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mojaloop_refunds (
  refund_id TEXT PRIMARY KEY,
  original_transfer_id TEXT NOT NULL,
  payer_fsp TEXT NOT NULL,
  payee_fsp TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  currency TEXT NOT NULL,
  reason TEXT,
  state TEXT NOT NULL,
  completed_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mojaloop_reconciliation_audits (
  id BIGSERIAL PRIMARY KEY,
  transfer_id TEXT NOT NULL,
  transfer_state TEXT NOT NULL,
  ledger_consistent BOOLEAN NOT NULL,
  platform_refunded_amount NUMERIC(18,2) NOT NULL,
  platform_net_settled_amount NUMERIC(18,2) NOT NULL,
  details JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mojaloop_workflows (
  workflow_id TEXT PRIMARY KEY,
  workflow_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  current_step TEXT NOT NULL,
  status TEXT NOT NULL,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mojaloop_workflow_events (
  id BIGSERIAL PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mojaloop_workflow_events_workflow_id
  ON mojaloop_workflow_events (workflow_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mojaloop_workflow_orchestration (
  id BIGSERIAL PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  orchestrator TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mojaloop_workflow_orchestration_workflow
  ON mojaloop_workflow_orchestration (workflow_id, created_at DESC);

ALTER TABLE mojaloop_transfers
  ADD COLUMN IF NOT EXISTS amount_minor BIGINT;

ALTER TABLE mojaloop_quotes
  ADD COLUMN IF NOT EXISTS amount_minor BIGINT,
  ADD COLUMN IF NOT EXISTS fees_minor BIGINT;

ALTER TABLE mojaloop_refunds
  ADD COLUMN IF NOT EXISTS amount_minor BIGINT;

ALTER TABLE mojaloop_reconciliation_audits
  ADD COLUMN IF NOT EXISTS platform_refunded_minor BIGINT,
  ADD COLUMN IF NOT EXISTS platform_net_settled_minor BIGINT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM mojaloop_transfers
    WHERE amount < 0 OR amount * 100 <> trunc(amount * 100)
  ) OR EXISTS (
    SELECT 1 FROM mojaloop_quotes
    WHERE amount < 0 OR fees < 0
       OR amount * 100 <> trunc(amount * 100)
       OR fees * 100 <> trunc(fees * 100)
  ) OR EXISTS (
    SELECT 1 FROM mojaloop_refunds
    WHERE amount < 0 OR amount * 100 <> trunc(amount * 100)
  ) OR EXISTS (
    SELECT 1 FROM mojaloop_reconciliation_audits
    WHERE platform_refunded_amount < 0 OR platform_net_settled_amount < 0
       OR platform_refunded_amount * 100 <> trunc(platform_refunded_amount * 100)
       OR platform_net_settled_amount * 100 <> trunc(platform_net_settled_amount * 100)
  ) THEN
    RAISE EXCEPTION 'Cannot backfill Mojaloop minor units: legacy amounts are negative or not representable at two decimal places';
  END IF;
END $$;

UPDATE mojaloop_transfers
SET amount_minor = (amount * 100)::BIGINT
WHERE amount_minor IS NULL;

UPDATE mojaloop_quotes
SET amount_minor = (amount * 100)::BIGINT,
    fees_minor = (fees * 100)::BIGINT
WHERE amount_minor IS NULL OR fees_minor IS NULL;

UPDATE mojaloop_refunds
SET amount_minor = (amount * 100)::BIGINT
WHERE amount_minor IS NULL;

UPDATE mojaloop_reconciliation_audits
SET platform_refunded_minor = (platform_refunded_amount * 100)::BIGINT,
    platform_net_settled_minor = (platform_net_settled_amount * 100)::BIGINT
WHERE platform_refunded_minor IS NULL OR platform_net_settled_minor IS NULL;

ALTER TABLE mojaloop_transfers ALTER COLUMN amount_minor SET NOT NULL;
ALTER TABLE mojaloop_quotes ALTER COLUMN amount_minor SET NOT NULL, ALTER COLUMN fees_minor SET NOT NULL;
ALTER TABLE mojaloop_refunds ALTER COLUMN amount_minor SET NOT NULL;
ALTER TABLE mojaloop_reconciliation_audits ALTER COLUMN platform_refunded_minor SET NOT NULL, ALTER COLUMN platform_net_settled_minor SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mojaloop_transfers_amount_minor_nonnegative') THEN
    ALTER TABLE mojaloop_transfers ADD CONSTRAINT mojaloop_transfers_amount_minor_nonnegative CHECK (amount_minor >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mojaloop_quotes_amount_minor_nonnegative') THEN
    ALTER TABLE mojaloop_quotes ADD CONSTRAINT mojaloop_quotes_amount_minor_nonnegative CHECK (amount_minor >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mojaloop_quotes_fees_minor_nonnegative') THEN
    ALTER TABLE mojaloop_quotes ADD CONSTRAINT mojaloop_quotes_fees_minor_nonnegative CHECK (fees_minor >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mojaloop_refunds_amount_minor_nonnegative') THEN
    ALTER TABLE mojaloop_refunds ADD CONSTRAINT mojaloop_refunds_amount_minor_nonnegative CHECK (amount_minor >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mojaloop_reconciliation_audits_refunded_minor_nonnegative') THEN
    ALTER TABLE mojaloop_reconciliation_audits ADD CONSTRAINT mojaloop_reconciliation_audits_refunded_minor_nonnegative CHECK (platform_refunded_minor >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mojaloop_reconciliation_audits_net_minor_nonnegative') THEN
    ALTER TABLE mojaloop_reconciliation_audits ADD CONSTRAINT mojaloop_reconciliation_audits_net_minor_nonnegative CHECK (platform_net_settled_minor >= 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS mojaloop_funds_outbox (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  step TEXT NOT NULL,
  workflow_status TEXT NOT NULL,
  payload JSONB NOT NULL,
  dispatch_order SMALLINT NOT NULL DEFAULT 20 CHECK (dispatch_order > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  delivered_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (destination, idempotency_key)
);

ALTER TABLE mojaloop_funds_outbox
  ADD COLUMN IF NOT EXISTS dispatch_order SMALLINT NOT NULL DEFAULT 20 CHECK (dispatch_order > 0);

DROP INDEX IF EXISTS idx_mojaloop_funds_outbox_dispatch;
CREATE INDEX IF NOT EXISTS idx_mojaloop_funds_outbox_dispatch
  ON mojaloop_funds_outbox (status, next_attempt_at, dispatch_order, id);

CREATE INDEX IF NOT EXISTS idx_mojaloop_funds_outbox_workflow
  ON mojaloop_funds_outbox (workflow_id, destination, created_at DESC);
