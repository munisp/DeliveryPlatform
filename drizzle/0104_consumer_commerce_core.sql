-- Consumer commerce core (P1 consumer-parity wave): carts, cart items,
-- checkout sessions, group orders and subscriptions in the public schema,
-- plus the public.consumer_checkout SECURITY DEFINER function that turns an
-- active cart into a public.orders row and a checkout session atomically.
--
-- Money columns on the NEW tables are bigint MINOR units (kobo) with an
-- explicit currency column (NGN default). The legacy public.orders amount
-- columns stay VARCHAR major units (0000 convention — reads cast via
-- ::numeric, see server/_core/consumerQueries.ts); consumer_checkout
-- converts minor -> "major.cc" with integer math only
-- ((minor / 100)::bigint || '.' || lpad((minor % 100)::text, 2, '0')), never
-- floating point. order_number follows the existing seed convention
-- 'SO-<number>' (scripts/init-local-postgres.sql: SO-1001, SO-1002, offset
-- 1000 from the orders id sequence).
--
-- Idempotency mirrors the 0102 replay-hardening pattern: a replay with the
-- same idempotency key and the same parameters returns the stored result; a
-- same-key replay with DIFFERENT parameters raises
-- 'idempotency key replay with different parameters' (ERRCODE 22023).
--
-- Outbox omission (documented per P1 spec): there is no public-schema
-- outbox table — the outbox patterns in this repo live in mobility.,
-- pricing., field_service. and mojaloop_funds_outbox — so consumer_checkout
-- does not emit an outbox row. The consumer-facing notification seam is the
-- payment-initiation flow in server/_core/consumerCommerce.ts; a
-- public-schema outbox is a later-wave decision.
--
-- Applies after 0103_powersync_sync_support.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS public.consumer_carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_id integer NOT NULL REFERENCES public.users(id),
  service_provider_id integer,
  vertical_id integer,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'checked_out', 'abandoned')),
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.consumer_carts IS
  'Consumer shopping carts; one row per checkout attempt scope. The partial UNIQUE(consumer_id, idempotency_key) makes cart creation replay-safe.';

CREATE UNIQUE INDEX IF NOT EXISTS consumer_carts_consumer_idempotency_key_unique
  ON public.consumer_carts (consumer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_consumer_carts_consumer_status
  ON public.consumer_carts (consumer_id, status);

CREATE TABLE IF NOT EXISTS public.consumer_cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL REFERENCES public.consumer_carts(id) ON DELETE CASCADE,
  catalog_item_id integer,
  name text NOT NULL,
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 999),
  modifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.consumer_cart_items IS
  'Cart line items with price/name snapshots taken at add time; checkout totals are computed from these snapshots, never from live catalog rows.';

CREATE INDEX IF NOT EXISTS idx_consumer_cart_items_cart
  ON public.consumer_cart_items (cart_id);

