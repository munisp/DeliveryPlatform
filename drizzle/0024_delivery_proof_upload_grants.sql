CREATE TABLE IF NOT EXISTS delivery_proof_upload_grants (
  id UUID PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  tenant_id BIGINT NOT NULL,
  driver_operator_id BIGINT NOT NULL,
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  max_bytes BIGINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, object_key),
  CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  CHECK (max_bytes BETWEEN 1 AND 10485760)
);
CREATE INDEX IF NOT EXISTS delivery_proof_upload_grants_lookup_idx ON delivery_proof_upload_grants (tenant_id, driver_operator_id, expires_at);
