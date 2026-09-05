#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATABASE="driver_location_h3_load"
ROLE="driver_location_h3_load"
PASSWORD="driver-location-h3-load-password"
REDIS_PORT="${REDIS_PORT:-6384}"
MATCH_PORT="${MATCH_PORT:-8124}"
DRIVER_COUNT="${DRIVER_COUNT:-10000}"
LOCATION_CONCURRENCY="${LOCATION_CONCURRENCY:-10000}"
QUERY_CONCURRENCY="${QUERY_CONCURRENCY:-10000}"
TOKEN="0123456789abcdef0123456789abcdef0123456789abcdef"
ZONE_ID="30000000-0000-0000-0000-000000000001"
MATCH_DIR="$ROOT/services/go/ride-matching-worker"
MATCH_BINARY="/tmp/ride-matching-worker-location-h3"
OUT_DIR="${OUT_DIR:-$ROOT/validation/driver_location_h3_load_20260903}"

for value in "$DRIVER_COUNT" "$LOCATION_CONCURRENCY" "$QUERY_CONCURRENCY"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || { echo "load counts must be positive integers" >&2; exit 2; }
done
[[ "$DRIVER_COUNT" -le 100000 && "$LOCATION_CONCURRENCY" -le "$DRIVER_COUNT" && "$QUERY_CONCURRENCY" -le "$DRIVER_COUNT" ]] || { echo "invalid load bounds" >&2; exit 2; }

cleanup() {
  if [[ -n "${MATCH_PID:-}" ]]; then kill "$MATCH_PID" 2>/dev/null || true; wait "$MATCH_PID" 2>/dev/null || true; fi
  rm -f "$MATCH_BINARY" /tmp/driver_location_h3_0026.sql /tmp/driver_location_h3_0027.sql /tmp/driver_location_h3_0029.sql
  redis-cli -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
  sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE}' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
  sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${DATABASE};" >/dev/null 2>&1 || true
  sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${ROLE};" >/dev/null 2>&1 || true
}
trap cleanup EXIT

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cleanup
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}';"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DATABASE} OWNER ${ROLE};"
cp "$ROOT/drizzle/0026_ride_hailing_dispatch.sql" /tmp/driver_location_h3_0026.sql
cp "$ROOT/drizzle/0027_h3_dispatch_spatial_index.sql" /tmp/driver_location_h3_0027.sql
cp "$ROOT/drizzle/0029_driver_location_event_stream.sql" /tmp/driver_location_h3_0029.sql
chmod 0644 /tmp/driver_location_h3_00*.sql

sudo -u postgres psql -d "$DATABASE" -v ON_ERROR_STOP=1 <<SQL
CREATE TABLE public.users (id serial PRIMARY KEY, open_id varchar(64) NOT NULL UNIQUE);
\i /tmp/driver_location_h3_0026.sql
\i /tmp/driver_location_h3_0027.sql
\i /tmp/driver_location_h3_0029.sql
GRANT USAGE ON SCHEMA mobility TO ${ROLE};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mobility TO ${ROLE};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mobility TO ${ROLE};
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA mobility TO ${ROLE};
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO ${ROLE};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE};
INSERT INTO public.users (id, open_id) SELECT 500000 + g, 'h3-location-driver-' || g FROM generate_series(1, ${DRIVER_COUNT}) AS g;
INSERT INTO mobility.service_zone (id, city_code, zone_code, version, display_name, boundary, active, dispatch_enabled, policy_version, effective_from)
VALUES ('${ZONE_ID}','LAG','location-h3-load',1,'Lagos Location H3 Load Zone',ST_Multi(ST_GeomFromText('POLYGON((3.30 6.45,3.50 6.45,3.50 6.60,3.30 6.60,3.30 6.45))',4326)),true,true,'load-v1',NOW());
INSERT INTO mobility.driver_profile (user_id, legal_name, display_name, account_state, safety_state, payout_state)
SELECT 500000 + g, 'H3 Driver ' || g, 'H3 Driver ' || g, 'active', 'clear', 'verified' FROM generate_series(1, ${DRIVER_COUNT}) AS g;
INSERT INTO mobility.vehicle (id, driver_user_id, registration_number, make, model, manufacture_year, colour, passenger_capacity, vehicle_class, active)
SELECT ('52000000-0000-0000-0000-' || lpad(g::text,12,'0'))::uuid, 500000 + g, 'H3-' || g, 'Test', 'Car', 2024, 'Blue', 4, 'beta_standard', true FROM generate_series(1, ${DRIVER_COUNT}) AS g;
INSERT INTO mobility.driver_eligibility (driver_user_id, active_vehicle_id, eligible, eligible_until, policy_version)
SELECT 500000 + g, ('52000000-0000-0000-0000-' || lpad(g::text,12,'0'))::uuid, true, NOW() + INTERVAL '1 hour', 'load-v1' FROM generate_series(1, ${DRIVER_COUNT}) AS g;
INSERT INTO mobility.driver_presence (driver_user_id, state, zone_id, last_point, last_location_at, last_location_source_at, location_valid_until, accuracy_m, integrity_score)
SELECT 500000 + g, 'available', '${ZONE_ID}'::uuid,
       ST_SetSRID(ST_MakePoint(3.3300 + ((g - 1) % 125) * 0.0011, 6.4700 + (((g - 1) / 125)::int % 80) * 0.0011),4326)::geography,
       NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '2 minutes', NOW() + INTERVAL '10 minutes', 5, 96 FROM generate_series(1, ${DRIVER_COUNT}) AS g;
