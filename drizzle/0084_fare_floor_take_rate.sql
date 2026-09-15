-- Cost-indexed fare floor (R6) and published take-rate registry (R7).
-- Economics changes are gated through the worker council: both tables carry an
-- optional consultation_id reference to public.consultation_objects (0082).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.fare_floor_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id text NOT NULL,
  -- {fuel_price_minor bigint, cpi_bp int, maintenance_index_bp int,
  --  source text, updated_at timestamptz}
  cost_index jsonb NOT NULL,
  sustainability_multiplier numeric(5,3) NOT NULL DEFAULT 1.000,
  active boolean NOT NULL DEFAULT true,
  consultation_id uuid REFERENCES public.consultation_objects(id) ON DELETE SET NULL,
  created_by bigint REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- At most one active floor policy per market.
CREATE UNIQUE INDEX IF NOT EXISTS fare_floor_policies_one_active_per_market_idx
  ON public.fare_floor_policies (market_id) WHERE active;

CREATE TABLE IF NOT EXISTS public.take_rate_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id text NOT NULL,
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 5000),
  basis text NOT NULL CHECK (basis IN ('gross', 'net_of_tolls', 'net_of_costs')),
  effective_from timestamptz NOT NULL,
  consultation_id uuid REFERENCES public.consultation_objects(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1,
  created_by bigint REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (market_id, version)
);
CREATE INDEX IF NOT EXISTS take_rate_registry_market_version_idx
  ON public.take_rate_registry (market_id, version DESC);

-- Operator overrides of the fare floor are auditable and auto-consulted.
CREATE TABLE IF NOT EXISTS public.fare_floor_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id text NOT NULL,
  operator_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  justification text NOT NULL,
  fare_minor bigint NOT NULL,
  floor_minor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fare_floor_overrides_market_idx
  ON public.fare_floor_overrides (market_id, created_at DESC);
