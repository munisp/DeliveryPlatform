-- Independently designed partner/API integration controls.
-- API secrets are returned once at issuance and stored only as salted KDF digests.

CREATE SCHEMA IF NOT EXISTS integration;
CREATE TYPE integration.client_state AS ENUM ('active', 'suspended', 'revoked');
CREATE TYPE integration.inbound_event_state AS ENUM ('received', 'processing', 'accepted', 'rejected', 'dead_letter');

CREATE TABLE integration.client_application (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
  client_state integration.client_state NOT NULL DEFAULT 'active',
  allowed_scopes TEXT[] NOT NULL CHECK (cardinality(allowed_scopes) BETWEEN 1 AND 24),
  callback_secret_ref TEXT NULL CHECK (callback_secret_ref IS NULL OR length(callback_secret_ref) BETWEEN 8 AND 160),
  created_by INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX client_application_tenant_state_idx ON integration.client_application (tenant_id, client_state, created_at DESC);

CREATE TABLE integration.api_credential (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_application_id UUID NOT NULL REFERENCES integration.client_application(id) ON DELETE CASCADE,
  credential_prefix TEXT NOT NULL UNIQUE CHECK (credential_prefix ~ '^ops_[A-Za-z0-9]{12}$'),
  secret_salt BYTEA NOT NULL CHECK (octet_length(secret_salt) = 16),
  secret_digest BYTEA NOT NULL CHECK (octet_length(secret_digest) = 32),
  scopes TEXT[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 24),
  not_before TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  last_used_at TIMESTAMPTZ NULL,
  created_by INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at IS NULL OR expires_at > not_before)
);
CREATE INDEX api_credential_lookup_idx ON integration.api_credential (credential_prefix)
  WHERE revoked_at IS NULL;

CREATE TABLE integration.inbound_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_application_id UUID NOT NULL REFERENCES integration.client_application(id) ON DELETE RESTRICT,
  credential_id UUID NOT NULL REFERENCES integration.api_credential(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.-]{2,95}$'),
  external_event_id TEXT NOT NULL CHECK (length(external_event_id) BETWEEN 8 AND 160),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload_digest BYTEA NOT NULL CHECK (octet_length(payload_digest) = 32),
  payload JSONB NOT NULL,
  signature_version TEXT NOT NULL CHECK (signature_version IN ('hmac-sha256-v1')),
  state integration.inbound_event_state NOT NULL DEFAULT 'received',
  rejection_code TEXT NULL,
  processed_at TIMESTAMPTZ NULL,
  correlation_id UUID NOT NULL DEFAULT gen_random_uuid(),
  UNIQUE (client_application_id, external_event_id),
  CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX inbound_event_pending_idx ON integration.inbound_event (state, received_at)
  WHERE state IN ('received', 'processing');

CREATE TABLE integration.inbound_event_delivery (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_event_id UUID NOT NULL REFERENCES integration.inbound_event(id) ON DELETE CASCADE,
  target TEXT NOT NULL CHECK (target IN ('operations_work_order', 'tracking_position', 'partner_review')),
  state integration.inbound_event_state NOT NULL DEFAULT 'received',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (inbound_event_id, target)
);
CREATE INDEX inbound_event_delivery_due_idx ON integration.inbound_event_delivery (next_attempt_at, created_at)
  WHERE state IN ('received', 'processing');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'switchos_service') THEN
    GRANT USAGE ON SCHEMA integration TO switchos_service;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA integration TO switchos_service;
  END IF;
END;
$$;
