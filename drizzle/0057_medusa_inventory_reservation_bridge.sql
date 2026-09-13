-- PostgreSQL-authoritative Medusa inventory reservation bridge.
-- Medusa remains the source for its inventory-level and reservation records.
-- DeliveryPlatform receives authenticated, hydrated snapshots and projects them
-- deterministically into the Go inventory-control position table.

-- The service role is created by the deployment environment; on fresh
-- databases (rehearsals, CI, local dev) it does not exist yet, so create a
-- NOLOGIN placeholder to keep REVOKE/GRANT statements below idempotent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_gateway_service') THEN
    CREATE ROLE commerce_gateway_service NOLOGIN;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.inventory_positions (
  warehouse_id bigint NOT NULL,
  sku text NOT NULL CHECK (length(sku) BETWEEN 1 AND 160),
  merchant_id bigint,
  city text NOT NULL DEFAULT '',
  zone_key text NOT NULL DEFAULT '',
  on_hand_units numeric(18, 6) NOT NULL DEFAULT 0 CHECK (on_hand_units >= 0),
  reserved_units numeric(18, 6) NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  inbound_units numeric(18, 6) NOT NULL DEFAULT 0 CHECK (inbound_units >= 0),
  stock_accuracy numeric(5, 4) NOT NULL DEFAULT 0.9200 CHECK (stock_accuracy BETWEEN 0 AND 1),
  freshness_hours numeric(12, 3),
  cold_chain_ready boolean NOT NULL DEFAULT false,
  last_source text NOT NULL DEFAULT 'unknown',
  last_reason text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (warehouse_id, sku)
);

