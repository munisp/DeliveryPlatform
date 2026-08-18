CREATE TABLE IF NOT EXISTS tenant_admin_notification_preferences (
  tenant_id VARCHAR(128) NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  operator_id INTEGER NOT NULL REFERENCES operator_credentials(id) ON DELETE CASCADE,
  role_update_email BOOLEAN NOT NULL DEFAULT FALSE,
  preset_ownership_transfer_email BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, operator_id)
);

CREATE INDEX IF NOT EXISTS tenant_admin_notification_preferences_lookup
  ON tenant_admin_notification_preferences (tenant_id, operator_id);
