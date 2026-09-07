-- Clean-room logistics operations domain. This schema is independently designed for DeliveryPlatform.

CREATE SCHEMA IF NOT EXISTS operations;

DO $$
BEGIN
  CREATE TYPE operations.work_state AS ENUM ('draft','queued','allocated','in_progress','completed','cancelled','failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
BEGIN
  CREATE TYPE operations.stop_kind AS ENUM ('pickup','dropoff','checkpoint','return');
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
BEGIN
  CREATE TYPE operations.delivery_state AS ENUM ('queued','delivering','delivered','retry_scheduled','failed','dead_letter');
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

CREATE TABLE IF NOT EXISTS operations.service_zone (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  code text NOT NULL,
  display_name text NOT NULL,
  boundary geography(MULTIPOLYGON, 4326) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  dispatch_enabled boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code),
  CHECK (char_length(code) BETWEEN 2 AND 64),
  CHECK (char_length(display_name) BETWEEN 2 AND 160)
);

CREATE INDEX IF NOT EXISTS operations_service_zone_boundary_gix ON operations.service_zone USING gist (boundary);
CREATE INDEX IF NOT EXISTS operations_service_zone_tenant_active_idx ON operations.service_zone (tenant_id, active);

CREATE TABLE IF NOT EXISTS operations.workflow_definition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  code text NOT NULL,
  display_name text NOT NULL,
  transitions jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code, version),
  CHECK (jsonb_typeof(transitions) = 'object')
);

CREATE TABLE IF NOT EXISTS operations.work_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  external_reference text NOT NULL,
  title text NOT NULL,
  state operations.work_state NOT NULL DEFAULT 'draft',
  state_version integer NOT NULL DEFAULT 1 CHECK (state_version > 0),
  priority smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  service_zone_id uuid REFERENCES operations.service_zone(id) ON DELETE SET NULL,
  workflow_id uuid REFERENCES operations.workflow_definition(id) ON DELETE SET NULL,
  assignee_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  scheduled_for timestamptz,
  completed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, external_reference),
  CHECK (char_length(external_reference) BETWEEN 1 AND 128),
  CHECK (char_length(title) BETWEEN 1 AND 240)
);

CREATE INDEX IF NOT EXISTS operations_work_order_queue_idx ON operations.work_order (tenant_id, state, priority DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS operations_work_order_assignee_idx ON operations.work_order (tenant_id, assignee_user_id, state);

CREATE TABLE IF NOT EXISTS operations.work_order_stop (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES operations.work_order(id) ON DELETE CASCADE,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  stop_kind operations.stop_kind NOT NULL,
  display_name text NOT NULL,
  address_text text NOT NULL,
  location geography(POINT, 4326) NOT NULL,
  service_window_start timestamptz,
  service_window_end timestamptz,
  completed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (work_order_id, sequence_no),
  CHECK (char_length(display_name) BETWEEN 1 AND 160),
  CHECK (char_length(address_text) BETWEEN 1 AND 500),
  CHECK (service_window_end IS NULL OR service_window_start IS NULL OR service_window_end >= service_window_start)
);

CREATE INDEX IF NOT EXISTS operations_work_order_stop_location_gix ON operations.work_order_stop USING gist (location);

CREATE TABLE IF NOT EXISTS operations.work_order_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES operations.work_order(id) ON DELETE CASCADE,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  event_type text NOT NULL,
  previous_state operations.work_state,
  next_state operations.work_state,
  actor_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (work_order_id, sequence_no),
  UNIQUE (work_order_id, idempotency_key),
  CHECK (char_length(event_type) BETWEEN 1 AND 96)
);

CREATE TABLE IF NOT EXISTS operations.tracking_position (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  work_order_id uuid NOT NULL REFERENCES operations.work_order(id) ON DELETE CASCADE,
  subject_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  observed_at timestamptz NOT NULL,
  point geography(POINT, 4326) NOT NULL,
  accuracy_m numeric(8,2) CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
  source text NOT NULL,
  integrity_score smallint NOT NULL DEFAULT 100 CHECK (integrity_score BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (work_order_id, subject_user_id, observed_at, source),
  CHECK (char_length(source) BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS operations_tracking_position_order_time_idx ON operations.tracking_position (work_order_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS operations_tracking_position_gix ON operations.tracking_position USING gist (point);

CREATE TABLE IF NOT EXISTS operations.webhook_subscription (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  display_name text NOT NULL,
  endpoint_url text NOT NULL,
  secret_ref text NOT NULL,
  event_types text[] NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK (endpoint_url ~ '^https://'),
  CHECK (char_length(secret_ref) BETWEEN 1 AND 128),
  CHECK (cardinality(event_types) > 0)
);

CREATE TABLE IF NOT EXISTS operations.webhook_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES operations.webhook_subscription(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES operations.work_order_event(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  state operations.delivery_state NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  response_status integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (subscription_id, event_id)
);

CREATE INDEX IF NOT EXISTS operations_webhook_delivery_due_idx
  ON operations.webhook_delivery (state, next_attempt_at)
  WHERE state IN ('queued','retry_scheduled');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'switchos_service') THEN
    GRANT USAGE ON SCHEMA operations TO switchos_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA operations TO switchos_service;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA operations TO switchos_service;
  END IF;
END;
$$;
