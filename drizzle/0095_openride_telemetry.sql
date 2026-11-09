-- OpenRide integration, Phase 2 (contract C2): driver track summaries with
-- server-side fare verification against mobility.fare_quote.quoted_distance_m.
-- verdict rules: |variance_pct| > 15 -> 'suspect'; missing quote -> 'unverifiable'.
-- Mobility tables live in the mobility schema (see 0026_ride_hailing_dispatch.sql).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS mobility.trip_track (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES mobility.ride_trip(id) ON DELETE CASCADE,
  driver_user_id integer NOT NULL REFERENCES public.users(id),
  distance_m integer CHECK (distance_m >= 0),
  moving_time_s integer,
  total_time_s integer,
  max_speed_kph numeric,
  polyline6 text,
  point_count integer,
  variance_pct numeric,
  verdict text NOT NULL CHECK (verdict IN ('ok', 'suspect', 'unverifiable')),
  raw jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mobility_trip_track_trip_idx
  ON mobility.trip_track (trip_id);
CREATE INDEX IF NOT EXISTS mobility_trip_track_driver_created_idx
  ON mobility.trip_track (driver_user_id, created_at DESC);

-- Supports ingestTrack store-and-forward dedupe: OpenRide retries the same
-- track summary (same deviceId + startedAt) after offline queueing; the raw
-- payload retains the original C2 JSON so the lookup is by raw->> fields.
CREATE INDEX IF NOT EXISTS mobility_trip_track_device_dedupe_idx
  ON mobility.trip_track (trip_id, (raw->>'deviceId'), (raw->>'startedAt'));
