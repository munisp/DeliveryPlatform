-- Provider-specific telemetry ingestion cursors and immutable batch evidence.
-- Extends 0059 without adding a device-control command or direct runtime table access.

DO $$ BEGIN
  CREATE TYPE vehicle_access.tracker_ingest_source AS ENUM (
    'geotab_getfeed', 'traccar_rest', 'traccar_websocket'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS vehicle_access.tracker_provider_ingest_cursor (
  tracker_provider_id uuid PRIMARY KEY REFERENCES vehicle_access.tracker_provider(id) ON DELETE RESTRICT,
  feed_cursor text NULL CHECK (feed_cursor IS NULL OR length(feed_cursor) BETWEEN 1 AND 512),
  claim_token uuid NULL UNIQUE,
  claimed_by text NULL CHECK (claimed_by IS NULL OR length(claimed_by) BETWEEN 3 AND 128),
  claimed_at timestamptz NULL,
  claim_expires_at timestamptz NULL,
  last_success_at timestamptz NULL,
  last_error_code text NULL CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_.-]{2,120}$'),
  last_error_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((claim_token IS NULL) = (claimed_by IS NULL)),
  CHECK ((claim_token IS NULL) = (claimed_at IS NULL)),
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)),
  CHECK (claim_expires_at IS NULL OR claim_expires_at > claimed_at)
);

CREATE TABLE IF NOT EXISTS vehicle_access.tracker_provider_ingest_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracker_provider_id uuid NOT NULL REFERENCES vehicle_access.tracker_provider(id) ON DELETE RESTRICT,
  source vehicle_access.tracker_ingest_source NOT NULL,
  batch_key text NOT NULL CHECK (batch_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  expected_cursor text NULL CHECK (expected_cursor IS NULL OR length(expected_cursor) BETWEEN 1 AND 512),
  next_cursor text NULL CHECK (next_cursor IS NULL OR length(next_cursor) BETWEEN 1 AND 512),
  payload_digest bytea NOT NULL CHECK (octet_length(payload_digest) = 32),
  record_count integer NOT NULL CHECK (record_count BETWEEN 0 AND 50000),
  claimed_by text NOT NULL CHECK (length(claimed_by) BETWEEN 3 AND 128),
  committed_at timestamptz NOT NULL,
  UNIQUE (tracker_provider_id, batch_key)
);
CREATE INDEX IF NOT EXISTS vehicle_access_tracker_provider_ingest_batch_recent_idx
  ON vehicle_access.tracker_provider_ingest_batch (tracker_provider_id, committed_at DESC);

DROP TRIGGER IF EXISTS vehicle_access_tracker_provider_ingest_batch_append_only
  ON vehicle_access.tracker_provider_ingest_batch;
CREATE TRIGGER vehicle_access_tracker_provider_ingest_batch_append_only
  BEFORE UPDATE OR DELETE ON vehicle_access.tracker_provider_ingest_batch
  FOR EACH ROW EXECUTE FUNCTION vehicle_access.reject_tracker_evidence_mutation();

-- Backfill state rows for already registered poll/REST providers before new provider creation is overridden below.
INSERT INTO vehicle_access.tracker_provider_ingest_cursor (tracker_provider_id, updated_at)
SELECT id, clock_timestamp()
FROM vehicle_access.tracker_provider
WHERE provider_kind IN ('geotab_feed', 'traccar_rest')
ON CONFLICT (tracker_provider_id) DO NOTHING;

