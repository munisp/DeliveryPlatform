-- Pricing and dispatch runtime persistence plus indexes for live market-state reads.
CREATE TABLE IF NOT EXISTS pricing_engine_runs (
  id BIGSERIAL PRIMARY KEY,
  endpoint TEXT NOT NULL,
  request_json JSONB NOT NULL,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dispatch_optimizer_runs (
  id BIGSERIAL PRIMARY KEY,
  endpoint TEXT NOT NULL,
  order_id BIGINT,
  request_json JSONB NOT NULL,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS acceptance_rate NUMERIC(10,2) DEFAULT 80;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS completion_rate NUMERIC(10,2) DEFAULT 95;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS availability VARCHAR(32) DEFAULT 'available';
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS current_location TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS active_orders INTEGER NOT NULL DEFAULT 0;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS completed_deliveries INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_orders_active_status
  ON orders (status)
  WHERE status IN ('pending', 'confirmed', 'assigned', 'picked_up', 'in_transit');

CREATE INDEX IF NOT EXISTS idx_orders_dispatch_queue
  ON orders (status, updated_at DESC)
  WHERE status IN ('pending', 'confirmed', 'assigned');

CREATE INDEX IF NOT EXISTS idx_drivers_available_online
  ON drivers (status, availability)
  WHERE status = 'online' AND COALESCE(availability, 'available') = 'available';

CREATE INDEX IF NOT EXISTS idx_drivers_online_rank
  ON drivers ((rating::float8) DESC, completed_deliveries DESC)
  WHERE status = 'online';

CREATE INDEX IF NOT EXISTS idx_pricing_engine_runs_endpoint_created
  ON pricing_engine_runs (endpoint, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dispatch_optimizer_runs_endpoint_created
  ON dispatch_optimizer_runs (endpoint, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dispatch_optimizer_runs_order_created
  ON dispatch_optimizer_runs (order_id, created_at DESC)
  WHERE order_id IS NOT NULL;
