ALTER TABLE financial_admin_settings
  ADD COLUMN IF NOT EXISTS approved_webhook_hosts JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS financial_alert_delivery_receipts (
  id BIGSERIAL PRIMARY KEY,
  alert_id TEXT NOT NULL CHECK (char_length(alert_id) <= 160),
  webhook_host TEXT NOT NULL CHECK (char_length(webhook_host) <= 255),
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'failed')),
  detail TEXT CHECK (detail IS NULL OR char_length(detail) <= 500),
  routed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_financial_alert_delivery_receipts_alert
  ON financial_alert_delivery_receipts (alert_id, routed_at DESC);
