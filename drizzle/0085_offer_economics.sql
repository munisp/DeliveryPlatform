-- Per-offer fare breakdown (R3: drivers see exactly where every kobo goes,
-- R9: deadhead compensation for long pickups). One row per dispatch offer;
-- upserted idempotently by offer_id.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.offer_economics_breakdowns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id text NOT NULL UNIQUE,
  market_id text,
  base_minor bigint NOT NULL,
  distance_minor bigint NOT NULL,
  time_minor bigint NOT NULL,
  deadhead_minor bigint NOT NULL DEFAULT 0,
  pickup_seconds integer NOT NULL DEFAULT 0,
  pickup_meters integer NOT NULL DEFAULT 0,
  surge_bps integer NOT NULL DEFAULT 0,
  take_rate_bps integer NOT NULL,
  platform_fee_minor bigint NOT NULL,
  net_to_driver_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'NGN',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS offer_economics_breakdowns_market_idx
  ON public.offer_economics_breakdowns (market_id, created_at DESC);