ANALYZE;
SQL

redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --save '' --appendonly no --daemonize yes
(cd "$MATCH_DIR" && CGO_ENABLED=1 go build -o "$MATCH_BINARY" .)
DATABASE_URL="postgresql://${ROLE}:${PASSWORD}@127.0.0.1:5432/${DATABASE}?sslmode=disable" REDIS_URL="redis://127.0.0.1:${REDIS_PORT}/0" INTERNAL_SERVICE_TOKEN="$TOKEN" BIND_HOST=127.0.0.1 PORT="$MATCH_PORT" MATCH_CANDIDATE_LIMIT=32 MATCH_H3_RESOLUTION=9 DB_MAX_OPEN_CONNS=64 DB_MAX_IDLE_CONNS=16 REDIS_POOL_SIZE=256 "$MATCH_BINARY" >"$OUT_DIR/matching-worker.log" 2>&1 &
MATCH_PID=$!
for _ in $(seq 1 60); do
  curl --silent --fail "http://127.0.0.1:${MATCH_PORT}/health" >/dev/null && break
  sleep 1
done
curl --silent --fail "http://127.0.0.1:${MATCH_PORT}/health" >/dev/null

sudo -u postgres psql -d "$DATABASE" -At -F ',' -c "SELECT xact_commit,xact_rollback,deadlocks,blks_read,blks_hit FROM pg_stat_database WHERE datname='${DATABASE}'" >"$OUT_DIR/pg_stats_before.csv"
(
  while kill -0 "$MATCH_PID" 2>/dev/null; do
    sudo -u postgres psql -d "$DATABASE" -At -F ',' -c "SELECT EXTRACT(EPOCH FROM NOW())::bigint,COUNT(*),COUNT(*) FILTER (WHERE wait_event_type='Lock'),COUNT(*) FILTER (WHERE state='active') FROM pg_stat_activity WHERE datname='${DATABASE}'" >>"$OUT_DIR/pg_lock_samples.csv"
    sleep 0.25
  done
) &
SAMPLE_PID=$!
LOAD_OUTPUT_DIR="$OUT_DIR" LOCATION_URL="http://127.0.0.1:${MATCH_PORT}/events/driver-location" QUERY_URL="http://127.0.0.1:${MATCH_PORT}/queries/spatial-candidates" INTERNAL_TOKEN="$TOKEN" ZONE_ID="$ZONE_ID" DRIVER_COUNT="$DRIVER_COUNT" LOCATION_CONCURRENCY="$LOCATION_CONCURRENCY" QUERY_CONCURRENCY="$QUERY_CONCURRENCY" LOCATION_SEQUENCE=1 node "$ROOT/scripts/testing/run-driver-location-h3-load.mjs" >"$OUT_DIR/load_driver_stdout.json" 2>&1
kill "$SAMPLE_PID" 2>/dev/null || true
wait "$SAMPLE_PID" 2>/dev/null || true
sudo -u postgres psql -d "$DATABASE" -At -F ',' -c "SELECT xact_commit,xact_rollback,deadlocks,blks_read,blks_hit FROM pg_stat_database WHERE datname='${DATABASE}'" >"$OUT_DIR/pg_stats_after.csv"
sudo -u postgres psql -d "$DATABASE" -At -F ',' -c "SELECT COUNT(*) FILTER (WHERE accepted), COUNT(*) FILTER (WHERE NOT accepted), COUNT(*) FROM mobility.driver_location_event" >"$OUT_DIR/location_event_counts.csv"
sudo -u postgres psql -d "$DATABASE" -At -c "SELECT COUNT(*) FROM mobility.h3_cell_projection" >"$OUT_DIR/h3_projection_count.txt"
redis-cli --raw -p "$REDIS_PORT" ZCARD "rh:zone:{${ZONE_ID}}:available" >"$OUT_DIR/redis_geo_count.txt"
redis-cli --raw -p "$REDIS_PORT" --scan --pattern "rh:zone:{${ZONE_ID}}:h3:*:available" | while read -r key; do redis-cli --raw -p "$REDIS_PORT" SCARD "$key"; done | awk '{sum += $1} END {print sum + 0}' >"$OUT_DIR/redis_h3_member_count.txt"
python3 "$ROOT/scripts/testing/analyze-driver-location-h3-load.py" "$OUT_DIR" "$DRIVER_COUNT"
