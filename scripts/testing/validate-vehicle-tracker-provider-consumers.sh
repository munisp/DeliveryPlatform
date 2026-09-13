#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_NAME="vehicle_tracker_provider_cursor_validation_${$}_$(date +%s)"
ROLE_SERVICE="vehicle_access_service"
ROLE_UNTRUSTED="vehicle_access_untrusted"
CREATED_ROLES=()

cleanup() {
  set +e
  sudo -u postgres dropdb --if-exists "$DB_NAME" >/dev/null 2>&1
  for role in "${CREATED_ROLES[@]:-}"; do
    sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${role}" >/dev/null 2>&1
  done
}
trap cleanup EXIT

role_exists() {
  sudo -u postgres psql -X -At -d postgres -c "SELECT 1 FROM pg_roles WHERE rolname = '$1'" | grep -qx 1
}
role_safe() {
  sudo -u postgres psql -X -At -d postgres -c "SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid OR roleid = pg_roles.oid) FROM pg_roles WHERE rolname = '$1'" | grep -qx t
}
for role in "$ROLE_SERVICE" "$ROLE_UNTRUSTED"; do
  if role_exists "$role"; then
    role_safe "$role" || { echo "vehicle_tracker_provider_cursor=FAIL reason=unsafe_existing_role role=$role" >&2; exit 1; }
  else
    sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS" >/dev/null
    CREATED_ROLES+=("$role")
  fi
done

