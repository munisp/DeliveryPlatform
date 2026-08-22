CREATE TABLE IF NOT EXISTS delivery_tracking_events (
  id BIGSERIAL PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  tenant_id BIGINT NOT NULL,
  driver_operator_id BIGINT NOT NULL,
  latitude NUMERIC(9,6) NOT NULL,
  longitude NUMERIC(9,6) NOT NULL,
  accuracy_meters NUMERIC(8,2),
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (latitude BETWEEN -90 AND 90),
  CHECK (longitude BETWEEN -180 AND 180),
  CHECK (accuracy_meters IS NULL OR accuracy_meters BETWEEN 0 AND 10000)
);
CREATE INDEX IF NOT EXISTS delivery_tracking_events_latest_idx ON delivery_tracking_events (tenant_id, delivery_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS delivery_proofs (
  id BIGSERIAL PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  tenant_id BIGINT NOT NULL,
  driver_operator_id BIGINT NOT NULL,
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  sha256_hex CHAR(64) NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, delivery_id, object_key),
  CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  CHECK (sha256_hex ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS delivery_proofs_latest_idx ON delivery_proofs (tenant_id, delivery_id, submitted_at DESC);
