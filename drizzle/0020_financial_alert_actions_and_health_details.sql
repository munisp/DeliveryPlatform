ALTER TABLE financial_dependency_health_observations
  ADD COLUMN IF NOT EXISTS detail TEXT;

CREATE TABLE IF NOT EXISTS financial_admin_alert_actions (
  id BIGSERIAL PRIMARY KEY,
  alert_id TEXT NOT NULL CHECK (char_length(alert_id) <= 160),
  action TEXT NOT NULL CHECK (action IN ('acknowledge', 'dismiss', 'note')),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  actor_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_financial_admin_alert_actions_latest
  ON financial_admin_alert_actions (alert_id, created_at DESC);
