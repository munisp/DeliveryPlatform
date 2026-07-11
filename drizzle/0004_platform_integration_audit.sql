CREATE TABLE IF NOT EXISTS operational_events (
  id BIGSERIAL PRIMARY KEY,
  event_type VARCHAR(128) NOT NULL,
  actor_id VARCHAR(128),
  actor_role VARCHAR(64),
  tenant_id VARCHAR(128),
  route VARCHAR(255),
  outcome VARCHAR(32) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operational_events_event_type
  ON operational_events(event_type);

CREATE INDEX IF NOT EXISTS idx_operational_events_created_at
  ON operational_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operational_events_tenant_id
  ON operational_events(tenant_id);
