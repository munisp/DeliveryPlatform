CREATE TABLE IF NOT EXISTS financial_admin_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  auto_escalation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  auto_escalation_minutes INTEGER NOT NULL DEFAULT 60 CHECK (auto_escalation_minutes BETWEEN 5 AND 10080),
  on_call_webhooks JSONB NOT NULL DEFAULT '[]'::jsonb,
  health_retention_days INTEGER NOT NULL DEFAULT 30 CHECK (health_retention_days BETWEEN 1 AND 365),
  updated_by_operator_id BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO financial_admin_settings (singleton) VALUES (TRUE) ON CONFLICT (singleton) DO NOTHING;
