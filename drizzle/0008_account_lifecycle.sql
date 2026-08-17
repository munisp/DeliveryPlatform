-- Account lifecycle schema. Apply through the migration pipeline before production startup.
ALTER TABLE operator_credentials
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  slug VARCHAR(96) NOT NULL UNIQUE,
  created_by_operator_id INTEGER NOT NULL REFERENCES operator_credentials(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_tenants (
  id VARCHAR(128) PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  slug VARCHAR(96) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organization_memberships (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  operator_id INTEGER NOT NULL REFERENCES operator_credentials(id) ON DELETE CASCADE,
  role VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, operator_id)
);

CREATE TABLE IF NOT EXISTS account_lifecycle_tokens (
  id UUID PRIMARY KEY,
  purpose VARCHAR(32) NOT NULL CHECK (purpose IN ('email_verification', 'password_reset', 'invitation')),
  token_hash CHAR(64) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL,
  operator_id INTEGER REFERENCES operator_credentials(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id VARCHAR(128) REFERENCES platform_tenants(id) ON DELETE CASCADE,
  role VARCHAR(64),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_by_operator_id INTEGER REFERENCES operator_credentials(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS account_lifecycle_tokens_active_lookup
  ON account_lifecycle_tokens (purpose, email, expires_at)
  WHERE consumed_at IS NULL;
