ALTER TABLE mobility.provider_webhook_event
  ADD COLUMN IF NOT EXISTS resilience_run_id varchar(81),
  ADD COLUMN IF NOT EXISTS request_id varchar(81);

CREATE INDEX IF NOT EXISTS provider_webhook_event_resilience_run_received_idx
  ON mobility.provider_webhook_event (provider, resilience_run_id, received_at)
  WHERE resilience_run_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'switchos_service') THEN
    GRANT SELECT, INSERT, UPDATE ON mobility.provider_webhook_event TO switchos_service;
  END IF;
END;
$$;
