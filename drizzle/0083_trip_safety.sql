-- Trip safety (R2: passenger manifest for shared/booked rides, R8: SOS).
-- Passenger manifests carry only sha256 NIN digests (never raw national IDs),
-- mirroring the rider_verifications privacy rule from 0080.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.passenger_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id text NOT NULL,
  booked_by bigint REFERENCES public.users(id) ON DELETE RESTRICT,
  -- Array of {name text, nin_hash text?, verified boolean, flags text[]}.
  passengers jsonb NOT NULL,
  manifest_verified boolean NOT NULL DEFAULT false,
  verified_via text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id)
);

CREATE TABLE IF NOT EXISTS public.sos_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id text,
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('driver', 'rider')),
  h3_index text,
  lat numeric(10,7),
  lng numeric(10,7),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'cancelled')),
  resolved_by bigint REFERENCES public.users(id) ON DELETE RESTRICT,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sos_events_trip_idx ON public.sos_events (trip_id);
CREATE INDEX IF NOT EXISTS sos_events_status_idx ON public.sos_events (status);

CREATE TABLE IF NOT EXISTS public.trip_safety_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id text NOT NULL,
  signal_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trip_safety_signals_trip_idx
  ON public.trip_safety_signals (trip_id);
CREATE INDEX IF NOT EXISTS trip_safety_signals_type_idx
  ON public.trip_safety_signals (signal_type);
