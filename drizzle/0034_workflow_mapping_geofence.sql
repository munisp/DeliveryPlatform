-- Independently designed logistics workflow authoring, map controls, and geofence events.
-- All entities remain tenant scoped; geographic data is durable in PostgreSQL/PostGIS.

CREATE TYPE operations.workflow_definition_state AS ENUM ('draft', 'published', 'archived');
CREATE TYPE operations.geofence_event_type AS ENUM ('entered', 'exited', 'dwelled');

CREATE TABLE operations.workflow_definition (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  workflow_code TEXT NOT NULL CHECK (workflow_code ~ '^[A-Z0-9][A-Z0-9_-]{1,62}$'),
  version INTEGER NOT NULL CHECK (version > 0),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
  state operations.workflow_definition_state NOT NULL DEFAULT 'draft',
  work_state_transitions JSONB NOT NULL,
  required_stop_kinds TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  input_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 80),
  created_by INTEGER NOT NULL,
  published_by INTEGER NULL,
  published_at TIMESTAMPTZ NULL,
  archived_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, workflow_code, version),
  CHECK ((state = 'published') = (published_at IS NOT NULL AND published_by IS NOT NULL)),
  CHECK (jsonb_typeof(work_state_transitions) = 'object'),
  CHECK (jsonb_typeof(input_schema) = 'object')
);
CREATE UNIQUE INDEX workflow_definition_one_published_idx
  ON operations.workflow_definition (tenant_id, workflow_code)
  WHERE state = 'published';
CREATE INDEX workflow_definition_tenant_state_idx
  ON operations.workflow_definition (tenant_id, state, updated_at DESC);

ALTER TABLE operations.work_order
  ADD COLUMN IF NOT EXISTS workflow_definition_id UUID NULL REFERENCES operations.workflow_definition(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS workflow_definition_version INTEGER NULL;
CREATE INDEX IF NOT EXISTS work_order_workflow_idx
  ON operations.work_order (tenant_id, workflow_definition_id, updated_at DESC)
  WHERE workflow_definition_id IS NOT NULL;

CREATE TABLE operations.geofence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  code TEXT NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,62}$'),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
  boundary GEOGRAPHY(MULTIPOLYGON,4326) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  dwell_threshold_seconds INTEGER NOT NULL DEFAULT 300 CHECK (dwell_threshold_seconds BETWEEN 30 AND 86400),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code),
  CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX geofence_boundary_gist_idx ON operations.geofence USING GIST (boundary);
CREATE INDEX geofence_active_tenant_idx ON operations.geofence (tenant_id, active) WHERE active = TRUE;

CREATE TABLE operations.geofence_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  geofence_id UUID NOT NULL REFERENCES operations.geofence(id) ON DELETE RESTRICT,
  work_order_id UUID NULL REFERENCES operations.work_order(id) ON DELETE CASCADE,
  subject_user_id INTEGER NULL,
  position_id BIGINT NULL REFERENCES operations.tracking_position(id) ON DELETE SET NULL,
  event_type operations.geofence_event_type NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 160),
  decision_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, geofence_id, idempotency_key),
  CHECK (jsonb_typeof(decision_context) = 'object')
);
CREATE INDEX geofence_event_tenant_observed_idx ON operations.geofence_event (tenant_id, observed_at DESC);
CREATE INDEX geofence_event_work_order_idx ON operations.geofence_event (work_order_id, observed_at DESC) WHERE work_order_id IS NOT NULL;

CREATE OR REPLACE VIEW operations.current_tracking_position AS
SELECT DISTINCT ON (tenant_id, work_order_id)
  tenant_id, work_order_id, subject_user_id, observed_at, point, accuracy_m, integrity_score, source
FROM operations.tracking_position
ORDER BY tenant_id, work_order_id, observed_at DESC, id DESC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'switchos_service') THEN
    GRANT SELECT, INSERT, UPDATE ON operations.workflow_definition TO switchos_service;
    GRANT SELECT, INSERT, UPDATE ON operations.geofence TO switchos_service;
    GRANT SELECT, INSERT ON operations.geofence_event TO switchos_service;
    GRANT SELECT ON operations.current_tracking_position TO switchos_service;
  END IF;
END;
$$;
