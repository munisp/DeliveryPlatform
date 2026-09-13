-- Workspace truthfulness: real operational tables for tableside commerce and
-- white-label app workspaces.
--
-- Previously the tableside_ordering and white_label_apps workspaces returned a
-- hard-coded "not configured" failure (or fabricated counts in dead code).
-- These tables are the system of record for dine-in QR venues/sessions and
-- tenant-branded mobile apps so the workspaces report observed database state
-- (including honest zeros) instead of fabricated or unavailable data.
--
-- Additive only: CREATE TABLE IF NOT EXISTS, no seeds, no drops.

BEGIN;

CREATE TABLE IF NOT EXISTS public.tableside_venues (
  id serial PRIMARY KEY,
  provider_id integer NOT NULL REFERENCES public.service_providers(id) ON DELETE CASCADE,
  name varchar(255) NOT NULL,
  qr_enabled boolean NOT NULL DEFAULT false,
  pay_at_table_enabled boolean NOT NULL DEFAULT false,
  upsell_modules jsonb NOT NULL DEFAULT '[]'::jsonb,
  status varchar(32) NOT NULL DEFAULT 'configured',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tableside_venues_provider
  ON public.tableside_venues (provider_id);
CREATE INDEX IF NOT EXISTS idx_tableside_venues_qr
  ON public.tableside_venues (qr_enabled) WHERE qr_enabled;

CREATE TABLE IF NOT EXISTS public.tableside_sessions (
  id serial PRIMARY KEY,
  venue_id integer NOT NULL REFERENCES public.tableside_venues(id) ON DELETE CASCADE,
  table_label varchar(64) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'open',
  opened_at timestamp NOT NULL DEFAULT now(),
  closed_at timestamp
);

CREATE INDEX IF NOT EXISTS idx_tableside_sessions_venue
  ON public.tableside_sessions (venue_id);
CREATE INDEX IF NOT EXISTS idx_tableside_sessions_open
  ON public.tableside_sessions (status) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.white_label_apps (
  id serial PRIMARY KEY,
  provider_id integer NOT NULL REFERENCES public.service_providers(id) ON DELETE CASCADE,
  app_name varchar(255) NOT NULL,
  bundle_id varchar(255) NOT NULL,
  template varchar(64) NOT NULL,
  audience varchar(32) NOT NULL DEFAULT 'consumer',
  status varchar(32) NOT NULL DEFAULT 'draft',
  release_track varchar(32) NOT NULL DEFAULT 'beta',
  push_channel varchar(64),
  launched_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT white_label_apps_bundle_id_unique UNIQUE (bundle_id)
);

CREATE INDEX IF NOT EXISTS idx_white_label_apps_provider
  ON public.white_label_apps (provider_id);
CREATE INDEX IF NOT EXISTS idx_white_label_apps_status
  ON public.white_label_apps (status);

COMMENT ON TABLE public.tableside_venues IS
  'Dine-in venues onboarded to tableside/QR ordering; counts reported by the tableside workspace are computed from this table.';
COMMENT ON TABLE public.tableside_sessions IS
  'Observed tableside dining sessions (open/closed) per venue; active session counts are computed from rows with closed_at IS NULL.';
COMMENT ON TABLE public.white_label_apps IS
  'Tenant-branded mobile app registry; branded-app, template, push-channel, and release-track counts are computed from this table.';

COMMIT;
