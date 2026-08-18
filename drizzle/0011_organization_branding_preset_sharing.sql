ALTER TABLE tenant_branding_presets
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS organization_shared BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS shared_by_operator_id INTEGER REFERENCES operator_credentials(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS shared_at TIMESTAMPTZ;

UPDATE tenant_branding_presets preset
SET organization_id = tenant.organization_id
FROM platform_tenants tenant
WHERE preset.tenant_id = tenant.id
  AND preset.organization_id IS NULL;

ALTER TABLE tenant_branding_presets
  ALTER COLUMN organization_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS tenant_branding_presets_organization_sharing_lookup
  ON tenant_branding_presets (organization_id, shared_at DESC)
  WHERE organization_shared = TRUE;
