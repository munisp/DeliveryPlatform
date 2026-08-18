ALTER TABLE account_lifecycle_tokens
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS tenant_branding_presets (
  id UUID PRIMARY KEY,
  tenant_id VARCHAR(128) NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  logo_data_url TEXT,
  primary_color CHAR(7) NOT NULL,
  accent_color CHAR(7) NOT NULL,
  created_by_operator_id INTEGER NOT NULL REFERENCES operator_credentials(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS account_lifecycle_invitation_revocation_lookup
  ON account_lifecycle_tokens (tenant_id, purpose, revoked_at, created_at DESC)
  WHERE purpose = 'invitation';
