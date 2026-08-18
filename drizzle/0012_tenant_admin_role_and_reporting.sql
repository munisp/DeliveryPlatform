ALTER TABLE tenant_branding_presets
  ADD COLUMN IF NOT EXISTS ownership_transferred_by_operator_id INTEGER REFERENCES operator_credentials(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ownership_transferred_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS tenant_branding_presets_owner_lookup
  ON tenant_branding_presets (tenant_id, created_by_operator_id, updated_at DESC);
