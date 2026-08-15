-- Mojaloop runtime must verify this migration-owned contract rather than create business tables at startup.

CREATE TABLE IF NOT EXISTS mojaloop_idempotency_keys (
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  resource_id TEXT,
  status TEXT NOT NULL,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS platform_schema_contracts (
  component TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platform_schema_contracts (component, version)
VALUES ('mojaloop_funds', 7)
ON CONFLICT (component) DO UPDATE
SET version = GREATEST(platform_schema_contracts.version, EXCLUDED.version),
    applied_at = NOW();
