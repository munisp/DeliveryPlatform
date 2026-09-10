-- Partition-aware TigerBeetle dispatch support.
-- This is additive: the existing token-fenced claim and one-debit-stream ordering
-- checks remain the financial authority. The index helps independent worker lanes
-- find ready debit partitions without scanning completed or non-ledger outbox rows.

CREATE INDEX IF NOT EXISTS idx_mojaloop_funds_outbox_tigerbeetle_lane_ready
  ON mojaloop_funds_outbox (ledger_debit_fsp, next_attempt_at, id)
  WHERE destination = 'tigerbeetle'
    AND workflow_type = 'transfer'
    AND status = 'pending';

CREATE INDEX IF NOT EXISTS idx_mojaloop_funds_outbox_tigerbeetle_lane_reclaim
  ON mojaloop_funds_outbox (ledger_debit_fsp, claim_expires_at, id)
  WHERE destination = 'tigerbeetle'
    AND workflow_type = 'transfer'
    AND status = 'processing';

-- Version 9 requires 0055's claim-token/debit-key contract plus the partition
-- lane indexes. No balance or workflow state is rewritten by this migration.
INSERT INTO platform_schema_contracts (component, version)
VALUES ('mojaloop_funds', 9)
ON CONFLICT (component) DO UPDATE
SET version = GREATEST(platform_schema_contracts.version, EXCLUDED.version),
    applied_at = NOW();
