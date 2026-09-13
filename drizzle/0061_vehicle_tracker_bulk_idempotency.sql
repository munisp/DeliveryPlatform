-- Global tracker-event identity remains non-partitioned so future observed_at range partitions cannot weaken replay protection.
-- PostgreSQL/PostGIS remains authoritative; runtime roles receive function-only access.

CREATE TABLE IF NOT EXISTS vehicle_access.tracker_signal_idempotency (
  tracker_id uuid NOT NULL REFERENCES vehicle_access.vehicle_asset_tracker(id) ON DELETE RESTRICT,
  external_event_id text NOT NULL CHECK (length(external_event_id) BETWEEN 8 AND 160),
  payload_digest bytea NOT NULL CHECK (octet_length(payload_digest) = 32),
  tracker_signal_id uuid NOT NULL,
  first_observed_at timestamptz NOT NULL,
  registered_at timestamptz NOT NULL,
  PRIMARY KEY (tracker_id, external_event_id),
  UNIQUE (tracker_signal_id)
);
CREATE INDEX IF NOT EXISTS vehicle_access_tracker_signal_idempotency_observed_idx
  ON vehicle_access.tracker_signal_idempotency (first_observed_at DESC);

-- Seed the durable global identity registry from existing non-partitioned signal evidence before new bulk writes use it.
INSERT INTO vehicle_access.tracker_signal_idempotency(
  tracker_id, external_event_id, payload_digest, tracker_signal_id, first_observed_at, registered_at
)
SELECT tracker_id, external_event_id, payload_digest, id, observed_at, received_at
FROM vehicle_access.vehicle_tracker_signal
ON CONFLICT (tracker_id, external_event_id) DO NOTHING;

CREATE OR REPLACE FUNCTION vehicle_access.reject_tracker_signal_idempotency_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, vehicle_access AS $$
BEGIN
  RAISE EXCEPTION 'vehicle tracker signal identity is append-only' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS vehicle_access_tracker_signal_idempotency_append_only
  ON vehicle_access.tracker_signal_idempotency;
CREATE TRIGGER vehicle_access_tracker_signal_idempotency_append_only
  BEFORE UPDATE OR DELETE ON vehicle_access.tracker_signal_idempotency
  FOR EACH ROW EXECUTE FUNCTION vehicle_access.reject_tracker_signal_idempotency_mutation();