CREATE OR REPLACE FUNCTION vehicle_access.create_tracker_provider(
  p_actor integer, p_fleet_provider uuid, p_kind vehicle_access.tracker_provider_kind, p_integration_key text,
  p_display_name text, p_credential_ref text, p_key text, p_now timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN
    RAISE EXCEPTION 'operator role required' USING ERRCODE='42501';
  END IF;
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR p_integration_key !~ '^[a-z][a-z0-9_.-]{2,80}$'
     OR length(coalesce(p_display_name,'')) NOT BETWEEN 2 AND 160
     OR length(coalesce(p_credential_ref,'')) NOT BETWEEN 8 AND 160 THEN
    RAISE EXCEPTION 'invalid tracker provider input' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM vehicle_access.fleet_provider
    WHERE id=p_fleet_provider AND state='active'
  ) THEN
    RAISE EXCEPTION 'active fleet provider required' USING ERRCODE='23514';
  END IF;
  SELECT id INTO v_id
  FROM vehicle_access.tracker_provider
  WHERE fleet_provider_id=p_fleet_provider AND idempotency_key=p_key;
  IF v_id IS NOT NULL THEN
    IF p_kind IN ('geotab_feed', 'traccar_rest') THEN
      INSERT INTO vehicle_access.tracker_provider_ingest_cursor(tracker_provider_id,updated_at)
      VALUES(v_id,p_now) ON CONFLICT (tracker_provider_id) DO NOTHING;
    END IF;
    RETURN v_id;
  END IF;
  INSERT INTO vehicle_access.tracker_provider(
    fleet_provider_id,provider_kind,integration_key,display_name,credential_ref,state,
    created_by_user_id,created_at,updated_at,idempotency_key
  ) VALUES(
    p_fleet_provider,p_kind,p_integration_key,p_display_name,p_credential_ref,'active',
    p_actor,p_now,p_now,p_key
  ) RETURNING id INTO v_id;
  IF p_kind IN ('geotab_feed', 'traccar_rest') THEN
    INSERT INTO vehicle_access.tracker_provider_ingest_cursor(tracker_provider_id,updated_at)
    VALUES(v_id,p_now);
  END IF;
  PERFORM vehicle_access.append_tracker_control_event(
    'tracker_provider',v_id,p_actor,'vehicle_access.tracker_provider.created',
    jsonb_build_object('kind',p_kind,'fleet_provider_id',p_fleet_provider),p_key,p_now
  );
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.resolve_active_tracker_for_provider_ingest(
  p_tracker_provider uuid,p_external_device_id text
) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
  SELECT t.id
  FROM vehicle_access.vehicle_asset_tracker t
  JOIN vehicle_access.tracker_provider p ON p.id=t.tracker_provider_id
  WHERE t.tracker_provider_id=p_tracker_provider
    AND p.state='active'
    AND t.state='active'
    AND t.external_device_id=p_external_device_id
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.claim_tracker_provider_ingest(
  p_kind vehicle_access.tracker_provider_kind, p_worker text,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE(
  tracker_provider_id uuid, integration_key text, credential_ref text,
  provider_kind vehicle_access.tracker_provider_kind, feed_cursor text, claim_token uuid
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_row record; v_token uuid;
BEGIN
  IF p_kind NOT IN ('geotab_feed','traccar_rest')
     OR length(coalesce(p_worker,'')) NOT BETWEEN 3 AND 128 THEN
    RAISE EXCEPTION 'invalid tracker provider ingest claim' USING ERRCODE='22023';
  END IF;
  SELECT p.id,p.integration_key,p.credential_ref,p.provider_kind,c.feed_cursor
  INTO v_row
  FROM vehicle_access.tracker_provider p
  JOIN vehicle_access.tracker_provider_ingest_cursor c ON c.tracker_provider_id=p.id
  WHERE p.provider_kind=p_kind
    AND p.state='active'
    AND (c.claim_expires_at IS NULL OR c.claim_expires_at<=p_now)
  ORDER BY c.last_success_at NULLS FIRST,p.created_at
  FOR UPDATE OF p,c SKIP LOCKED
  LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  v_token := gen_random_uuid();
  UPDATE vehicle_access.tracker_provider_ingest_cursor AS c
  SET claim_token=v_token,claimed_by=p_worker,claimed_at=p_now,
      claim_expires_at=p_now+interval '5 minutes',updated_at=p_now
  WHERE c.tracker_provider_id=v_row.id;
  RETURN QUERY SELECT v_row.id,v_row.integration_key,v_row.credential_ref,
    v_row.provider_kind,v_row.feed_cursor,v_token;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.renew_tracker_provider_ingest_claim(
  p_provider uuid,p_claim_token uuid,p_now timestamptz DEFAULT clock_timestamp()
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
BEGIN
  UPDATE vehicle_access.tracker_provider_ingest_cursor
  SET claim_expires_at=p_now+interval '5 minutes',updated_at=p_now
  WHERE tracker_provider_id=p_provider
    AND claim_token=p_claim_token
    AND claim_expires_at>p_now;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tracker provider ingest claim fence mismatch' USING ERRCODE='55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.complete_tracker_provider_ingest_batch(
  p_provider uuid,p_claim_token uuid,p_source vehicle_access.tracker_ingest_source,
  p_batch_key text,p_expected_cursor text,p_next_cursor text,p_payload_sha256_hex text,
  p_record_count integer,p_keep_claim boolean DEFAULT false,p_now timestamptz DEFAULT clock_timestamp()
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
DECLARE v_cursor vehicle_access.tracker_provider_ingest_cursor%ROWTYPE;
        v_provider_kind vehicle_access.tracker_provider_kind;
        v_existing record;
BEGIN
  IF p_batch_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR p_payload_sha256_hex !~ '^[a-f0-9]{64}$'
     OR p_record_count NOT BETWEEN 0 AND 50000
     OR (p_expected_cursor IS NOT NULL AND length(p_expected_cursor) NOT BETWEEN 1 AND 512)
     OR (p_next_cursor IS NOT NULL AND length(p_next_cursor) NOT BETWEEN 1 AND 512) THEN
    RAISE EXCEPTION 'invalid tracker provider ingest batch' USING ERRCODE='22023';
  END IF;
  SELECT next_cursor,payload_digest INTO v_existing
  FROM vehicle_access.tracker_provider_ingest_batch
  WHERE tracker_provider_id=p_provider AND batch_key=p_batch_key;
  IF FOUND THEN
    IF v_existing.payload_digest<>decode(p_payload_sha256_hex,'hex') THEN
      RAISE EXCEPTION 'tracker provider batch key reused with different payload' USING ERRCODE='23505';
    END IF;
    RETURN coalesce(v_existing.next_cursor,'');
  END IF;
  SELECT c.* INTO v_cursor
  FROM vehicle_access.tracker_provider p
  JOIN vehicle_access.tracker_provider_ingest_cursor c ON c.tracker_provider_id=p.id
  WHERE p.id=p_provider AND p.state='active'
  FOR UPDATE OF p,c;
  IF NOT FOUND OR v_cursor.claim_token<>p_claim_token OR v_cursor.claim_expires_at<=p_now THEN
    RAISE EXCEPTION 'tracker provider ingest claim fence mismatch' USING ERRCODE='55000';
  END IF;
  SELECT provider_kind INTO v_provider_kind
  FROM vehicle_access.tracker_provider WHERE id=p_provider;
  IF (v_provider_kind='geotab_feed' AND p_source<>'geotab_getfeed')
     OR (v_provider_kind='traccar_rest' AND p_source NOT IN ('traccar_rest','traccar_websocket')) THEN
    RAISE EXCEPTION 'tracker provider ingest source mismatch' USING ERRCODE='23514';
  END IF;
  IF v_cursor.feed_cursor IS DISTINCT FROM p_expected_cursor THEN
    RAISE EXCEPTION 'tracker provider ingest cursor mismatch' USING ERRCODE='55000';
  END IF;
  INSERT INTO vehicle_access.tracker_provider_ingest_batch(
    tracker_provider_id,source,batch_key,expected_cursor,next_cursor,payload_digest,
    record_count,claimed_by,committed_at
  ) VALUES(
    p_provider,p_source,p_batch_key,p_expected_cursor,p_next_cursor,
    decode(p_payload_sha256_hex,'hex'),p_record_count,v_cursor.claimed_by,p_now
  );
  UPDATE vehicle_access.tracker_provider_ingest_cursor
  SET feed_cursor=p_next_cursor,
      claim_token=CASE WHEN p_keep_claim THEN claim_token ELSE NULL END,
      claimed_by=CASE WHEN p_keep_claim THEN claimed_by ELSE NULL END,
      claimed_at=CASE WHEN p_keep_claim THEN claimed_at ELSE NULL END,
      claim_expires_at=CASE WHEN p_keep_claim THEN p_now+interval '5 minutes' ELSE NULL END,
      last_success_at=p_now,last_error_code=NULL,last_error_at=NULL,updated_at=p_now
  WHERE tracker_provider_id=p_provider;
  PERFORM vehicle_access.append_tracker_control_event(
    'tracker_provider',p_provider,NULL,'vehicle_access.tracker_provider.ingest_batch_committed',
    jsonb_build_object('source',p_source,'record_count',p_record_count,'next_cursor',p_next_cursor),
    p_batch_key,p_now
  );
  RETURN coalesce(p_next_cursor,'');
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_access.release_tracker_provider_ingest_claim(
  p_provider uuid,p_claim_token uuid,p_error_code text,p_now timestamptz DEFAULT clock_timestamp()
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vehicle_access AS $$
BEGIN
  IF p_error_code !~ '^[a-z][a-z0-9_.-]{2,120}$' THEN
    RAISE EXCEPTION 'invalid tracker provider ingest error code' USING ERRCODE='22023';
  END IF;
  UPDATE vehicle_access.tracker_provider_ingest_cursor
  SET claim_token=NULL,claimed_by=NULL,claimed_at=NULL,claim_expires_at=NULL,
      last_error_code=p_error_code,last_error_at=p_now,updated_at=p_now
  WHERE tracker_provider_id=p_provider
    AND claim_token=p_claim_token
    AND claim_expires_at>p_now;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tracker provider ingest claim fence mismatch' USING ERRCODE='55000';
  END IF;
END;
$$;

REVOKE ALL ON TABLE vehicle_access.tracker_provider_ingest_cursor FROM PUBLIC;
REVOKE ALL ON TABLE vehicle_access.tracker_provider_ingest_batch FROM PUBLIC;
REVOKE ALL ON FUNCTION vehicle_access.resolve_active_tracker_for_provider_ingest(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION vehicle_access.claim_tracker_provider_ingest(vehicle_access.tracker_provider_kind,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION vehicle_access.renew_tracker_provider_ingest_claim(uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION vehicle_access.complete_tracker_provider_ingest_batch(uuid,uuid,vehicle_access.tracker_ingest_source,text,text,text,text,integer,boolean,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION vehicle_access.release_tracker_provider_ingest_claim(uuid,uuid,text,timestamptz) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='vehicle_access_service') THEN
    GRANT EXECUTE ON FUNCTION vehicle_access.create_tracker_provider(integer,uuid,vehicle_access.tracker_provider_kind,text,text,text,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.resolve_active_tracker_for_provider_ingest(uuid,text) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.claim_tracker_provider_ingest(vehicle_access.tracker_provider_kind,text,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.renew_tracker_provider_ingest_claim(uuid,uuid,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.complete_tracker_provider_ingest_batch(uuid,uuid,vehicle_access.tracker_ingest_source,text,text,text,text,integer,boolean,timestamptz) TO vehicle_access_service;
    GRANT EXECUTE ON FUNCTION vehicle_access.release_tracker_provider_ingest_claim(uuid,uuid,text,timestamptz) TO vehicle_access_service;
  END IF;
END $$;