sudo -u postgres createdb "$DB_NAME"
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION postgis;
CREATE EXTENSION pgcrypto;
CREATE TYPE public.user_role AS ENUM ('user', 'admin');
CREATE TABLE public.users (
  id serial PRIMARY KEY,
  open_id varchar(64) NOT NULL UNIQUE,
  name text,
  role public.user_role NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.users (id, open_id, name, role) VALUES
  (1,'provider-cursor-operator','Provider Cursor Operator','admin'),
  (2,'provider-cursor-worker','Provider Cursor Worker','user'),
  (3,'provider-cursor-untrusted','Provider Cursor Untrusted','user');
SQL
for migration in \
  "$ROOT_DIR/drizzle/0050_gig_worker_vehicle_access.sql" \
  "$ROOT_DIR/drizzle/0058_gig_vehicle_rental_operations.sql" \
  "$ROOT_DIR/drizzle/0059_vehicle_tracker_geofence_safety_controls.sql" \
  "$ROOT_DIR/drizzle/0060_vehicle_tracker_provider_ingest_cursors.sql" \
  "$ROOT_DIR/drizzle/0061_vehicle_tracker_bulk_idempotency.sql" \
  "$ROOT_DIR/drizzle/0062_vehicle_tracker_worker_observability.sql"; do
  sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$migration" >/dev/null
done

recovery_log="$(sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' 2>&1
SET ROLE vehicle_access_service;
SELECT vehicle_access.create_provider(1,'Cursor Fleet','Cursor Fleet Ltd',timestamptz '2026-09-08 08:00:00+00') AS provider_id \gset
SELECT vehicle_access.create_tracker_provider(1, :'provider_id'::uuid,'geotab_feed','geotab_fleet','Geotab Fleet','secrets/geotab/fleet','geotab-provider-0001',timestamptz '2026-09-08 08:01:00+00') AS geotab_provider_id \gset
SELECT vehicle_access.create_tracker_provider(1, :'provider_id'::uuid,'traccar_rest','traccar_fleet','Traccar Fleet','secrets/traccar/fleet','traccar-provider-0001',timestamptz '2026-09-08 08:01:30+00') AS traccar_provider_id \gset
SELECT vehicle_access.register_asset(1, :'provider_id'::uuid,'CURSOR-VEH-001'::text,repeat('c',64)::text,'Cursor'::text,'Vehicle'::text,2024::integer,0::integer,4::smallint,'["delivery"]'::jsonb,timestamptz '2026-09-08 08:01:40+00') AS asset_id \gset
SELECT vehicle_access.register_asset_tracker(1, :'asset_id'::uuid, :'geotab_provider_id'::uuid,'geotab-device-001',repeat('a',64),false,'cursor-asset-tracker-0001',timestamptz '2026-09-08 08:01:50+00') AS tracker_id \gset

SELECT * FROM vehicle_access.claim_tracker_provider_ingest('geotab_feed'::vehicle_access.tracker_provider_kind,'geotab-worker-0001',timestamptz '2026-09-08 08:02:00+00') \gset
SELECT true AS geotab_initial_cursor_empty;
SELECT vehicle_access.bulk_record_tracker_provider_signals(
  :'tracker_provider_id'::uuid,:'claim_token'::uuid,'geotab_getfeed'::vehicle_access.tracker_ingest_source,
  jsonb_build_array(jsonb_build_object(
    'external_device_id','geotab-device-001','external_event_id','geotab:bulk-event-0001',
    'signal_kind','position','observed_at','2026-09-08T08:02:01Z','latitude',6.5244,'longitude',3.3792,
    'speed_kph',0,'ignition_on',false,'integrity_score',80,
    'payload_sha256_hex',encode(public.digest('bulk-payload-1','sha256'),'hex'),
    'normalized_payload',jsonb_build_object('provider','geotab','id','bulk-event-0001')
  )),timestamptz '2026-09-08 08:02:05+00'
) AS geotab_bulk_first \gset
SELECT (:'geotab_bulk_first'::jsonb ->> 'recorded')::integer = 1 AS geotab_bulk_recorded;
SELECT vehicle_access.bulk_record_tracker_provider_signals(
  :'tracker_provider_id'::uuid,:'claim_token'::uuid,'geotab_getfeed'::vehicle_access.tracker_ingest_source,
  jsonb_build_array(jsonb_build_object(
    'external_device_id','geotab-device-001','external_event_id','geotab:bulk-event-0001',
    'signal_kind','position','observed_at','2026-09-08T08:02:01Z','latitude',6.5244,'longitude',3.3792,
    'speed_kph',0,'ignition_on',false,'integrity_score',80,
    'payload_sha256_hex',encode(public.digest('bulk-payload-1','sha256'),'hex'),
    'normalized_payload',jsonb_build_object('provider','geotab','id','bulk-event-0001')
  )),timestamptz '2026-09-08 08:02:06+00'
) AS geotab_bulk_retry \gset
SELECT (:'geotab_bulk_retry'::jsonb ->> 'duplicates')::integer = 1 AS geotab_bulk_duplicate;
SELECT vehicle_access.complete_tracker_provider_ingest_batch(:'tracker_provider_id'::uuid,:'claim_token'::uuid,'geotab_getfeed'::vehicle_access.tracker_ingest_source,'geotab-batch-0001',NULL,'0000000000000001',encode(public.digest('geotab-batch-1','sha256'),'hex'),2,false,timestamptz '2026-09-08 08:02:10+00') AS geotab_cursor_v1;
SELECT vehicle_access.complete_tracker_provider_ingest_batch(:'tracker_provider_id'::uuid,:'claim_token'::uuid,'geotab_getfeed'::vehicle_access.tracker_ingest_source,'geotab-batch-0001',NULL,'0000000000000001',encode(public.digest('geotab-batch-1','sha256'),'hex'),2,false,timestamptz '2026-09-08 08:02:11+00') = '0000000000000001' AS geotab_retry_idempotent;

SELECT * FROM vehicle_access.claim_tracker_provider_ingest('geotab_feed'::vehicle_access.tracker_provider_kind,'geotab-worker-0002',timestamptz '2026-09-08 08:03:00+00') \gset
SELECT :'feed_cursor' = '0000000000000001' AS geotab_cursor_reclaimed;
SELECT vehicle_access.complete_tracker_provider_ingest_batch(:'tracker_provider_id'::uuid,:'claim_token'::uuid,'geotab_getfeed'::vehicle_access.tracker_ingest_source,'geotab-batch-0002',:'feed_cursor','0000000000000002',encode(public.digest('geotab-batch-2','sha256'),'hex'),1,false,timestamptz '2026-09-08 08:03:10+00') AS geotab_cursor_v2;

SELECT * FROM vehicle_access.claim_tracker_provider_ingest('traccar_rest'::vehicle_access.tracker_provider_kind,'traccar-websocket-0001',timestamptz '2026-09-08 08:04:00+00') \gset
SELECT vehicle_access.complete_tracker_provider_ingest_batch(:'tracker_provider_id'::uuid,:'claim_token'::uuid,'traccar_websocket'::vehicle_access.tracker_ingest_source,'traccar-ws-batch-0001',NULL,'traccar-digest-1',encode(public.digest('traccar-batch-1','sha256'),'hex'),1,true,timestamptz '2026-09-08 08:04:10+00') AS traccar_cursor_v1;
RESET ROLE;
SELECT claim_token = :'claim_token'::uuid AND feed_cursor = 'traccar-digest-1' AS traccar_websocket_claim_retained
FROM vehicle_access.tracker_provider_ingest_cursor WHERE tracker_provider_id=:'tracker_provider_id'::uuid;
SET ROLE vehicle_access_service;
SELECT vehicle_access.renew_tracker_provider_ingest_claim(:'tracker_provider_id'::uuid,:'claim_token'::uuid,timestamptz '2026-09-08 08:04:20+00');
SELECT vehicle_access.release_tracker_provider_ingest_claim(:'tracker_provider_id'::uuid,:'claim_token'::uuid,'vehicle_tracker_provider_transport_failed',timestamptz '2026-09-08 08:04:30+00');

-- Simulate a worker crash: it neither completes nor releases its Traccar cursor lease.
SELECT * FROM vehicle_access.claim_tracker_provider_ingest(
  'traccar_rest'::vehicle_access.tracker_provider_kind,
  'traccar-crashed-worker',
  timestamptz '2026-09-08 08:05:00+00'
) \gset crashed_
SELECT count(*) = 0 AS crash_lease_not_reclaimed_early
FROM vehicle_access.claim_tracker_provider_ingest(
  'traccar_rest'::vehicle_access.tracker_provider_kind,
  'traccar-recovery-worker-early',
  timestamptz '2026-09-08 08:09:59+00'
) \gset
SELECT * FROM vehicle_access.claim_tracker_provider_ingest(
  'traccar_rest'::vehicle_access.tracker_provider_kind,
  'traccar-recovery-worker',
  timestamptz '2026-09-08 08:10:00+00'
) \gset recovered_
SELECT :'crash_lease_not_reclaimed_early'::boolean
  AND :'crashed_claim_token' <> :'recovered_claim_token' AS crash_lease_recovered;
SELECT set_config('app.crashed_provider_id', :'crashed_tracker_provider_id', false),
       set_config('app.crashed_claim_token', :'crashed_claim_token', false),
       set_config('app.recovered_claim_token', :'recovered_claim_token', false);
DO $$
BEGIN
  BEGIN
    PERFORM vehicle_access.renew_tracker_provider_ingest_claim(
      current_setting('app.crashed_provider_id')::uuid,
      current_setting('app.crashed_claim_token')::uuid,
      timestamptz '2026-09-08 08:10:00+00'
    );
    RAISE EXCEPTION 'crashed worker renewed successor lease';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    RAISE NOTICE 'expected crashed worker renewal fence: SQLSTATE %', SQLSTATE;
  END;
END;
$$;
SELECT vehicle_access.release_tracker_provider_ingest_claim(
  :'crashed_tracker_provider_id'::uuid,
  :'recovered_claim_token'::uuid,
  'vehicle_tracker_provider_worker_recovered',
  timestamptz '2026-09-08 08:10:01+00'
);
SELECT CASE WHEN count(*) = 2 THEN 'tracker_observability_rows=PASS'
  ELSE 'tracker_observability_rows=FAIL' END
FROM vehicle_access.list_tracker_provider_ingest_observability(
  timestamptz '2026-09-08 08:10:01+00'
);
SELECT CASE WHEN count(*) = 1 THEN 'tracker_lock_metrics_row=PASS'
  ELSE 'tracker_lock_metrics_row=FAIL' END
FROM vehicle_access.tracker_worker_database_lock_metrics();
RESET ROLE;
SQL
)"

