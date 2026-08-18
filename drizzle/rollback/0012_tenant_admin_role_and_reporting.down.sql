DROP INDEX IF EXISTS tenant_branding_presets_owner_lookup;

ALTER TABLE tenant_branding_presets
  DROP COLUMN IF EXISTS ownership_transferred_at,
  DROP COLUMN IF EXISTS ownership_transferred_by_operator_id;
