CREATE TABLE IF NOT EXISTS operator_security_sessions (
  id UUID PRIMARY KEY,
  operator_id INTEGER NOT NULL REFERENCES operator_credentials(id) ON DELETE CASCADE,
  session_hash CHAR(64) NOT NULL UNIQUE,
  auth_source VARCHAR(32) NOT NULL,
  mfa_authenticated BOOLEAN NOT NULL DEFAULT false,
  assurance_level VARCHAR(128),
  user_agent VARCHAR(512),
  ip_hash CHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS operator_security_sessions_operator_lookup
  ON operator_security_sessions (operator_id, revoked_at, expires_at DESC);
