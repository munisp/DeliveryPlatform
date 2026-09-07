-- Durable asynchronous verification queue for signed payment callbacks.
-- The HTTP webhook path records a validated callback, while bounded workers perform
-- provider verification and financial settlement outside the provider request window.

ALTER TABLE mobility.provider_webhook_event
  ADD COLUMN IF NOT EXISTS event_type text,
  ADD COLUMN IF NOT EXISTS provider_reference text,
  ADD COLUMN IF NOT EXISTS processing_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;

UPDATE mobility.provider_webhook_event
SET event_type = COALESCE(NULLIF(event_type, ''), NULLIF(raw_payload->>'event', ''), 'historical.unknown'),
    provider_reference = COALESCE(NULLIF(provider_reference, ''), NULLIF(raw_payload->'data'->>'reference', ''), NULLIF(raw_payload->'data'->>'transfer_code', ''), provider_event_id)
WHERE event_type IS NULL OR event_type = '' OR provider_reference IS NULL OR provider_reference = '';

UPDATE mobility.provider_webhook_event
SET processed_at = COALESCE(processed_at, NOW()),
    processing_error = COALESCE(processing_error, 'historical webhook lacks a recognized event or immutable provider reference'),
    processing_started_at = NULL
WHERE event_type = 'historical.unknown';

ALTER TABLE mobility.provider_webhook_event
  ALTER COLUMN event_type SET NOT NULL,
  ALTER COLUMN provider_reference SET NOT NULL;

CREATE INDEX IF NOT EXISTS provider_webhook_event_pending_idx
  ON mobility.provider_webhook_event (provider, next_attempt_at, received_at)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS provider_webhook_event_recovery_idx
  ON mobility.provider_webhook_event (provider, processing_started_at)
  WHERE processed_at IS NULL AND processing_started_at IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'switchos_service') THEN
    GRANT USAGE ON SCHEMA mobility TO switchos_service;
    GRANT SELECT, INSERT, UPDATE ON mobility.provider_webhook_event TO switchos_service;
  END IF;
END $$;
