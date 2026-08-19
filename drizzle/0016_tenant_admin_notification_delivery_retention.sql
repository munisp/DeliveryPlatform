CREATE TABLE IF NOT EXISTS tenant_admin_notification_delivery_retention (
  tenant_id VARCHAR(128) PRIMARY KEY REFERENCES platform_tenants(id) ON DELETE CASCADE,
  retention_days INTEGER NOT NULL CHECK (retention_days IN (30, 90, 180, 365)),
  updated_by_operator_id INTEGER REFERENCES operator_credentials(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
