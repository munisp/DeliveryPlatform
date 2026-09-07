-- Operator credentials must exist before account-lifecycle and tenant migrations.
CREATE TABLE IF NOT EXISTS operator_credentials (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(64) NOT NULL DEFAULT 'operator',
  tenant_id VARCHAR(128),
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
