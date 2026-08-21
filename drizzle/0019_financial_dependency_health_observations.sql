CREATE TABLE IF NOT EXISTS financial_dependency_health_observations (
  id BIGSERIAL PRIMARY KEY,
  dependency TEXT NOT NULL CHECK (dependency IN ('tigerbeetle', 'temporal')),
  status TEXT NOT NULL CHECK (status IN ('reachable', 'unhealthy', 'unreachable', 'unconfigured')),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_financial_dependency_health_recent
  ON financial_dependency_health_observations (dependency, observed_at DESC);