assertion_log="$(sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' 2>&1
SELECT id AS geotab_provider_id FROM vehicle_access.tracker_provider WHERE integration_key='geotab_fleet' \gset
SELECT set_config('app.geotab_provider_id', :'geotab_provider_id', false);
SET ROLE vehicle_access_service;
DO $$
BEGIN
  BEGIN
    PERFORM vehicle_access.complete_tracker_provider_ingest_batch(
      current_setting('app.geotab_provider_id')::uuid,gen_random_uuid(),'geotab_getfeed'::vehicle_access.tracker_ingest_source,
      'geotab-batch-0001',NULL,'different',encode(public.digest('altered','sha256'),'hex'),1,false,clock_timestamp()
    );
    RAISE EXCEPTION 'altered batch replay unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE '23505' THEN
    RAISE NOTICE 'expected altered provider batch rejection: SQLSTATE %', SQLSTATE;
  END;
  BEGIN
    PERFORM 1 FROM vehicle_access.tracker_provider_ingest_cursor;
    RAISE EXCEPTION 'direct provider cursor read unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    RAISE NOTICE 'expected direct provider cursor denial: SQLSTATE %', SQLSTATE;
  END;
  BEGIN
    PERFORM 1 FROM vehicle_access.tracker_signal_idempotency;
    RAISE EXCEPTION 'direct tracker idempotency read unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    RAISE NOTICE 'expected direct tracker idempotency denial: SQLSTATE %', SQLSTATE;
  END;
END;
$$;
RESET ROLE;
DO $$
BEGIN
  BEGIN
    UPDATE vehicle_access.tracker_provider_ingest_batch SET record_count=9;
    RAISE EXCEPTION 'provider batch evidence unexpectedly mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    RAISE NOTICE 'expected append-only provider batch denial: SQLSTATE %', SQLSTATE;
  END;
  BEGIN
    UPDATE vehicle_access.tracker_signal_idempotency SET registered_at=clock_timestamp();
    RAISE EXCEPTION 'tracker signal identity unexpectedly mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    RAISE NOTICE 'expected append-only tracker identity denial: SQLSTATE %', SQLSTATE;
  END;
