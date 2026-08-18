DROP INDEX IF EXISTS account_lifecycle_invitation_tenant_status;

ALTER TABLE platform_tenants
  DROP COLUMN IF EXISTS branding_updated_at,
  DROP COLUMN IF EXISTS brand_accent_color,
  DROP COLUMN IF EXISTS brand_primary_color,
  DROP COLUMN IF EXISTS brand_logo_data_url;
