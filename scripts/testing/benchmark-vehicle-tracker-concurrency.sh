#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_NAME="vehicle_tracker_concurrency_${$}_$(date +%s)"
WORKERS="${TRACKER_BENCH_WORKERS:-16}"
ROWS_PER_WORKER="${TRACKER_BENCH_ROWS_PER_WORKER:-500}"
TMP_DIR="$(mktemp -d)"
chmod 755 "$TMP_DIR"

cleanup() {
  set +e
  sudo -u postgres dropdb --if-exists "$DB_NAME" >/dev/null 2>&1
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

[[ "$WORKERS" =~ ^[1-9][0-9]?$ ]] || { echo "invalid TRACKER_BENCH_WORKERS" >&2; exit 1; }
[[ "$ROWS_PER_WORKER" =~ ^[1-9][0-9]{0,5}$ ]] || { echo "invalid TRACKER_BENCH_ROWS_PER_WORKER" >&2; exit 1; }

sudo -u postgres createdb "$DB_NAME"
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
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
INSERT INTO public.users (id,open_id,name,role) VALUES (1,'tracker-bench-operator','Tracker Bench Operator','admin');
SQL
for migration in \
  "$ROOT_DIR/drizzle/0050_gig_worker_vehicle_access.sql" \
  "$ROOT_DIR/drizzle/0058_gig_vehicle_rental_operations.sql" \
  "$ROOT_DIR/drizzle/0059_vehicle_tracker_geofence_safety_controls.sql" \
  "$ROOT_DIR/drizzle/0060_vehicle_tracker_provider_ingest_cursors.sql"; do
  sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$migration" >/dev/null
done

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
SELECT vehicle_access.create_provider(1,'Concurrent Fleet','Concurrent Fleet Ltd',clock_timestamp()) AS provider_id \gset
SELECT vehicle_access.register_asset(1, :'provider_id'::uuid,'BENCH-VEH-001'::text,repeat('b',64)::text,'Bench'::text,'Vehicle'::text,2024::integer,0::integer,4::smallint,'["delivery"]'::jsonb,clock_timestamp()) AS asset_id \gset
SELECT vehicle_access.create_tracker_provider(1, :'provider_id'::uuid,'geotab_feed','bench_geotab','Bench Geotab','secrets/geotab/bench','bench-geotab-0001',clock_timestamp()) AS tracker_provider_id \gset
SELECT vehicle_access.register_asset_tracker(1, :'asset_id'::uuid, :'tracker_provider_id'::uuid,'bench-device-001',repeat('a',64),false,'bench-tracker-0001',clock_timestamp()) AS tracker_id \gset
SELECT :'tracker_id'::uuid AS tracker_id, :'asset_id'::uuid AS asset_id \gset
SELECT set_config('app.bench_tracker_id', :'tracker_id', false), set_config('app.bench_asset_id', :'asset_id', false);
SQL

claim_sql="$TMP_DIR/claim.sql"
cat > "$claim_sql" <<'SQL'
\set ON_ERROR_STOP on
SELECT count(*) FROM vehicle_access.claim_tracker_provider_ingest(
  'geotab_feed'::vehicle_access.tracker_provider_kind,
  :'worker_id',
  timestamptz '2026-09-08 10:00:00+00'
);
SQL

claim_start_ns="$(date +%s%N)"
pids=()
for worker in $(seq 1 "$WORKERS"); do
  sudo -u postgres psql -X -At -d "$DB_NAME" -v worker_id="bench-worker-${worker}" -f "$claim_sql" > "$TMP_DIR/claim-${worker}.out" 2> "$TMP_DIR/claim-${worker}.err" &
  pids+=("$!")
done
claim_failed=0
for pid in "${pids[@]}"; do
  wait "$pid" || claim_failed=1
done
if [[ "$claim_failed" == "1" ]]; then
  cat "$TMP_DIR"/claim-*.err >&2
  exit 1
fi
claim_end_ns="$(date +%s%N)"
claim_winners="$(cat "$TMP_DIR"/claim-*.out | awk '$1 == 1 { count += 1 } END { print count + 0 }')"
claim_errors="$(cat "$TMP_DIR"/claim-*.err | wc -l | tr -d ' ')"

tracker_id="$(sudo -u postgres psql -X -At -d "$DB_NAME" -c "SELECT id FROM vehicle_access.vehicle_asset_tracker WHERE external_device_id='bench-device-001'")"
asset_id="$(sudo -u postgres psql -X -At -d "$DB_NAME" -c "SELECT id FROM vehicle_access.vehicle_asset WHERE registration_number='BENCH-VEH-001'")"
insert_sql="$TMP_DIR/insert.sql"
cat > "$insert_sql" <<'SQL'
\set ON_ERROR_STOP on
INSERT INTO vehicle_access.vehicle_tracker_signal(
  tracker_id,asset_id,contract_id,signal_kind,external_event_id,observed_at,received_at,point,
  speed_kph,heading_degrees,accuracy_m,odometer_km,ignition_on,integrity_score,payload_digest,normalized_payload
)
SELECT
  :'tracker_id'::uuid, :'asset_id'::uuid, NULL, 'position'::vehicle_access.tracker_signal_kind,
  format('bench-%s-%s', :'worker_id', sequence),
  timestamptz '2026-09-08 10:01:00+00' + make_interval(secs => sequence),
  clock_timestamp(),
  public.ST_SetSRID(public.ST_MakePoint(3.3792 + sequence * 0.000001, 6.5244),4326)::public.geography,
  0, 0, 5, sequence, false, 100,
  public.digest(format('bench-%s-%s', :'worker_id', sequence), 'sha256'),
  '{}'::jsonb
FROM generate_series(1, :'rows_per_worker'::integer) AS sequence;
SQL

insert_start_ns="$(date +%s%N)"
pids=()
for worker in $(seq 1 "$WORKERS"); do
  sudo -u postgres psql -X -q -d "$DB_NAME" -v tracker_id="$tracker_id" -v asset_id="$asset_id" -v worker_id="$worker" -v rows_per_worker="$ROWS_PER_WORKER" -f "$insert_sql" > "$TMP_DIR/insert-${worker}.out" 2> "$TMP_DIR/insert-${worker}.err" &
  pids+=("$!")
done
insert_failed=0
for pid in "${pids[@]}"; do
  wait "$pid" || insert_failed=1
done
if [[ "$insert_failed" == "1" ]]; then
  cat "$TMP_DIR"/insert-*.err >&2
  exit 1
fi
insert_end_ns="$(date +%s%N)"
insert_errors="$(cat "$TMP_DIR"/insert-*.err | wc -l | tr -d ' ')"
inserted_rows="$(sudo -u postgres psql -X -At -d "$DB_NAME" -c "SELECT count(*) FROM vehicle_access.vehicle_tracker_signal")"

mutation_sql="$TMP_DIR/mutate.sql"
cat > "$mutation_sql" <<'SQL'
\set ON_ERROR_STOP off
\set VERBOSITY verbose
UPDATE vehicle_access.vehicle_tracker_signal
SET integrity_score = 99
WHERE external_event_id = :'event_id';
SQL
pids=()
for worker in $(seq 1 "$WORKERS"); do
  sudo -u postgres psql -X -d "$DB_NAME" -v event_id="bench-${worker}-1" -f "$mutation_sql" > "$TMP_DIR/mutation-${worker}.out" 2> "$TMP_DIR/mutation-${worker}.err" &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid" || true; done
mutation_55000="$(grep -h '55000' "$TMP_DIR"/mutation-*.err | wc -l | tr -d ' ')"
mutated_rows="$(sudo -u postgres psql -X -At -d "$DB_NAME" -c "SELECT count(*) FROM vehicle_access.vehicle_tracker_signal WHERE integrity_score = 99")"

claim_elapsed_ms="$(( (claim_end_ns - claim_start_ns) / 1000000 ))"
insert_elapsed_ms="$(( (insert_end_ns - insert_start_ns) / 1000000 ))"
total_requested="$(( WORKERS * ROWS_PER_WORKER ))"
insert_tps="$(awk -v rows="$inserted_rows" -v ms="$insert_elapsed_ms" 'BEGIN { if (ms == 0) print "inf"; else printf "%.2f", rows * 1000 / ms }')"

[[ "$claim_winners" == "1" ]] || { echo "vehicle_tracker_concurrency=FAIL claim_winners=$claim_winners" >&2; exit 1; }
[[ "$claim_errors" == "0" ]] || { echo "vehicle_tracker_concurrency=FAIL claim_errors=$claim_errors" >&2; exit 1; }
[[ "$insert_errors" == "0" ]] || { echo "vehicle_tracker_concurrency=FAIL insert_errors=$insert_errors" >&2; exit 1; }
[[ "$inserted_rows" == "$total_requested" ]] || { echo "vehicle_tracker_concurrency=FAIL inserted_rows=$inserted_rows expected=$total_requested" >&2; exit 1; }
[[ "$mutation_55000" == "$WORKERS" ]] || { echo "vehicle_tracker_concurrency=FAIL mutation_55000=$mutation_55000 expected=$WORKERS" >&2; exit 1; }
[[ "$mutated_rows" == "0" ]] || { echo "vehicle_tracker_concurrency=FAIL mutated_rows=$mutated_rows" >&2; exit 1; }

echo "vehicle_tracker_concurrency=PASS workers=$WORKERS claim_winners=$claim_winners claim_elapsed_ms=$claim_elapsed_ms inserted_rows=$inserted_rows insert_elapsed_ms=$insert_elapsed_ms insert_rows_per_second=$insert_tps append_only_55000=$mutation_55000 mutated_rows=$mutated_rows"
