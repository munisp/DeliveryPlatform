-- Independent H3 acceleration for real-time ride matching.
-- PostGIS geography remains the authoritative distance and service-zone predicate.

ALTER TABLE mobility.driver_presence
  ADD COLUMN IF NOT EXISTS h3_cell_r9 text;

ALTER TABLE mobility.ride_trip
  ADD COLUMN IF NOT EXISTS pickup_h3_cell_r9 text;

CREATE INDEX IF NOT EXISTS mobility_driver_presence_zone_h3_available_idx
  ON mobility.driver_presence (zone_id, h3_cell_r9, driver_user_id)
  WHERE state = 'available';

CREATE INDEX IF NOT EXISTS mobility_ride_trip_pickup_h3_idx
  ON mobility.ride_trip (pickup_h3_cell_r9)
  WHERE pickup_h3_cell_r9 IS NOT NULL;

CREATE TABLE IF NOT EXISTS mobility.h3_cell_projection (
  driver_user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  zone_id uuid NOT NULL REFERENCES mobility.service_zone(id) ON DELETE RESTRICT,
  h3_cell_r9 text NOT NULL,
  presence_version bigint NOT NULL CHECK (presence_version >= 0),
  projected_at timestamptz NOT NULL DEFAULT NOW(),
  expires_at timestamptz NOT NULL,
  UNIQUE (driver_user_id, presence_version)
);

CREATE INDEX IF NOT EXISTS mobility_h3_cell_projection_lookup_idx
  ON mobility.h3_cell_projection (zone_id, h3_cell_r9, expires_at);

CREATE OR REPLACE FUNCTION mobility.set_trip_pickup_h3_cell(_trip_id uuid, _h3_cell_r9 text)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE mobility.ride_trip
  SET pickup_h3_cell_r9 = NULLIF(BTRIM(_h3_cell_r9), ''), updated_at = NOW()
  WHERE id = _trip_id;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'switchos_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON mobility.h3_cell_projection TO switchos_service;
    GRANT EXECUTE ON FUNCTION mobility.set_trip_pickup_h3_cell(uuid, text) TO switchos_service;
  END IF;
END;
$$;
