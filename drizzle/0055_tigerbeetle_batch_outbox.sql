-- Token-fenced, account-order-aware multi-transfer dispatch for TigerBeetle.
-- This migration is additive and must be deployed before the batch-aware Go worker.

ALTER TABLE mojaloop_funds_outbox
  ADD COLUMN IF NOT EXISTS ledger_debit_fsp TEXT,
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;

-- The current outbox constraint permits failed terminal records. Retain it and
-- add the explicit dead-letter terminal state for exhausted batch-dispatch rows.
ALTER TABLE mojaloop_funds_outbox
  DROP CONSTRAINT IF EXISTS mojaloop_funds_outbox_status_check;

ALTER TABLE mojaloop_funds_outbox
  ADD CONSTRAINT mojaloop_funds_outbox_status_check
  CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'dead_letter'));

-- Existing TigerBeetle entries can be backfilled from their persisted payload.
-- Transfer debits payer_fsp; refund reversals debit payee_fsp.
UPDATE mojaloop_funds_outbox
SET ledger_debit_fsp = CASE
  WHEN workflow_type = 'transfer' THEN payload ->> 'payerFsp'
  WHEN workflow_type = 'refund' THEN payload ->> 'payeeFsp'
END
WHERE destination = 'tigerbeetle'
  AND ledger_debit_fsp IS NULL;

ALTER TABLE mojaloop_funds_outbox
  ADD CONSTRAINT mojaloop_funds_outbox_tigerbeetle_debit_key
  CHECK (destination <> 'tigerbeetle' OR ledger_debit_fsp IS NOT NULL) NOT VALID;

ALTER TABLE mojaloop_funds_outbox
  VALIDATE CONSTRAINT mojaloop_funds_outbox_tigerbeetle_debit_key;

ALTER TABLE mojaloop_funds_outbox
  ADD CONSTRAINT mojaloop_funds_outbox_claim_pair
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)) NOT VALID;

ALTER TABLE mojaloop_funds_outbox
  VALIDATE CONSTRAINT mojaloop_funds_outbox_claim_pair;

-- The generic outbox index remains for non-ledger destinations. This partial
-- index only contains rows that the TigerBeetle transfer batcher can claim.
CREATE INDEX IF NOT EXISTS idx_mojaloop_funds_outbox_tigerbeetle_batch_pending
  ON mojaloop_funds_outbox (next_attempt_at, ledger_debit_fsp, id)
  WHERE destination = 'tigerbeetle'
    AND workflow_type = 'transfer'
    AND status = 'pending';

CREATE INDEX IF NOT EXISTS idx_mojaloop_funds_outbox_tigerbeetle_batch_expired
  ON mojaloop_funds_outbox (claim_expires_at, ledger_debit_fsp, id)
  WHERE destination = 'tigerbeetle'
    AND workflow_type = 'transfer'
    AND status = 'processing';

-- Batch-aware service startup must prove the new contract is present.
INSERT INTO platform_schema_contracts (component, version)
VALUES ('mojaloop_funds', 8)
ON CONFLICT (component) DO UPDATE
SET version = GREATEST(platform_schema_contracts.version, EXCLUDED.version),
    applied_at = NOW();
