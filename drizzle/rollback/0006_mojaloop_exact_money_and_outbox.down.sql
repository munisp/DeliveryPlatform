DROP TABLE IF EXISTS mojaloop_funds_outbox;

ALTER TABLE mojaloop_reconciliation_audits
  DROP CONSTRAINT IF EXISTS mojaloop_reconciliation_audits_refunded_minor_nonnegative,
  DROP CONSTRAINT IF EXISTS mojaloop_reconciliation_audits_net_minor_nonnegative,
  DROP COLUMN IF EXISTS platform_refunded_minor,
  DROP COLUMN IF EXISTS platform_net_settled_minor;

ALTER TABLE mojaloop_refunds
  DROP CONSTRAINT IF EXISTS mojaloop_refunds_amount_minor_nonnegative,
  DROP COLUMN IF EXISTS amount_minor;

ALTER TABLE mojaloop_quotes
  DROP CONSTRAINT IF EXISTS mojaloop_quotes_amount_minor_nonnegative,
  DROP CONSTRAINT IF EXISTS mojaloop_quotes_fees_minor_nonnegative,
  DROP COLUMN IF EXISTS amount_minor,
  DROP COLUMN IF EXISTS fees_minor;

ALTER TABLE mojaloop_transfers
  DROP CONSTRAINT IF EXISTS mojaloop_transfers_amount_minor_nonnegative,
  DROP COLUMN IF EXISTS amount_minor;
