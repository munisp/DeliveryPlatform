-- Independently designed telematics device lifecycle and consent controls.
-- Device claims are durable; high-volume location events remain in mobility.driver_location_event.

CREATE SCHEMA IF NOT EXISTS telematics;
CREATE TYPE telematics.device_state AS ENUM ('pending', 'active', 'suspended', 'revoked');
CREATE TYPE telematics.attestation_state AS ENUM ('verified', 'failed', 'expired');
CREATE TYPE telematics.consent_state AS ENUM ('granted', 'withdrawn');
CREATE TYPE telematics.support_case_state AS ENUM ('open', 'investigating', 'resolved', 'closed');

CREATE TABLE telematics.driver_device (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_user_id BIGINT NOT NULL,
  device_public_id UUID NOT NULL UNIQUE,
  device_fingerprint_hash BYTEA NOT NULL CHECK (octet_length(device_fingerprint_hash) = 32),
  state telematics.device_state NOT NULL DEFAULT 'pending',
  last_attestation_state telematics.attestation_state NULL,
  last_attested_at TIMESTAMPTZ NULL,
  attestation_expires_at TIMESTAMPTZ NULL,
  activated_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (driver_user_id, device_fingerprint_hash),
  CHECK ((state = 'active') = (activated_at IS NOT NULL)),
  CHECK (attestation_expires_at IS NULL OR last_attested_at IS NOT NULL)
);
CREATE INDEX driver_device_active_idx ON telematics.driver_device (driver_user_id, state, attestation_expires_at DESC);

CREATE TABLE telematics.driver_location_consent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_user_id BIGINT NOT NULL,
  device_id UUID NULL REFERENCES telematics.driver_device(id) ON DELETE SET NULL,
  consent_version TEXT NOT NULL CHECK (length(consent_version) BETWEEN 1 AND 64),
  state telematics.consent_state NOT NULL,
  granted_at TIMESTAMPTZ NULL,
  withdrawn_at TIMESTAMPTZ NULL,
  evidence_ref TEXT NOT NULL CHECK (length(evidence_ref) BETWEEN 16 AND 256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((state = 'granted') = (granted_at IS NOT NULL)),
  CHECK ((state = 'withdrawn') = (withdrawn_at IS NOT NULL))
);
CREATE INDEX driver_location_consent_current_idx ON telematics.driver_location_consent (driver_user_id, created_at DESC);

CREATE TABLE telematics.device_attestation_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES telematics.driver_device(id) ON DELETE CASCADE,
  attestation_id TEXT NOT NULL CHECK (length(attestation_id) BETWEEN 16 AND 256),
  attestation_state telematics.attestation_state NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NULL,
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 80),
  claims_digest BYTEA NOT NULL CHECK (octet_length(claims_digest) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (device_id, attestation_id)
);
CREATE INDEX device_attestation_valid_idx ON telematics.device_attestation_event (device_id, attestation_state, expires_at DESC);

CREATE TABLE telematics.driver_device_support_case (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_user_id BIGINT NOT NULL,
  device_id UUID NULL REFERENCES telematics.driver_device(id) ON DELETE SET NULL,
  state telematics.support_case_state NOT NULL DEFAULT 'open',
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_.-]{2,95}$'),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  opened_by INTEGER NULL,
  resolved_by INTEGER NULL,
  resolved_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(evidence) = 'object')
);
CREATE INDEX driver_device_support_open_idx ON telematics.driver_device_support_case (driver_user_id, state, created_at DESC)
  WHERE state IN ('open', 'investigating');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'switchos_service') THEN
    GRANT USAGE ON SCHEMA telematics TO switchos_service;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA telematics TO switchos_service;
  END IF;
END;
$$;