CREATE TABLE commerce.medusa_inventory_binding (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  provider_id integer NOT NULL REFERENCES public.service_providers(id) ON DELETE RESTRICT,
  medusa_stock_location_id text NOT NULL CHECK (length(medusa_stock_location_id) BETWEEN 3 AND 160 AND medusa_stock_location_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'),
  medusa_inventory_item_id text NOT NULL CHECK (length(medusa_inventory_item_id) BETWEEN 3 AND 160 AND medusa_inventory_item_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'),
  warehouse_id bigint NOT NULL,
  sku text NOT NULL CHECK (length(sku) BETWEEN 1 AND 160),
  active boolean NOT NULL DEFAULT true,
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CHECK ((active AND disabled_at IS NULL) OR (NOT active AND disabled_at IS NOT NULL)),
  UNIQUE (provider_id, medusa_stock_location_id, medusa_inventory_item_id),
  UNIQUE (warehouse_id, sku)
);

CREATE TABLE commerce.medusa_inventory_level_snapshot (
  binding_id uuid PRIMARY KEY REFERENCES commerce.medusa_inventory_binding(id) ON DELETE RESTRICT,
  medusa_inventory_level_id text NOT NULL CHECK (length(medusa_inventory_level_id) BETWEEN 3 AND 160 AND medusa_inventory_level_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'),
  stocked_quantity numeric(18, 6) NOT NULL CHECK (stocked_quantity >= 0),
  reported_reserved_quantity numeric(18, 6) NOT NULL CHECK (reported_reserved_quantity >= 0),
  incoming_quantity numeric(18, 6) NOT NULL CHECK (incoming_quantity >= 0),
  source_updated_at timestamptz NOT NULL,
  source_event_id text NOT NULL CHECK (length(source_event_id) BETWEEN 8 AND 160 AND source_event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (medusa_inventory_level_id)
);

CREATE TABLE commerce.medusa_inventory_reservation (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  provider_id integer NOT NULL REFERENCES public.service_providers(id) ON DELETE RESTRICT,
  medusa_reservation_id text NOT NULL CHECK (length(medusa_reservation_id) BETWEEN 3 AND 160 AND medusa_reservation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'),
  binding_id uuid NOT NULL REFERENCES commerce.medusa_inventory_binding(id) ON DELETE RESTRICT,
  medusa_order_id text CHECK (medusa_order_id IS NULL OR (length(medusa_order_id) BETWEEN 3 AND 160 AND medusa_order_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$')),
  quantity numeric(18, 6) NOT NULL CHECK (quantity > 0),
  state text NOT NULL CHECK (state IN ('active', 'released')),
  source_updated_at timestamptz NOT NULL,
  source_event_id text NOT NULL CHECK (length(source_event_id) BETWEEN 8 AND 160 AND source_event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, medusa_reservation_id)
);
CREATE INDEX commerce_medusa_inventory_reservation_active_idx
  ON commerce.medusa_inventory_reservation (binding_id, state)
  WHERE state = 'active';

CREATE TABLE commerce.medusa_inventory_bridge_event (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  provider_id integer NOT NULL REFERENCES public.service_providers(id) ON DELETE RESTRICT,
  medusa_event_id text NOT NULL CHECK (length(medusa_event_id) BETWEEN 8 AND 160 AND medusa_event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'),
  event_type text NOT NULL CHECK (event_type IN ('commerce.inventory.level.snapshot', 'commerce.inventory.reservation.snapshot')),
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  effect text NOT NULL CHECK (effect IN ('applied', 'ignored_stale')),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, medusa_event_id)
);

CREATE TABLE commerce.medusa_inventory_reservation_event (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  provider_id integer NOT NULL REFERENCES public.service_providers(id) ON DELETE RESTRICT,
  medusa_reservation_id text NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  medusa_event_id text NOT NULL,
  previous_state text CHECK (previous_state IS NULL OR previous_state IN ('active', 'released')),
  next_state text NOT NULL CHECK (next_state IN ('active', 'released')),
  quantity numeric(18, 6) NOT NULL CHECK (quantity > 0),
  source_updated_at timestamptz NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, medusa_reservation_id, sequence_no),
  UNIQUE (provider_id, medusa_event_id)
);

CREATE OR REPLACE FUNCTION commerce.prevent_medusa_inventory_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, commerce
AS $$
BEGIN
  RAISE EXCEPTION 'Medusa inventory bridge evidence is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER commerce_medusa_inventory_bridge_event_append_only
  BEFORE UPDATE OR DELETE ON commerce.medusa_inventory_bridge_event
  FOR EACH ROW EXECUTE FUNCTION commerce.prevent_medusa_inventory_evidence_mutation();

CREATE TRIGGER commerce_medusa_inventory_reservation_event_append_only
  BEFORE UPDATE OR DELETE ON commerce.medusa_inventory_reservation_event
  FOR EACH ROW EXECUTE FUNCTION commerce.prevent_medusa_inventory_evidence_mutation();

CREATE OR REPLACE FUNCTION commerce.prevent_direct_reservation_projection_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, commerce
AS $$
BEGIN
  IF NEW.reserved_units IS DISTINCT FROM OLD.reserved_units
     AND current_setting('commerce.medusa_inventory_projection_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'reserved inventory units are controlled by the Medusa reservation bridge' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER public_inventory_positions_reservation_projection_guard
  BEFORE UPDATE OF reserved_units ON public.inventory_positions
  FOR EACH ROW EXECUTE FUNCTION commerce.prevent_direct_reservation_projection_mutation();

CREATE OR REPLACE FUNCTION commerce.is_inventory_operator(p_user_id integer)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, commerce
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users
    WHERE id = p_user_id
      AND role::text IN ('admin', 'platform_admin', 'super_admin')
  );
$$;

CREATE OR REPLACE FUNCTION commerce.append_medusa_inventory_reservation_event(
  p_provider_id integer,
  p_reservation_id text,
  p_event_id text,
  p_previous_state text,
  p_next_state text,
  p_quantity numeric,
  p_source_updated_at timestamptz,
  p_detail jsonb,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce
AS $$
DECLARE
  v_sequence integer;
BEGIN
  SELECT COALESCE(MAX(sequence_no), 0) + 1
    INTO v_sequence
    FROM commerce.medusa_inventory_reservation_event
   WHERE provider_id = p_provider_id
     AND medusa_reservation_id = p_reservation_id;

  INSERT INTO commerce.medusa_inventory_reservation_event (
    provider_id, medusa_reservation_id, sequence_no, medusa_event_id,
    previous_state, next_state, quantity, source_updated_at, detail, created_at
  ) VALUES (
    p_provider_id, p_reservation_id, v_sequence, p_event_id,
    p_previous_state, p_next_state, p_quantity, p_source_updated_at, p_detail, p_now
  );
END;
$$;

CREATE OR REPLACE FUNCTION commerce.upsert_medusa_inventory_binding(
  p_actor_user_id integer,
  p_provider_id integer,
  p_medusa_stock_location_id text,
  p_medusa_inventory_item_id text,
  p_warehouse_id bigint,
  p_sku text,
  p_active boolean,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce
AS $$
DECLARE
  v_binding commerce.medusa_inventory_binding%ROWTYPE;
BEGIN
  IF NOT commerce.is_inventory_operator(p_actor_user_id) THEN
    RAISE EXCEPTION 'inventory operator role required' USING ERRCODE = '42501';
  END IF;
  IF p_warehouse_id <= 0
     OR p_medusa_stock_location_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
     OR length(p_medusa_stock_location_id) NOT BETWEEN 3 AND 160
     OR p_medusa_inventory_item_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
     OR length(p_medusa_inventory_item_id) NOT BETWEEN 3 AND 160
     OR length(trim(p_sku)) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'invalid Medusa inventory binding input' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM commerce.medusa_store_connection
     WHERE provider_id = p_provider_id AND active
  ) THEN
    RAISE EXCEPTION 'active Medusa store connection required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO commerce.medusa_inventory_binding (
    provider_id, medusa_stock_location_id, medusa_inventory_item_id,
    warehouse_id, sku, active, created_by, created_at, disabled_at
  ) VALUES (
    p_provider_id, p_medusa_stock_location_id, p_medusa_inventory_item_id,
    p_warehouse_id, trim(p_sku), p_active, p_actor_user_id, p_now,
    CASE WHEN p_active THEN NULL ELSE p_now END
  )
  ON CONFLICT (provider_id, medusa_stock_location_id, medusa_inventory_item_id)
  DO UPDATE SET
    warehouse_id = EXCLUDED.warehouse_id,
    sku = EXCLUDED.sku,
    active = EXCLUDED.active,
    disabled_at = EXCLUDED.disabled_at
  RETURNING * INTO v_binding;

  RETURN v_binding.id;
END;
$$;

CREATE OR REPLACE FUNCTION commerce.current_medusa_reservation_total(p_binding_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, commerce
AS $$
  SELECT COALESCE(SUM(quantity), 0)::numeric
  FROM commerce.medusa_inventory_reservation
  WHERE binding_id = p_binding_id AND state = 'active';
$$;

CREATE OR REPLACE FUNCTION commerce.project_medusa_inventory_position(
  p_binding_id uuid,
  p_event_id text,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE (on_hand_units numeric, reserved_units numeric, inbound_units numeric, available_units numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce
AS $$
DECLARE
  v_binding commerce.medusa_inventory_binding%ROWTYPE;
  v_level commerce.medusa_inventory_level_snapshot%ROWTYPE;
  v_reserved numeric;
BEGIN
  SELECT * INTO v_binding
    FROM commerce.medusa_inventory_binding
   WHERE id = p_binding_id AND active
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active Medusa inventory binding not found' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_level
    FROM commerce.medusa_inventory_level_snapshot
   WHERE binding_id = p_binding_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory level snapshot required before reservation projection' USING ERRCODE = '23514';
  END IF;

  v_reserved := commerce.current_medusa_reservation_total(p_binding_id);
  IF v_reserved > v_level.stocked_quantity THEN
    RAISE EXCEPTION 'active Medusa reservations exceed stocked quantity' USING ERRCODE = '23514';
  END IF;

  PERFORM set_config('commerce.medusa_inventory_projection_write', 'on', true);
  INSERT INTO public.inventory_positions (
    warehouse_id, sku, on_hand_units, reserved_units, inbound_units,
    stock_accuracy, last_source, last_reason, updated_at
  ) VALUES (
    v_binding.warehouse_id, v_binding.sku, v_level.stocked_quantity, v_reserved,
    v_level.incoming_quantity, 1.0000, 'medusa_inventory_bridge',
    'medusa_snapshot:' || p_event_id, p_now
  )
  ON CONFLICT (warehouse_id, sku) DO UPDATE SET
    on_hand_units = EXCLUDED.on_hand_units,
    reserved_units = EXCLUDED.reserved_units,
    inbound_units = EXCLUDED.inbound_units,
    stock_accuracy = EXCLUDED.stock_accuracy,
    last_source = EXCLUDED.last_source,
    last_reason = EXCLUDED.last_reason,
    updated_at = EXCLUDED.updated_at;

  RETURN QUERY
  SELECT p.on_hand_units, p.reserved_units, p.inbound_units,
         GREATEST(p.on_hand_units - p.reserved_units, 0)::numeric
    FROM public.inventory_positions p
   WHERE p.warehouse_id = v_binding.warehouse_id
     AND p.sku = v_binding.sku;
END;
$$;

CREATE OR REPLACE FUNCTION commerce.ingest_medusa_inventory_level_snapshot(
  p_provider_id integer,
  p_medusa_event_id text,
  p_medusa_inventory_level_id text,
  p_medusa_stock_location_id text,
  p_medusa_inventory_item_id text,
  p_stocked_quantity numeric,
  p_reported_reserved_quantity numeric,
  p_incoming_quantity numeric,
  p_source_updated_at timestamptz,
  p_payload_sha256 bytea,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE (applied boolean, on_hand_units numeric, reserved_units numeric, inbound_units numeric, available_units numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce
AS $$
DECLARE
  v_binding commerce.medusa_inventory_binding%ROWTYPE;
  v_existing commerce.medusa_inventory_bridge_event%ROWTYPE;
  v_level commerce.medusa_inventory_level_snapshot%ROWTYPE;
  v_effect text := 'applied';
BEGIN
  IF p_medusa_event_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
     OR length(p_medusa_event_id) NOT BETWEEN 8 AND 160
     OR p_medusa_inventory_level_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
     OR length(p_medusa_inventory_level_id) NOT BETWEEN 3 AND 160
     OR p_medusa_stock_location_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
     OR length(p_medusa_stock_location_id) NOT BETWEEN 3 AND 160
     OR p_medusa_inventory_item_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
     OR length(p_medusa_inventory_item_id) NOT BETWEEN 3 AND 160
     OR p_stocked_quantity < 0 OR p_reported_reserved_quantity < 0 OR p_incoming_quantity < 0
     OR octet_length(p_payload_sha256) <> 32 THEN
    RAISE EXCEPTION 'invalid Medusa inventory level snapshot' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM commerce.medusa_store_connection WHERE provider_id = p_provider_id AND active) THEN
    RAISE EXCEPTION 'active Medusa store connection required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_existing
    FROM commerce.medusa_inventory_bridge_event
   WHERE provider_id = p_provider_id AND medusa_event_id = p_medusa_event_id;
  IF FOUND THEN
    IF v_existing.event_type <> 'commerce.inventory.level.snapshot'
       OR v_existing.payload_sha256 <> p_payload_sha256 THEN
      RAISE EXCEPTION 'Medusa inventory event identifier reused with different payload' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY
    SELECT false, p.on_hand_units, p.reserved_units, p.inbound_units,
           GREATEST(p.on_hand_units - p.reserved_units, 0)::numeric
      FROM public.inventory_positions p
      JOIN commerce.medusa_inventory_binding b
        ON b.warehouse_id = p.warehouse_id AND b.sku = p.sku
     WHERE b.provider_id = p_provider_id
       AND b.medusa_stock_location_id = p_medusa_stock_location_id
       AND b.medusa_inventory_item_id = p_medusa_inventory_item_id;
    RETURN;
  END IF;

  SELECT * INTO v_binding
    FROM commerce.medusa_inventory_binding
   WHERE provider_id = p_provider_id
     AND medusa_stock_location_id = p_medusa_stock_location_id
     AND medusa_inventory_item_id = p_medusa_inventory_item_id
     AND active
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active Medusa inventory binding not found' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_level
    FROM commerce.medusa_inventory_level_snapshot
   WHERE binding_id = v_binding.id
   FOR UPDATE;
  IF FOUND AND p_source_updated_at < v_level.source_updated_at THEN
    v_effect := 'ignored_stale';
  ELSIF FOUND AND p_source_updated_at = v_level.source_updated_at
        AND (p_stocked_quantity <> v_level.stocked_quantity
          OR p_reported_reserved_quantity <> v_level.reported_reserved_quantity
          OR p_incoming_quantity <> v_level.incoming_quantity
          OR p_medusa_inventory_level_id <> v_level.medusa_inventory_level_id) THEN
    RAISE EXCEPTION 'Medusa inventory level snapshot conflicts at identical source timestamp' USING ERRCODE = '23505';
  ELSE
    INSERT INTO commerce.medusa_inventory_level_snapshot (
      binding_id, medusa_inventory_level_id, stocked_quantity,
      reported_reserved_quantity, incoming_quantity, source_updated_at,
      source_event_id, received_at
    ) VALUES (
      v_binding.id, p_medusa_inventory_level_id, p_stocked_quantity,
      p_reported_reserved_quantity, p_incoming_quantity, p_source_updated_at,
      p_medusa_event_id, p_now
    )
    ON CONFLICT (binding_id) DO UPDATE SET
      medusa_inventory_level_id = EXCLUDED.medusa_inventory_level_id,
      stocked_quantity = EXCLUDED.stocked_quantity,
      reported_reserved_quantity = EXCLUDED.reported_reserved_quantity,
      incoming_quantity = EXCLUDED.incoming_quantity,
      source_updated_at = EXCLUDED.source_updated_at,
      source_event_id = EXCLUDED.source_event_id,
      received_at = EXCLUDED.received_at;
  END IF;

  INSERT INTO commerce.medusa_inventory_bridge_event (
    provider_id, medusa_event_id, event_type, payload_sha256, effect, received_at
  ) VALUES (
    p_provider_id, p_medusa_event_id, 'commerce.inventory.level.snapshot',
    p_payload_sha256, v_effect, p_now
  );

  IF v_effect = 'ignored_stale' THEN
    RETURN QUERY
    SELECT false, p.on_hand_units, p.reserved_units, p.inbound_units,
           GREATEST(p.on_hand_units - p.reserved_units, 0)::numeric
      FROM public.inventory_positions p
     WHERE p.warehouse_id = v_binding.warehouse_id AND p.sku = v_binding.sku;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, q.on_hand_units, q.reserved_units, q.inbound_units, q.available_units
    FROM commerce.project_medusa_inventory_position(v_binding.id, p_medusa_event_id, p_now) q;
END;
$$;

CREATE OR REPLACE FUNCTION commerce.ingest_medusa_inventory_reservation_snapshot(
  p_provider_id integer,
  p_medusa_event_id text,
  p_medusa_reservation_id text,
  p_medusa_stock_location_id text,
  p_medusa_inventory_item_id text,
  p_medusa_order_id text,
  p_quantity numeric,
  p_state text,
  p_source_updated_at timestamptz,
  p_payload_sha256 bytea,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE (applied boolean, on_hand_units numeric, reserved_units numeric, inbound_units numeric, available_units numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce
AS $$
DECLARE
  v_binding commerce.medusa_inventory_binding%ROWTYPE;
  v_reservation commerce.medusa_inventory_reservation%ROWTYPE;
  v_existing commerce.medusa_inventory_bridge_event%ROWTYPE;
  v_effect text := 'applied';
  v_previous_state text;
BEGIN
  IF p_medusa_event_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
     OR length(p_medusa_event_id) NOT BETWEEN 8 AND 160
     OR p_medusa_reservation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
     OR length(p_medusa_reservation_id) NOT BETWEEN 3 AND 160
     OR p_medusa_stock_location_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
     OR length(p_medusa_stock_location_id) NOT BETWEEN 3 AND 160
     OR p_medusa_inventory_item_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
     OR length(p_medusa_inventory_item_id) NOT BETWEEN 3 AND 160
     OR (p_medusa_order_id IS NOT NULL AND (p_medusa_order_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$' OR length(p_medusa_order_id) NOT BETWEEN 3 AND 160))
     OR p_quantity <= 0 OR p_state NOT IN ('active', 'released')
     OR octet_length(p_payload_sha256) <> 32 THEN
    RAISE EXCEPTION 'invalid Medusa inventory reservation snapshot' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM commerce.medusa_store_connection WHERE provider_id = p_provider_id AND active) THEN
    RAISE EXCEPTION 'active Medusa store connection required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_existing
    FROM commerce.medusa_inventory_bridge_event
   WHERE provider_id = p_provider_id AND medusa_event_id = p_medusa_event_id;
  IF FOUND THEN
    IF v_existing.event_type <> 'commerce.inventory.reservation.snapshot'
       OR v_existing.payload_sha256 <> p_payload_sha256 THEN
      RAISE EXCEPTION 'Medusa inventory event identifier reused with different payload' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY
    SELECT false, p.on_hand_units, p.reserved_units, p.inbound_units,
           GREATEST(p.on_hand_units - p.reserved_units, 0)::numeric
      FROM public.inventory_positions p
      JOIN commerce.medusa_inventory_binding b
        ON b.warehouse_id = p.warehouse_id AND b.sku = p.sku
     WHERE b.provider_id = p_provider_id
       AND b.medusa_stock_location_id = p_medusa_stock_location_id
       AND b.medusa_inventory_item_id = p_medusa_inventory_item_id;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_provider_id::text || ':' || p_medusa_reservation_id, 0));
  SELECT * INTO v_binding
    FROM commerce.medusa_inventory_binding
   WHERE provider_id = p_provider_id
     AND medusa_stock_location_id = p_medusa_stock_location_id
     AND medusa_inventory_item_id = p_medusa_inventory_item_id
     AND active
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active Medusa inventory binding not found' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_reservation
    FROM commerce.medusa_inventory_reservation
   WHERE provider_id = p_provider_id AND medusa_reservation_id = p_medusa_reservation_id
   FOR UPDATE;
  IF FOUND AND v_reservation.binding_id <> v_binding.id THEN
    RAISE EXCEPTION 'Medusa reservation changed inventory binding' USING ERRCODE = '23505';
  END IF;
  IF FOUND AND p_source_updated_at < v_reservation.source_updated_at THEN
    v_effect := 'ignored_stale';
  ELSIF FOUND AND p_source_updated_at = v_reservation.source_updated_at
        AND (v_reservation.quantity <> p_quantity
          OR v_reservation.state <> p_state
          OR v_reservation.medusa_order_id IS DISTINCT FROM p_medusa_order_id) THEN
    RAISE EXCEPTION 'Medusa reservation snapshot conflicts at identical source timestamp' USING ERRCODE = '23505';
  ELSE
    v_previous_state := CASE WHEN FOUND THEN v_reservation.state ELSE NULL END;
    INSERT INTO commerce.medusa_inventory_reservation (
      provider_id, medusa_reservation_id, binding_id, medusa_order_id,
      quantity, state, source_updated_at, source_event_id, received_at
    ) VALUES (
      p_provider_id, p_medusa_reservation_id, v_binding.id, p_medusa_order_id,
      p_quantity, p_state, p_source_updated_at, p_medusa_event_id, p_now
    )
    ON CONFLICT (provider_id, medusa_reservation_id) DO UPDATE SET
      medusa_order_id = EXCLUDED.medusa_order_id,
      quantity = EXCLUDED.quantity,
      state = EXCLUDED.state,
      source_updated_at = EXCLUDED.source_updated_at,
      source_event_id = EXCLUDED.source_event_id,
      received_at = EXCLUDED.received_at;
    PERFORM commerce.append_medusa_inventory_reservation_event(
      p_provider_id, p_medusa_reservation_id, p_medusa_event_id,
      v_previous_state, p_state, p_quantity, p_source_updated_at,
      jsonb_build_object('medusa_order_id', p_medusa_order_id), p_now
    );
  END IF;

  INSERT INTO commerce.medusa_inventory_bridge_event (
    provider_id, medusa_event_id, event_type, payload_sha256, effect, received_at
  ) VALUES (
    p_provider_id, p_medusa_event_id, 'commerce.inventory.reservation.snapshot',
    p_payload_sha256, v_effect, p_now
  );

  IF v_effect = 'ignored_stale' THEN
    RETURN QUERY
    SELECT false, p.on_hand_units, p.reserved_units, p.inbound_units,
           GREATEST(p.on_hand_units - p.reserved_units, 0)::numeric
      FROM public.inventory_positions p
     WHERE p.warehouse_id = v_binding.warehouse_id AND p.sku = v_binding.sku;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, q.on_hand_units, q.reserved_units, q.inbound_units, q.available_units
    FROM commerce.project_medusa_inventory_position(v_binding.id, p_medusa_event_id, p_now) q;
END;
$$;

CREATE OR REPLACE FUNCTION commerce.ingest_medusa_inventory_level_snapshot_for_store(
  p_medusa_store_id text,
  p_medusa_event_id text,
  p_medusa_inventory_level_id text,
  p_medusa_stock_location_id text,
  p_medusa_inventory_item_id text,
  p_stocked_quantity numeric,
  p_reported_reserved_quantity numeric,
  p_incoming_quantity numeric,
  p_source_updated_at timestamptz,
  p_payload_sha256 bytea,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE (applied boolean, on_hand_units numeric, reserved_units numeric, inbound_units numeric, available_units numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce
AS $$
DECLARE
  v_provider_id integer;
BEGIN
  SELECT provider_id INTO v_provider_id
    FROM commerce.medusa_store_connection
   WHERE medusa_store_id = p_medusa_store_id AND active
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active Medusa store connection required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT * FROM commerce.ingest_medusa_inventory_level_snapshot(
    v_provider_id, p_medusa_event_id, p_medusa_inventory_level_id,
    p_medusa_stock_location_id, p_medusa_inventory_item_id,
    p_stocked_quantity, p_reported_reserved_quantity, p_incoming_quantity,
    p_source_updated_at, p_payload_sha256, p_now
  );
END;
$$;

CREATE OR REPLACE FUNCTION commerce.ingest_medusa_inventory_reservation_snapshot_for_store(
  p_medusa_store_id text,
  p_medusa_event_id text,
  p_medusa_reservation_id text,
  p_medusa_stock_location_id text,
  p_medusa_inventory_item_id text,
  p_medusa_order_id text,
  p_quantity numeric,
  p_state text,
  p_source_updated_at timestamptz,
  p_payload_sha256 bytea,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE (applied boolean, on_hand_units numeric, reserved_units numeric, inbound_units numeric, available_units numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce
AS $$
DECLARE
  v_provider_id integer;
BEGIN
  SELECT provider_id INTO v_provider_id
    FROM commerce.medusa_store_connection
   WHERE medusa_store_id = p_medusa_store_id AND active
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active Medusa store connection required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT * FROM commerce.ingest_medusa_inventory_reservation_snapshot(
    v_provider_id, p_medusa_event_id, p_medusa_reservation_id,
    p_medusa_stock_location_id, p_medusa_inventory_item_id, p_medusa_order_id,
    p_quantity, p_state, p_source_updated_at, p_payload_sha256, p_now
  );
END;
$$;

CREATE OR REPLACE VIEW commerce.medusa_inventory_reconciliation AS
SELECT
  b.provider_id,
  b.medusa_stock_location_id,
  b.medusa_inventory_item_id,
  b.warehouse_id,
  b.sku,
  l.stocked_quantity,
  l.reported_reserved_quantity,
  commerce.current_medusa_reservation_total(b.id) AS projected_reserved_quantity,
  l.incoming_quantity,
  (l.reported_reserved_quantity = commerce.current_medusa_reservation_total(b.id)) AS reservation_reconciled,
  l.source_updated_at,
  l.received_at
FROM commerce.medusa_inventory_binding b
JOIN commerce.medusa_inventory_level_snapshot l ON l.binding_id = b.id;

CREATE OR REPLACE FUNCTION commerce.list_medusa_inventory_reconciliation(
  p_actor_user_id integer,
  p_provider_id integer,
  p_limit integer DEFAULT 100
) RETURNS TABLE (
  medusa_stock_location_id text,
  medusa_inventory_item_id text,
  warehouse_id bigint,
  sku text,
  stocked_quantity numeric,
  reported_reserved_quantity numeric,
  projected_reserved_quantity numeric,
  incoming_quantity numeric,
  reservation_reconciled boolean,
  source_updated_at timestamptz,
  received_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce
AS $$
BEGIN
  IF NOT commerce.is_inventory_operator(p_actor_user_id) THEN
    RAISE EXCEPTION 'inventory operator role required' USING ERRCODE = '42501';
  END IF;
  IF p_limit NOT BETWEEN 1 AND 250 THEN
    RAISE EXCEPTION 'invalid inventory reconciliation limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT r.medusa_stock_location_id, r.medusa_inventory_item_id,
         r.warehouse_id, r.sku, r.stocked_quantity,
         r.reported_reserved_quantity, r.projected_reserved_quantity,
         r.incoming_quantity, r.reservation_reconciled,
         r.source_updated_at, r.received_at
    FROM commerce.medusa_inventory_reconciliation r
   WHERE r.provider_id = p_provider_id
   ORDER BY r.source_updated_at DESC, r.medusa_inventory_item_id ASC
   LIMIT p_limit;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_gateway_service') THEN
    GRANT USAGE ON SCHEMA commerce TO commerce_gateway_service;
    GRANT EXECUTE ON FUNCTION commerce.ingest_medusa_inventory_level_snapshot_for_store(text,text,text,text,text,numeric,numeric,numeric,timestamp with time zone,bytea,timestamp with time zone) TO commerce_gateway_service;
    GRANT EXECUTE ON FUNCTION commerce.ingest_medusa_inventory_reservation_snapshot_for_store(text,text,text,text,text,text,numeric,text,timestamp with time zone,bytea,timestamp with time zone) TO commerce_gateway_service;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_operator_service') THEN
    GRANT USAGE ON SCHEMA commerce TO commerce_operator_service;
    GRANT EXECUTE ON FUNCTION commerce.upsert_medusa_inventory_binding(integer,integer,text,text,bigint,text,boolean,timestamp with time zone) TO commerce_operator_service;
    GRANT EXECUTE ON FUNCTION commerce.list_medusa_inventory_reconciliation(integer,integer,integer) TO commerce_operator_service;
  END IF;
END;
$$;

REVOKE ALL ON TABLE public.inventory_positions FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA commerce FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA commerce FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION commerce.prevent_medusa_inventory_evidence_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION commerce.prevent_direct_reservation_projection_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION commerce.append_medusa_inventory_reservation_event(integer,text,text,text,text,numeric,timestamp with time zone,jsonb,timestamp with time zone) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION commerce.current_medusa_reservation_total(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION commerce.project_medusa_inventory_position(uuid,text,timestamp with time zone) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION commerce.is_inventory_operator(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION commerce.upsert_medusa_inventory_binding(integer,integer,text,text,bigint,text,boolean,timestamp with time zone) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION commerce.ingest_medusa_inventory_level_snapshot(integer,text,text,text,text,numeric,numeric,numeric,timestamp with time zone,bytea,timestamp with time zone) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION commerce.ingest_medusa_inventory_reservation_snapshot(integer,text,text,text,text,text,numeric,text,timestamp with time zone,bytea,timestamp with time zone) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION commerce.ingest_medusa_inventory_level_snapshot(integer,text,text,text,text,numeric,numeric,numeric,timestamp with time zone,bytea,timestamp with time zone) FROM commerce_gateway_service;
REVOKE EXECUTE ON FUNCTION commerce.ingest_medusa_inventory_reservation_snapshot(integer,text,text,text,text,text,numeric,text,timestamp with time zone,bytea,timestamp with time zone) FROM commerce_gateway_service;
REVOKE EXECUTE ON FUNCTION commerce.ingest_medusa_inventory_level_snapshot_for_store(text,text,text,text,text,numeric,numeric,numeric,timestamp with time zone,bytea,timestamp with time zone) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION commerce.ingest_medusa_inventory_reservation_snapshot_for_store(text,text,text,text,text,text,numeric,text,timestamp with time zone,bytea,timestamp with time zone) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION commerce.list_medusa_inventory_reconciliation(integer,integer,integer) FROM PUBLIC;
