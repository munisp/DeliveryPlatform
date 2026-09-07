-- Durable, independently designed real-time surge pricing and commission allocation.
-- Monetary values are integer kobo; rate values are basis points. PostgreSQL remains
-- authoritative. In-memory service state may only cache active policy versions.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS pricing;

CREATE TYPE pricing.quote_state AS ENUM ('quoted', 'accepted', 'expired', 'cancelled');
CREATE TYPE pricing.allocation_kind AS ENUM ('driver_earnings', 'platform_commission', 'tax_and_statutory', 'provider_fee', 'rider_tip');

CREATE TABLE pricing.surge_policy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_code TEXT NOT NULL CHECK (city_code ~ '^[A-Z]{3,12}$'),
  zone_id UUID NULL REFERENCES mobility.service_zone(id) ON DELETE CASCADE,
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 80),
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ NULL,
  demand_supply_target_bps INTEGER NOT NULL DEFAULT 10000 CHECK (demand_supply_target_bps BETWEEN 1000 AND 100000),
  max_surge_bps INTEGER NOT NULL DEFAULT 18000 CHECK (max_surge_bps BETWEEN 10000 AND 30000),
  max_surge_step_bps INTEGER NOT NULL DEFAULT 2000 CHECK (max_surge_step_bps BETWEEN 100 AND 10000),
  base_commission_bps INTEGER NOT NULL CHECK (base_commission_bps BETWEEN 0 AND 5000),
  surge_commission_relief_bps INTEGER NOT NULL DEFAULT 0 CHECK (surge_commission_relief_bps BETWEEN 0 AND 3000),
  minimum_driver_earnings_kobo BIGINT NOT NULL DEFAULT 0 CHECK (minimum_driver_earnings_kobo >= 0),
  tax_bps INTEGER NOT NULL DEFAULT 0 CHECK (tax_bps BETWEEN 0 AND 5000),
  provider_fee_bps INTEGER NOT NULL DEFAULT 0 CHECK (provider_fee_bps BETWEEN 0 AND 5000),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (base_commission_bps + tax_bps + provider_fee_bps <= 9500)
);

CREATE UNIQUE INDEX surge_policy_active_scope_version_uq
  ON pricing.surge_policy (city_code, COALESCE(zone_id, '00000000-0000-0000-0000-000000000000'::uuid), policy_version)
  WHERE active = TRUE;
CREATE INDEX surge_policy_lookup_idx
  ON pricing.surge_policy (city_code, zone_id, effective_from DESC)
  WHERE active = TRUE;

CREATE TABLE pricing.market_snapshot (
  id BIGSERIAL PRIMARY KEY,
  city_code TEXT NOT NULL CHECK (city_code ~ '^[A-Z]{3,12}$'),
  zone_id UUID NOT NULL REFERENCES mobility.service_zone(id) ON DELETE CASCADE,
  h3_cell TEXT NOT NULL CHECK (h3_cell ~ '^[0-9a-f]{15,16}$'),
  window_started_at TIMESTAMPTZ NOT NULL,
  window_ended_at TIMESTAMPTZ NOT NULL,
  open_trip_count INTEGER NOT NULL CHECK (open_trip_count >= 0),
  eligible_driver_count INTEGER NOT NULL CHECK (eligible_driver_count >= 0),
  source_version BIGINT NOT NULL CHECK (source_version > 0),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  input_digest BYTEA NOT NULL CHECK (octet_length(input_digest) = 32),
  CHECK (window_ended_at > window_started_at)
);
CREATE UNIQUE INDEX market_snapshot_source_uq
  ON pricing.market_snapshot (zone_id, h3_cell, source_version);
CREATE INDEX market_snapshot_latest_idx
  ON pricing.market_snapshot (zone_id, h3_cell, observed_at DESC);

CREATE TABLE pricing.ride_quote (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES mobility.ride_trip(id) ON DELETE RESTRICT,
  zone_id UUID NOT NULL REFERENCES mobility.service_zone(id) ON DELETE RESTRICT,
  pricing_policy_id UUID NOT NULL REFERENCES pricing.surge_policy(id) ON DELETE RESTRICT,
  pricing_policy_version TEXT NOT NULL,
  request_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 160),
  base_fare_kobo BIGINT NOT NULL CHECK (base_fare_kobo > 0),
  surge_multiplier_bps INTEGER NOT NULL CHECK (surge_multiplier_bps BETWEEN 10000 AND 30000),
  quoted_total_kobo BIGINT NOT NULL CHECK (quoted_total_kobo > 0),
  demand_count INTEGER NOT NULL CHECK (demand_count >= 0),
  supply_count INTEGER NOT NULL CHECK (supply_count >= 0),
  state pricing.quote_state NOT NULL DEFAULT 'quoted',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ NULL,
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX ride_quote_idempotency_uq ON pricing.ride_quote (trip_id, idempotency_key);
CREATE INDEX ride_quote_active_lookup_idx ON pricing.ride_quote (trip_id, state, expires_at DESC);
CREATE INDEX ride_quote_zone_created_idx ON pricing.ride_quote (zone_id, created_at DESC);

CREATE TABLE pricing.quote_commission_allocation (
  quote_id UUID NOT NULL REFERENCES pricing.ride_quote(id) ON DELETE CASCADE,
  allocation_kind pricing.allocation_kind NOT NULL,
  amount_kobo BIGINT NOT NULL CHECK (amount_kobo >= 0),
  rate_bps INTEGER NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (quote_id, allocation_kind)
);

CREATE OR REPLACE FUNCTION pricing.assert_quote_allocation_balance()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  expected_total BIGINT;
  allocated_total BIGINT;
BEGIN
  SELECT quoted_total_kobo INTO expected_total FROM pricing.ride_quote WHERE id = NEW.quote_id;
  SELECT COALESCE(SUM(amount_kobo), 0) INTO allocated_total FROM pricing.quote_commission_allocation WHERE quote_id = NEW.quote_id;
  IF allocated_total > expected_total THEN
    RAISE EXCEPTION 'quote allocations exceed quoted total';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER quote_allocation_balance_guard
AFTER INSERT OR UPDATE ON pricing.quote_commission_allocation
FOR EACH ROW EXECUTE FUNCTION pricing.assert_quote_allocation_balance();

CREATE TABLE pricing.outbox_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('ride_quote', 'commission_allocation')),
  aggregate_id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('pricing.quote.created', 'pricing.quote.accepted', 'pricing.quote.expired')),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ NULL,
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX pricing_outbox_pending_idx
  ON pricing.outbox_event (next_attempt_at, occurred_at)
  WHERE published_at IS NULL;

-- Least-privilege grant is conditional so clean schema bootstraps do not require the service role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'switchos_service') THEN
    GRANT USAGE ON SCHEMA pricing TO switchos_service;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA pricing TO switchos_service;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pricing TO switchos_service;
  END IF;
END;
$$;