CREATE TABLE IF NOT EXISTS public.consumer_checkout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL UNIQUE REFERENCES public.consumer_carts(id),
  consumer_id integer NOT NULL REFERENCES public.users(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'payment_pending', 'paid', 'failed', 'expired')),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  platform_fee_minor bigint NOT NULL CHECK (platform_fee_minor >= 0),
  delivery_fee_minor bigint NOT NULL CHECK (delivery_fee_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  currency text NOT NULL DEFAULT 'NGN',
  payment_reference text,
  mojaloop_transfer_id text,
  idempotency_key text NOT NULL UNIQUE,
  -- Links the session to the orders row it created. Required so an
  -- idempotent replay can RETURN the existing result (order id/number) and
  -- compare the stored delivery parameters; without it the sessions table
  -- has no path back to the order.
  order_id integer REFERENCES public.orders(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.consumer_checkout_sessions IS
  'One checkout session per cart (UNIQUE cart_id) with server-computed minor-unit totals; idempotency_key UNIQUE anchors checkout replay safety.';

CREATE INDEX IF NOT EXISTS idx_consumer_checkout_sessions_consumer
  ON public.consumer_checkout_sessions (consumer_id, status);

CREATE TABLE IF NOT EXISTS public.consumer_group_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_consumer_id integer NOT NULL REFERENCES public.users(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked', 'checked_out', 'cancelled')),
  share_code text NOT NULL UNIQUE,
  max_participants integer NOT NULL DEFAULT 8 CHECK (max_participants BETWEEN 2 AND 32),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.consumer_group_orders IS
  'Shared-cart group orders; share_code is an app-generated 8-character Crockford-ish code used to join.';

CREATE TABLE IF NOT EXISTS public.consumer_group_order_participants (
  group_id uuid NOT NULL REFERENCES public.consumer_group_orders(id) ON DELETE CASCADE,
  consumer_id integer NOT NULL REFERENCES public.users(id),
  cart_id uuid REFERENCES public.consumer_carts(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, consumer_id)
);

CREATE TABLE IF NOT EXISTS public.consumer_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_id integer NOT NULL REFERENCES public.users(id),
  plan_id integer NOT NULL REFERENCES public.membership_plans(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'cancelled')),
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (current_period_end > current_period_start)
);

COMMENT ON TABLE public.consumer_subscriptions IS
  'Consumer subscription state against membership_plans (0003); idempotency_key UNIQUE anchors subscribe replays.';

CREATE INDEX IF NOT EXISTS idx_consumer_subscriptions_consumer
  ON public.consumer_subscriptions (consumer_id, status);

-- consumer_checkout: atomically converts an active, non-empty cart owned by
-- p_consumer_id into a public.orders row (status 'pending', legacy varchar
-- major-unit amounts) plus a consumer_checkout_sessions row (status 'open',
-- expires now() + 30 min) and marks the cart checked_out.
--
-- p_platform_fee_minor / p_delivery_fee_minor are supplied by the caller from
-- the server-side fee configuration (CONSUMER_PLATFORM_FEE_BPS /
-- CONSUMER_DELIVERY_FEE_MINOR, clamped in server/_core/consumerCommerce.ts);
-- when omitted the function falls back to the documented defaults
-- (500 bps of subtotal, 50000 minor flat) so direct SQL callers stay sane.
-- The fees are function parameters — not env lookups — because plpgsql
-- cannot read the TS process environment; the parameters also make replay
-- parameter comparison exact.
CREATE OR REPLACE FUNCTION public.consumer_checkout(
  p_consumer_id integer,
  p_cart_id uuid,
  p_idempotency_key text,
  p_delivery_address text,
  p_delivery_lat double precision,
  p_delivery_lng double precision,
  p_notes text DEFAULT NULL,
  p_platform_fee_minor bigint DEFAULT NULL,
  p_delivery_fee_minor bigint DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_cart public.consumer_carts%ROWTYPE;
  v_session public.consumer_checkout_sessions%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_item_count integer;
  v_subtotal_minor bigint;
  v_platform_fee_minor bigint;
  v_delivery_fee_minor bigint;
  v_total_minor bigint;
  v_order_id integer;
  v_order_number text;
  v_session_id uuid;
  v_expires_at timestamptz;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN
    RAISE EXCEPTION 'invalid idempotency key' USING ERRCODE = '22023';
  END IF;
  IF p_delivery_address IS NULL OR char_length(btrim(p_delivery_address)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'invalid delivery address' USING ERRCODE = '22023';
  END IF;
  IF p_delivery_lat IS NULL OR p_delivery_lng IS NULL
     OR abs(p_delivery_lat) > 90 OR abs(p_delivery_lng) > 180 THEN
    RAISE EXCEPTION 'invalid delivery coordinates' USING ERRCODE = '22023';
  END IF;
  IF p_platform_fee_minor IS NOT NULL AND p_platform_fee_minor < 0 THEN
    RAISE EXCEPTION 'invalid platform fee' USING ERRCODE = '22023';
  END IF;
  IF p_delivery_fee_minor IS NOT NULL AND p_delivery_fee_minor < 0 THEN
    RAISE EXCEPTION 'invalid delivery fee' USING ERRCODE = '22023';
  END IF;

  -- Idempotent replay (0102 pattern): same key + same parameters returns the
  -- stored result; same key + different parameters raises 22023 instead of
  -- silently confirming an unrelated checkout.
  SELECT * INTO v_session FROM public.consumer_checkout_sessions WHERE idempotency_key = p_idempotency_key;
  IF v_session.id IS NOT NULL THEN
    SELECT * INTO v_order FROM public.orders WHERE id = v_session.order_id;
    IF v_session.consumer_id <> p_consumer_id
       OR v_session.cart_id <> p_cart_id
       OR v_order.delivery_address IS DISTINCT FROM p_delivery_address
       OR v_order.delivery_latitude IS DISTINCT FROM p_delivery_lat::text
       OR v_order.delivery_longitude IS DISTINCT FROM p_delivery_lng::text
       OR v_order.notes IS DISTINCT FROM p_notes
       OR (p_platform_fee_minor IS NOT NULL AND v_session.platform_fee_minor <> p_platform_fee_minor)
       OR (p_delivery_fee_minor IS NOT NULL AND v_session.delivery_fee_minor <> p_delivery_fee_minor) THEN
      RAISE EXCEPTION 'idempotency key replay with different parameters' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object(
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'checkout_session_id', v_session.id,
      'status', v_session.status,
      'subtotal_minor', v_session.subtotal_minor,
      'platform_fee_minor', v_session.platform_fee_minor,
      'delivery_fee_minor', v_session.delivery_fee_minor,
      'total_minor', v_session.total_minor,
      'currency', v_session.currency,
      'expires_at', v_session.expires_at,
      'replayed', true
    );
  END IF;

  SELECT * INTO v_cart FROM public.consumer_carts WHERE id = p_cart_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cart not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_cart.consumer_id <> p_consumer_id THEN
    RAISE EXCEPTION 'cart owner required' USING ERRCODE = '42501';
  END IF;
  IF v_cart.status <> 'active' THEN
    RAISE EXCEPTION 'cart_not_active' USING ERRCODE = '55000';
  END IF;
  IF v_cart.vertical_id IS NULL THEN
    RAISE EXCEPTION 'cart missing vertical' USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*)::integer, COALESCE(SUM(unit_price_minor * quantity), 0)::bigint
  INTO v_item_count, v_subtotal_minor
  FROM public.consumer_cart_items
  WHERE cart_id = p_cart_id;
  IF v_item_count = 0 THEN
    RAISE EXCEPTION 'cart is empty' USING ERRCODE = '55000';
  END IF;

  v_platform_fee_minor := COALESCE(p_platform_fee_minor, (v_subtotal_minor * 500) / 10000);
  v_delivery_fee_minor := COALESCE(p_delivery_fee_minor, 50000);
  v_total_minor := v_subtotal_minor + v_platform_fee_minor + v_delivery_fee_minor;

  -- 'SO-' + (1000 + sequence value) mirrors the seed convention
  -- (SO-1001/SO-1002 in scripts/init-local-postgres.sql). The sequence draw
  -- is in addition to the id column default draw, so numbers stay unique;
  -- orders_order_number_unique is the final guard.
  v_order_number := 'SO-' || (1000 + nextval(pg_get_serial_sequence('public.orders', 'id')))::text;

  INSERT INTO public.orders (
    order_number, customer_id, vertical_id, service_provider_id, status,
    total_amount, platform_fee, driver_fee,
    delivery_address, delivery_latitude, delivery_longitude, notes
  ) VALUES (
    v_order_number, p_consumer_id, v_cart.vertical_id, v_cart.service_provider_id, 'pending',
    (v_total_minor / 100)::bigint::text || '.' || lpad((v_total_minor % 100)::text, 2, '0'),
    (v_platform_fee_minor / 100)::bigint::text || '.' || lpad((v_platform_fee_minor % 100)::text, 2, '0'),
    '0.00',
    p_delivery_address, p_delivery_lat::text, p_delivery_lng::text, p_notes
  ) RETURNING id INTO v_order_id;

  UPDATE public.consumer_carts
  SET status = 'checked_out', updated_at = now()
  WHERE id = p_cart_id;

  v_expires_at := now() + interval '30 minutes';
  INSERT INTO public.consumer_checkout_sessions (
    cart_id, consumer_id, status, subtotal_minor, platform_fee_minor,
    delivery_fee_minor, total_minor, currency, idempotency_key, order_id, expires_at
  ) VALUES (
    p_cart_id, p_consumer_id, 'open', v_subtotal_minor, v_platform_fee_minor,
    v_delivery_fee_minor, v_total_minor, 'NGN', p_idempotency_key, v_order_id, v_expires_at
  ) RETURNING id INTO v_session_id;

  RETURN jsonb_build_object(
    'order_id', v_order_id,
    'order_number', v_order_number,
    'checkout_session_id', v_session_id,
    'status', 'open',
    'subtotal_minor', v_subtotal_minor,
    'platform_fee_minor', v_platform_fee_minor,
    'delivery_fee_minor', v_delivery_fee_minor,
    'total_minor', v_total_minor,
    'currency', 'NGN',
    'expires_at', v_expires_at,
    'replayed', false
  );
END;
$$;

COMMIT;
