CREATE TABLE tenant_branding_preset_ownership_audit (
  id UUID PRIMARY KEY,
  preset_id UUID NOT NULL,
  preset_name VARCHAR(80) NOT NULL,
  tenant_id VARCHAR(128) NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  from_operator_id INTEGER REFERENCES operator_credentials(id) ON DELETE SET NULL,
  to_operator_id INTEGER REFERENCES operator_credentials(id) ON DELETE SET NULL,
  transferred_by_operator_id INTEGER REFERENCES operator_credentials(id) ON DELETE SET NULL,
  transferred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX tenant_branding_preset_ownership_audit_lookup
  ON tenant_branding_preset_ownership_audit (tenant_id, transferred_at DESC);
