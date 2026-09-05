-- Durable, idempotent location ingestion for the driver gateway.
-- PostgreSQL/PostGIS remains the authority; Redis stores only a derived acceleration projection.

CREATE TABLE IF NOT EXISTS mobility.driver_location_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_user_id integer NOT NULL REFERENCES mobility.driver_profile(user_id) ON DELETE RESTRICT,
  device_session_id uuid NOT NULL,
  source_sequence bigint NOT NULL CHECK (source_sequence > 0),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT NOW(),
  point geography(Point, 4326) NOT NULL,
  accuracy_m numeric(8,2) NOT NULL CHECK (accuracy_m >= 0 AND accuracy_m <= 10000),
  integrity_score smallint NOT NULL CHECK (integrity_score BETWEEN 0 AND 100),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  accepted boolean NOT NULL,
  rejection_reason text,
  CONSTRAINT mobility_driver_location_event_stream_unique UNIQUE (driver_user_id, device_session_id, source_sequence),
  CONSTRAINT mobility_driver_location_event_acceptance_reason CHECK (
    (accepted AND rejection_reason IS NULL) OR (NOT accepted AND rejection_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS mobility_driver_location_event_driver_received_idx
  ON mobility.driver_location_event (driver_user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS mobility_driver_location_event_received_idx
  ON mobility.driver_location_event (received_at DESC);

-- Used only as an out-of-order guard for a device's location stream. The general
-- presence version is retained for cache projection and state changes.
ALTER TABLE mobility.driver_presence
  ADD COLUMN IF NOT EXISTS last_location_source_at timestamptz;

CREATE INDEX IF NOT EXISTS mobility_driver_presence_location_source_idx
  ON mobility.driver_presence (last_location_source_at DESC)
  WHERE state = 'available';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'switchos_service') THEN
    GRANT SELECT, INSERT ON mobility.driver_location_event TO switchos_service;
    GRANT SELECT, UPDATE (last_point, last_location_at, last_location_source_at, location_valid_until, accuracy_m, integrity_score, version, updated_at) ON mobility.driver_presence TO switchos_service;
  END IF;
END $$;
