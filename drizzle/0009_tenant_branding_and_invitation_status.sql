ALTER TABLE platform_tenants
  ADD COLUMN IF NOT EXISTS brand_logo_data_url TEXT,
  ADD COLUMN IF NOT EXISTS brand_primary_color CHAR(7) NOT NULL DEFAULT '#0ea5e9',
  ADD COLUMN IF NOT EXISTS brand_accent_color CHAR(7) NOT NULL DEFAULT '#0f172a',
  ADD COLUMN IF NOT EXISTS branding_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS account_lifecycle_invitation_tenant_status
  ON account_lifecycle_tokens (tenant_id, purpose, created_at DESC)
  WHERE purpose = 'invitation';
