DROP INDEX IF EXISTS tenant_branding_presets_organization_sharing_lookup;

ALTER TABLE tenant_branding_presets
  DROP COLUMN IF EXISTS shared_at,
  DROP COLUMN IF EXISTS shared_by_operator_id,
  DROP COLUMN IF EXISTS organization_shared,
  DROP COLUMN IF EXISTS organization_id;
