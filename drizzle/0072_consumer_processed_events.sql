-- Consumer-side idempotency ledger for broker (Kafka / Fluvio Kafka-compatible /
-- Dapr pub-sub) event processing.
--
-- Broker delivery is at-least-once; exactly-once exists only at the outbox
-- level. Any consumer that mutates state in response to a broker event must
-- check-and-insert a row here (or in its service-local equivalent keyed the
-- same way) in the SAME database transaction as that state mutation, so a
-- redelivered (topic, event_id) is acknowledged without re-applying effects.
-- event_id is partition-agnostic: producers must supply a stable event id or
-- idempotency key in the payload/headers, never topic+partition+offset.

BEGIN;

CREATE TABLE IF NOT EXISTS public.consumer_processed_events (
  consumer_name text NOT NULL CHECK (length(btrim(consumer_name)) BETWEEN 1 AND 128),
  topic text NOT NULL CHECK (length(btrim(topic)) BETWEEN 1 AND 255),
  event_id text NOT NULL CHECK (length(btrim(event_id)) BETWEEN 1 AND 255),
  result_json jsonb,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, topic, event_id)
);

CREATE INDEX IF NOT EXISTS idx_consumer_processed_events_processed_at
  ON public.consumer_processed_events (processed_at DESC);

COMMENT ON TABLE public.consumer_processed_events IS
  'Idempotent-processing guard for at-least-once broker consumers: insert in the same transaction as the consumer state mutation; a primary-key conflict means the event was already applied.';

COMMIT;
