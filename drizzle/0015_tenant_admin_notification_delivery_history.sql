CREATE TABLE IF NOT EXISTS tenant_admin_notification_delivery_history (
  id UUID PRIMARY KEY,
  tenant_id VARCHAR(128) NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  recipient_operator_id INTEGER REFERENCES operator_credentials(id) ON DELETE SET NULL,
  notification_type VARCHAR(64) NOT NULL CHECK (notification_type IN ('role_update', 'preset_ownership_transfer')),
  subject VARCHAR(180) NOT NULL,
  delivery_status VARCHAR(16) NOT NULL CHECK (delivery_status IN ('delivered', 'failed')),
  dispatch_request_id VARCHAR(128),
  provider VARCHAR(128),
  provider_message_id VARCHAR(255),
  failure_code VARCHAR(128),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tenant_admin_notification_delivery_history_lookup
  ON tenant_admin_notification_delivery_history (tenant_id, sent_at DESC);