END;
$$;
SET ROLE vehicle_access_service;
SELECT * FROM vehicle_access.claim_tracker_provider_ingest('geotab_feed'::vehicle_access.tracker_provider_kind,'geotab-worker-0003',clock_timestamp()) \gset
SELECT set_config('app.tracker_provider_id', :'tracker_provider_id', false), set_config('app.claim_token', :'claim_token', false);
DO $$
BEGIN
  BEGIN
    PERFORM vehicle_access.bulk_record_tracker_provider_signals(
      current_setting('app.tracker_provider_id')::uuid,current_setting('app.claim_token')::uuid,
      'geotab_getfeed'::vehicle_access.tracker_ingest_source,
      (SELECT jsonb_agg(jsonb_build_object('external_device_id','geotab-device-001','external_event_id',format('geotab:oversize-%s',n),'signal_kind','position','observed_at','2026-09-08T08:02:01Z','latitude',6.5244,'longitude',3.3792,'integrity_score',80,'payload_sha256_hex',encode(public.digest(format('oversize-%s',n),'sha256'),'hex'),'normalized_payload',jsonb_build_object('n',n))) FROM generate_series(1,251) AS n),
      clock_timestamp()
    );
    RAISE EXCEPTION 'oversize tracker signal batch unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    RAISE NOTICE 'expected oversize tracker signal batch rejection: SQLSTATE %', SQLSTATE;
  END;
  BEGIN
    PERFORM vehicle_access.bulk_record_tracker_provider_signals(
      current_setting('app.tracker_provider_id')::uuid,current_setting('app.claim_token')::uuid,
      'geotab_getfeed'::vehicle_access.tracker_ingest_source,
      jsonb_build_array(jsonb_build_object(
        'external_device_id','geotab-device-001','external_event_id','geotab:bulk-event-0001',
        'signal_kind','position','observed_at','2026-09-08T08:02:01Z','latitude',6.5244,'longitude',3.3792,
        'speed_kph',0,'ignition_on',false,'integrity_score',80,
        'payload_sha256_hex',encode(public.digest('bulk-payload-altered','sha256'),'hex'),
        'normalized_payload',jsonb_build_object('provider','geotab','id','bulk-event-0001','altered',true)
      )),clock_timestamp()
    );
    RAISE EXCEPTION 'altered tracker signal replay unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE '23505' THEN
    RAISE NOTICE 'expected altered tracker signal rejection: SQLSTATE %', SQLSTATE;
  END;
  BEGIN
    PERFORM vehicle_access.complete_tracker_provider_ingest_batch(
      current_setting('app.tracker_provider_id')::uuid,current_setting('app.claim_token')::uuid,'geotab_getfeed'::vehicle_access.tracker_ingest_source,
      'geotab-batch-0003','wrong-cursor','0000000000000003',encode(public.digest('stale','sha256'),'hex'),1,false,clock_timestamp()
    );
    RAISE EXCEPTION 'stale provider cursor unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    RAISE NOTICE 'expected stale provider cursor denial: SQLSTATE %', SQLSTATE;
  END;
END;
$$;
RESET ROLE;
SQL
)"
printf '%s\n' "$recovery_log"
printf '%s\n' "$assertion_log"
full_assertion_log="$recovery_log"$'\n'"$assertion_log"
for expected in \
  'tracker_observability_rows=PASS' \
  'tracker_lock_metrics_row=PASS' \
  'expected crashed worker renewal fence: SQLSTATE 55000' \
  'expected altered provider batch rejection: SQLSTATE 23505' \
  'expected direct provider cursor denial: SQLSTATE 42501' \
  'expected direct tracker idempotency denial: SQLSTATE 42501' \
  'expected append-only provider batch denial: SQLSTATE 55000' \
  'expected append-only tracker identity denial: SQLSTATE 55000' \
  'expected oversize tracker signal batch rejection: SQLSTATE 22023' \
  'expected altered tracker signal rejection: SQLSTATE 23505' \
  'expected stale provider cursor denial: SQLSTATE 55000'; do
  grep -Fq "$expected" <<<"$full_assertion_log" || { echo "vehicle_tracker_provider_cursor=FAIL missing_assertion=$expected" >&2; exit 1; }
done

echo "vehicle_tracker_provider_cursor=PASS geotab_replay=PASS bulk_recorded=PASS bulk_duplicate=PASS crash_lease_recovery=PASS observability_rows=PASS lock_metrics=PASS bulk_limit_sqlstate=22023 altered_signal_sqlstate=23505 traccar_websocket_lease=PASS altered_batch_sqlstate=23505 append_only_sqlstate=55000 direct_table_sqlstate=42501 stale_cursor_sqlstate=55000"