CREATE OR REPLACE FUNCTION vehicle_access.bulk_record_tracker_provider_signals(
  p_provider uuid,
  p_claim_token uuid,
  p_source vehicle_access.tracker_ingest_source,
  p_records jsonb,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, vehicle_access AS $$
DECLARE
  v_cursor vehicle_access.tracker_provider_ingest_cursor%ROWTYPE;
  v_provider_kind vehicle_access.tracker_provider_kind;
  v_item jsonb;
  v_index integer := 0;
  v_tracker uuid;
  v_existing vehicle_access.tracker_signal_idempotency%ROWTYPE;
  v_signal_id uuid;
  v_external_device_id text;
  v_external_event_id text;
  v_payload_hex text;
  v_payload bytea;
  v_kind vehicle_access.tracker_signal_kind;
  v_observed_at timestamptz;
  v_latitude numeric;
  v_longitude numeric;
  v_speed_kph numeric;
  v_heading_degrees numeric;
  v_accuracy_m numeric;
  v_odometer_km numeric;
  v_ignition_on boolean;
  v_integrity_score smallint;
  v_normalized_payload jsonb;
  v_outcomes jsonb := '[]'::jsonb;
  v_recorded integer := 0;
  v_duplicates integer := 0;
  v_skipped integer := 0;
BEGIN
  IF jsonb_typeof(p_records) <> 'array'
     OR jsonb_array_length(p_records) NOT BETWEEN 1 AND 250
     OR pg_column_size(p_records) > 1048576 THEN
    RAISE EXCEPTION 'invalid tracker signal bulk input' USING ERRCODE = '22023';
  END IF;

  SELECT c.* INTO v_cursor
  FROM vehicle_access.tracker_provider p
  JOIN vehicle_access.tracker_provider_ingest_cursor c ON c.tracker_provider_id = p.id
  WHERE p.id = p_provider AND p.state = 'active'
  FOR UPDATE OF p, c;
  IF NOT FOUND OR v_cursor.claim_token <> p_claim_token OR v_cursor.claim_expires_at <= p_now THEN
    RAISE EXCEPTION 'tracker provider ingest claim fence mismatch' USING ERRCODE = '55000';
  END IF;
  SELECT provider_kind INTO v_provider_kind
  FROM vehicle_access.tracker_provider
  WHERE id = p_provider;
  IF (v_provider_kind = 'geotab_feed' AND p_source <> 'geotab_getfeed')
     OR (v_provider_kind = 'traccar_rest' AND p_source NOT IN ('traccar_rest', 'traccar_websocket')) THEN
    RAISE EXCEPTION 'tracker provider ingest source mismatch' USING ERRCODE = '23514';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_records)
  LOOP
    v_index := v_index + 1;
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'invalid tracker signal bulk record' USING ERRCODE = '22023';
    END IF;
    v_external_device_id := coalesce(v_item ->> 'external_device_id', '');
    v_external_event_id := coalesce(v_item ->> 'external_event_id', '');
    v_payload_hex := coalesce(v_item ->> 'payload_sha256_hex', '');
    v_normalized_payload := v_item -> 'normalized_payload';
    IF length(v_external_device_id) NOT BETWEEN 1 AND 160
       OR length(v_external_event_id) NOT BETWEEN 8 AND 160
       OR v_payload_hex !~ '^[a-f0-9]{64}$'
       OR jsonb_typeof(v_normalized_payload) <> 'object' THEN
      RAISE EXCEPTION 'invalid tracker signal bulk record' USING ERRCODE = '22023';
    END IF;
    v_payload := decode(v_payload_hex, 'hex');

    SELECT t.id INTO v_tracker
    FROM vehicle_access.vehicle_asset_tracker t
    JOIN vehicle_access.tracker_provider p ON p.id = t.tracker_provider_id
    WHERE t.tracker_provider_id = p_provider
      AND p.state = 'active'
      AND t.state = 'active'
      AND t.external_device_id = v_external_device_id
    LIMIT 1;
    IF v_tracker IS NULL THEN
      v_skipped := v_skipped + 1;
      v_outcomes := v_outcomes || jsonb_build_array(jsonb_build_object(
        'index', v_index, 'external_event_id', v_external_event_id, 'outcome', 'unknown_device'
      ));
      CONTINUE;
    END IF;

    -- Serialize one tracker/event identity even if separate provider workers race during recovery.
    PERFORM pg_advisory_xact_lock(hashtextextended(v_tracker::text || ':' || v_external_event_id, 0));
    SELECT * INTO v_existing
    FROM vehicle_access.tracker_signal_idempotency
    WHERE tracker_id = v_tracker AND external_event_id = v_external_event_id;
    IF FOUND THEN
      IF v_existing.payload_digest <> v_payload THEN
        RAISE EXCEPTION 'tracker event id reused with different payload' USING ERRCODE = '23505';
      END IF;
      v_duplicates := v_duplicates + 1;
      v_outcomes := v_outcomes || jsonb_build_array(jsonb_build_object(
        'index', v_index, 'external_event_id', v_external_event_id,
        'tracker_signal_id', v_existing.tracker_signal_id, 'outcome', 'duplicate'
      ));
      CONTINUE;
    END IF;

    BEGIN
      v_kind := (v_item ->> 'signal_kind')::vehicle_access.tracker_signal_kind;
      v_observed_at := (v_item ->> 'observed_at')::timestamptz;
      v_latitude := NULLIF(v_item ->> 'latitude', '')::numeric;
      v_longitude := NULLIF(v_item ->> 'longitude', '')::numeric;
      v_speed_kph := NULLIF(v_item ->> 'speed_kph', '')::numeric;
      v_heading_degrees := NULLIF(v_item ->> 'heading_degrees', '')::numeric;
      v_accuracy_m := NULLIF(v_item ->> 'accuracy_m', '')::numeric;
      v_odometer_km := NULLIF(v_item ->> 'odometer_km', '')::numeric;
      v_ignition_on := CASE WHEN v_item ? 'ignition_on' AND v_item ->> 'ignition_on' <> ''
        THEN (v_item ->> 'ignition_on')::boolean ELSE NULL END;
      v_integrity_score := (v_item ->> 'integrity_score')::smallint;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'invalid tracker signal bulk record' USING ERRCODE = '22023';
    END;

    v_signal_id := vehicle_access.record_vehicle_tracker_signal(
      v_tracker, v_external_event_id, v_kind, v_observed_at,
      v_latitude, v_longitude, v_speed_kph, v_heading_degrees, v_accuracy_m, v_odometer_km,
      v_ignition_on, v_integrity_score, v_payload_hex, v_normalized_payload, p_now
    );
    INSERT INTO vehicle_access.tracker_signal_idempotency(
      tracker_id, external_event_id, payload_digest, tracker_signal_id, first_observed_at, registered_at
    ) VALUES (
      v_tracker, v_external_event_id, v_payload, v_signal_id, v_observed_at, p_now
    );
    v_recorded := v_recorded + 1;
    v_outcomes := v_outcomes || jsonb_build_array(jsonb_build_object(
      'index', v_index, 'external_event_id', v_external_event_id,
      'tracker_signal_id', v_signal_id, 'outcome', 'recorded'
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'recorded', v_recorded,
    'duplicates', v_duplicates,
    'unknown_devices', v_skipped,
    'outcomes', v_outcomes
  );
END;
$$;

REVOKE ALL ON TABLE vehicle_access.tracker_signal_idempotency FROM PUBLIC;
REVOKE ALL ON FUNCTION vehicle_access.bulk_record_tracker_provider_signals(uuid,uuid,vehicle_access.tracker_ingest_source,jsonb,timestamptz) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vehicle_access_service') THEN
    GRANT EXECUTE ON FUNCTION vehicle_access.bulk_record_tracker_provider_signals(uuid,uuid,vehicle_access.tracker_ingest_source,jsonb,timestamptz) TO vehicle_access_service;
  END IF;
END $$;
