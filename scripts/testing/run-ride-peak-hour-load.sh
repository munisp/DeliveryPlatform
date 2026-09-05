#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATABASE="ride_peak_hour_load"
ROLE="ride_peak_hour_load"
PASSWORD="ride-peak-hour-load-password"
REDIS_PORT=6382
MATCH_PORT=8121
PAYMENT_PORT=8122
PROVIDER_PORT=8123
ACTIVE_TRIPS="${ACTIVE_TRIPS:-5000}"
PAYMENT_EVENTS="${PAYMENT_EVENTS:-500}"
MATCH_CONCURRENCY="${MATCH_CONCURRENCY:-128}"
PAYMENT_CONCURRENCY="${PAYMENT_CONCURRENCY:-64}"
MATCH_DB_MAX_OPEN_CONNS="${MATCH_DB_MAX_OPEN_CONNS:-32}"
MATCH_DB_MAX_IDLE_CONNS="${MATCH_DB_MAX_IDLE_CONNS:-8}"
MATCH_REDIS_POOL_SIZE="${MATCH_REDIS_POOL_SIZE:-128}"
MATCH_CANDIDATE_LIMIT="${MATCH_CANDIDATE_LIMIT:-25}"
TOKEN="0123456789abcdef0123456789abcdef0123456789abcdef"
WEBHOOK_SECRET="abcdef0123456789abcdef0123456789abcdef0123456789"
PROVIDER_KEY="provider-api-key-0123456789abcdef0123456789"
MIGRATION="$ROOT/drizzle/0026_ride_hailing_dispatch.sql"
H3_MIGRATION="$ROOT/drizzle/0027_h3_dispatch_spatial_index.sql"
WEBHOOK_QUEUE_MIGRATION="$ROOT/drizzle/0038_payment_webhook_verification_queue.sql"
WEBHOOK_CORRELATION_MIGRATION="$ROOT/drizzle/0039_payment_webhook_correlation.sql"
MATCH_DIR="$ROOT/services/go/ride-matching-worker"
PAYMENT_DIR="$ROOT/services/python/payment-webhook"
MATCH_BINARY="/tmp/ride-matching-worker-peak-hour"
OUT_DIR="$ROOT/validation/ride_peak_hour_load_20260903"

cleanup() {
  for pid in "${LOAD_PID:-}" "${MATCH_PID:-}" "${PAYMENT_PID:-}" "${PROVIDER_PID:-}"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  done
  rm -f "$MATCH_BINARY"
  redis-cli -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
}
trap cleanup EXIT

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE}' AND pid <> pg_backend_pid();"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${DATABASE};"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${ROLE};"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}';"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DATABASE} OWNER ${ROLE};"
cp "$MIGRATION" /tmp/ride_peak_hour_migration.sql
cp "$H3_MIGRATION" /tmp/ride_peak_hour_h3_migration.sql
cp "$WEBHOOK_QUEUE_MIGRATION" /tmp/ride_peak_hour_webhook_queue_migration.sql
cp "$WEBHOOK_CORRELATION_MIGRATION" /tmp/ride_peak_hour_webhook_correlation_migration.sql
chmod 0644 /tmp/ride_peak_hour_migration.sql /tmp/ride_peak_hour_h3_migration.sql /tmp/ride_peak_hour_webhook_queue_migration.sql /tmp/ride_peak_hour_webhook_correlation_migration.sql
sudo -u postgres psql -d "$DATABASE" -v ON_ERROR_STOP=1 <<SQL
CREATE TABLE public.users (id serial PRIMARY KEY, open_id varchar(64) NOT NULL UNIQUE);
\\i /tmp/ride_peak_hour_migration.sql
\\i /tmp/ride_peak_hour_h3_migration.sql
\\i /tmp/ride_peak_hour_webhook_queue_migration.sql
\\i /tmp/ride_peak_hour_webhook_correlation_migration.sql
GRANT USAGE ON SCHEMA mobility TO ${ROLE};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mobility TO ${ROLE};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mobility TO ${ROLE};
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA mobility TO ${ROLE};
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO ${ROLE};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE};

INSERT INTO public.users (id, open_id)
SELECT 100000 + g, 'peak-driver-' || g FROM generate_series(1, ${ACTIVE_TRIPS}) AS g
UNION ALL
SELECT 200000 + g, 'peak-rider-' || g FROM generate_series(1, ${ACTIVE_TRIPS}) AS g
UNION ALL
SELECT 300000 + g, 'peak-payment-rider-' || g FROM generate_series(1, ${PAYMENT_EVENTS}) AS g;

INSERT INTO mobility.service_zone (id, city_code, zone_code, version, display_name, boundary, active, dispatch_enabled, policy_version, effective_from)
VALUES ('30000000-0000-0000-0000-000000000001','LAG','peak-hour-zone',1,'Peak Hour Zone',ST_Multi(ST_GeomFromText('POLYGON((3.30 6.45,3.50 6.45,3.50 6.60,3.30 6.60,3.30 6.45))',4326)),true,true,'beta-v1',NOW());
INSERT INTO mobility.driver_profile (user_id, legal_name, display_name, account_state, safety_state, payout_state)
SELECT 100000 + g, 'Peak Driver ' || g, 'Peak Driver ' || g, 'active', 'clear', 'verified' FROM generate_series(1, ${ACTIVE_TRIPS}) AS g;
INSERT INTO mobility.vehicle (id, driver_user_id, registration_number, make, model, manufacture_year, colour, passenger_capacity, vehicle_class, active)
SELECT ('31000000-0000-0000-0000-' || lpad(g::text,12,'0'))::uuid, 100000 + g, 'PEAK-' || g, 'Test', 'Car', 2024, 'Blue', 4, 'beta_standard', true FROM generate_series(1, ${ACTIVE_TRIPS}) AS g;
INSERT INTO mobility.driver_eligibility (driver_user_id, active_vehicle_id, eligible, eligible_until, policy_version)
SELECT 100000 + g, ('31000000-0000-0000-0000-' || lpad(g::text,12,'0'))::uuid, true, NOW() + INTERVAL '1 day', 'beta-v1' FROM generate_series(1, ${ACTIVE_TRIPS}) AS g;
INSERT INTO mobility.driver_payout_recipient (driver_user_id, provider, provider_recipient_reference, state, verified_at)
SELECT 100000 + g, 'fixturepay', 'fixture-recipient-' || g, 'verified', NOW() FROM generate_series(1, ${ACTIVE_TRIPS}) AS g;
INSERT INTO mobility.driver_presence (driver_user_id, state, zone_id, last_point, last_location_at, location_valid_until, accuracy_m, integrity_score)
SELECT 100000 + g, 'available', '30000000-0000-0000-0000-000000000001'::uuid,
       ST_SetSRID(ST_MakePoint(3.3700 + ((g - 1) % 100) * 0.0002, 6.5000 + (((g - 1) / 100)::int) * 0.0002),4326)::geography,
       NOW(), NOW() + INTERVAL '10 minutes', 5, 95 FROM generate_series(1, ${ACTIVE_TRIPS}) AS g;
INSERT INTO mobility.fare_rule_version (id, zone_id, version, base_kobo, per_km_kobo, per_minute_kobo, minimum_kobo, cancellation_kobo, demand_cap_basis_points, effective_from)
VALUES ('30000000-0000-0000-0000-000000000021','30000000-0000-0000-0000-000000000001','beta-v1',1000,200,50,1000,500,15000,NOW());
INSERT INTO mobility.fare_quote (id, rider_user_id, zone_id, fare_rule_id, route_provider, route_provider_version, quoted_distance_m, quoted_duration_s, base_kobo, distance_kobo, time_kobo, demand_kobo, taxes_and_fees_kobo, total_kobo, disclosure_version, calculation, expires_at)
SELECT ('32000000-0000-0000-0000-' || lpad(g::text,12,'0'))::uuid, 200000 + g, '30000000-0000-0000-0000-000000000001'::uuid, '30000000-0000-0000-0000-000000000021'::uuid, 'fixture', 'v1', 1000, 300, 1000, 200, 50, 0, 0, 1250, 'beta-v1', '{}', NOW() + INTERVAL '30 minutes' FROM generate_series(1, ${ACTIVE_TRIPS}) AS g;
INSERT INTO mobility.ride_trip (id, rider_user_id, state, zone_id, fare_quote_id, pickup, destination, pickup_address, destination_address, requested_at)
SELECT ('30000000-0000-0000-0000-' || lpad(g::text,12,'0'))::uuid, 200000 + g, 'requested', '30000000-0000-0000-0000-000000000001'::uuid, ('32000000-0000-0000-0000-' || lpad(g::text,12,'0'))::uuid,
       ST_SetSRID(ST_MakePoint(3.37001 + ((g - 1) % 100) * 0.0002, 6.50001 + (((g - 1) / 100)::int) * 0.0002),4326)::geography,
       ST_SetSRID(ST_MakePoint(3.4000,6.5400),4326)::geography, 'Peak pickup', 'Peak destination', NOW() FROM generate_series(1, ${ACTIVE_TRIPS}) AS g;

INSERT INTO mobility.fare_quote (id, rider_user_id, zone_id, fare_rule_id, route_provider, route_provider_version, quoted_distance_m, quoted_duration_s, base_kobo, distance_kobo, time_kobo, demand_kobo, taxes_and_fees_kobo, total_kobo, disclosure_version, calculation, expires_at)
SELECT ('33000000-0000-0000-0000-' || lpad(g::text,12,'0'))::uuid, 300000 + g, '30000000-0000-0000-0000-000000000001'::uuid, '30000000-0000-0000-0000-000000000021'::uuid, 'fixture', 'v1', 1000, 300, 1000, 200, 50, 0, 118750, 120000, 'beta-v1', '{}', NOW() + INTERVAL '30 minutes' FROM generate_series(1, ${PAYMENT_EVENTS}) AS g;
INSERT INTO mobility.ride_trip (id, rider_user_id, state, zone_id, fare_quote_id, pickup, destination, pickup_address, destination_address, assigned_driver_user_id, assigned_vehicle_id, requested_at, completed_at)
SELECT ('40000000-0000-0000-0000-' || lpad(g::text,12,'0'))::uuid, 300000 + g, 'completed_pending_payment', '30000000-0000-0000-0000-000000000001'::uuid, ('33000000-0000-0000-0000-' || lpad(g::text,12,'0'))::uuid,
       ST_SetSRID(ST_MakePoint(3.3700,6.5000),4326)::geography, ST_SetSRID(ST_MakePoint(3.4000,6.5400),4326)::geography, 'Completed pickup', 'Completed destination', 100000 + g, ('31000000-0000-0000-0000-' || lpad(g::text,12,'0'))::uuid, NOW() - INTERVAL '10 minutes', NOW() FROM generate_series(1, ${PAYMENT_EVENTS}) AS g;
INSERT INTO mobility.provider_payment (trip_id, provider, provider_reference, amount_kobo, currency, state)
SELECT ('40000000-0000-0000-0000-' || lpad(g::text,12,'0'))::uuid, 'fixturepay', 'peak-payment-' || g, 120000, 'NGN', 'capture_pending' FROM generate_series(1, ${PAYMENT_EVENTS}) AS g;
INSERT INTO mobility.trip_settlement (trip_id, allocation_policy_version, gross_fare_kobo, driver_earnings_kobo, platform_commission_kobo, tax_and_statutory_kobo, provider_fee_kobo, payout_hold_until)
SELECT ('40000000-0000-0000-0000-' || lpad(g::text,12,'0'))::uuid, 'beta-v1', 120000, 80000, 23000, 17000, 0, NOW() + INTERVAL '60 minutes' FROM generate_series(1, ${PAYMENT_EVENTS}) AS g;
ANALYZE;
SQL

redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --save '' --appendonly no --daemonize yes
awk -v count="$ACTIVE_TRIPS" 'BEGIN {
  for (g = 1; g <= count; g++) {
    lon = 3.3700 + ((g - 1) % 100) * 0.0002
    lat = 6.5000 + int((g - 1) / 100) * 0.0002
    printf "GEOADD rh:zone:{30000000-0000-0000-0000-000000000001}:available %.6f %.6f %d\n", lon, lat, 100000 + g
  }
}' | redis-cli -p "$REDIS_PORT" --pipe >/dev/null

(cd "$MATCH_DIR" && go build -o "$MATCH_BINARY" .)
PAYMENT_PROVIDER_API_KEY="$PROVIDER_KEY" PROVIDER_FIXTURE_PORT="$PROVIDER_PORT" node "$ROOT/scripts/testing/run-ride-payment-provider-fixture.mjs" >"$OUT_DIR/provider.log" 2>&1 &
PROVIDER_PID=$!
DATABASE_URL="postgresql://${ROLE}:${PASSWORD}@127.0.0.1:5432/${DATABASE}?sslmode=disable" REDIS_URL="redis://127.0.0.1:${REDIS_PORT}/0" INTERNAL_SERVICE_TOKEN="$TOKEN" BIND_HOST=127.0.0.1 PORT="$MATCH_PORT" MATCH_CANDIDATE_LIMIT="$MATCH_CANDIDATE_LIMIT" MATCH_OFFER_TTL_SECONDS=90 DB_MAX_OPEN_CONNS="$MATCH_DB_MAX_OPEN_CONNS" DB_MAX_IDLE_CONNS="$MATCH_DB_MAX_IDLE_CONNS" REDIS_POOL_SIZE="$MATCH_REDIS_POOL_SIZE" "$MATCH_BINARY" >"$OUT_DIR/matching-worker.log" 2>&1 &
MATCH_PID=$!
(
  cd "$PAYMENT_DIR"
  DATABASE_URL="postgresql://${ROLE}:${PASSWORD}@127.0.0.1:5432/${DATABASE}?sslmode=disable" INTERNAL_SERVICE_TOKEN="$TOKEN" BIND_HOST=127.0.0.1 PORT="$PAYMENT_PORT" PAYMENT_PROVIDER_NAME=fixturepay PAYMENT_WEBHOOK_SECRET="$WEBHOOK_SECRET" PAYMENT_PROVIDER_API_KEY="$PROVIDER_KEY" PAYMENT_VERIFY_URL_TEMPLATE="http://127.0.0.1:${PROVIDER_PORT}/transaction/verify/{reference}" PAYMENT_TRANSFER_VERIFY_URL_TEMPLATE="http://127.0.0.1:${PROVIDER_PORT}/transfer/verify/{reference}" PAYMENT_TRANSFER_SUBMIT_URL="http://127.0.0.1:${PROVIDER_PORT}/transfer" PAYOUTS_ENABLED=false PAYMENT_DB_POOL_MAX_SIZE=32 PAYMENT_WEBHOOK_VERIFY_INTERVAL_SECONDS=1 PAYMENT_WEBHOOK_VERIFY_BATCH_SIZE=100 uvicorn main:app --host 127.0.0.1 --port "$PAYMENT_PORT"
) >"$OUT_DIR/payment-webhook.log" 2>&1 &
PAYMENT_PID=$!

for _ in $(seq 1 60); do
  if curl --silent --fail "http://127.0.0.1:${MATCH_PORT}/health" >/dev/null && curl --silent --fail "http://127.0.0.1:${PAYMENT_PORT}/health" >/dev/null; then break; fi
  sleep 1
done
curl --silent --fail "http://127.0.0.1:${MATCH_PORT}/health" >/dev/null
curl --silent --fail "http://127.0.0.1:${PAYMENT_PORT}/health" >/dev/null

sudo -u postgres psql -d "$DATABASE" -At -F ',' -c "SELECT xact_commit,xact_rollback,deadlocks,blks_read,blks_hit FROM pg_stat_database WHERE datname='${DATABASE}'" >"$OUT_DIR/pg_stats_before.csv"
LOAD_OUTPUT_DIR="$OUT_DIR" MATCH_URL="http://127.0.0.1:${MATCH_PORT}/matches/attempts" PAYMENT_URL="http://127.0.0.1:${PAYMENT_PORT}/webhooks/payments" INTERNAL_TOKEN="$TOKEN" WEBHOOK_SECRET="$WEBHOOK_SECRET" ACTIVE_TRIPS="$ACTIVE_TRIPS" PAYMENT_EVENTS="$PAYMENT_EVENTS" MATCH_CONCURRENCY="$MATCH_CONCURRENCY" PAYMENT_CONCURRENCY="$PAYMENT_CONCURRENCY" node "$ROOT/scripts/testing/run-ride-peak-load.mjs" >"$OUT_DIR/load_driver_stdout.json" 2>&1 &
LOAD_PID=$!
: >"$OUT_DIR/pg_lock_samples.csv"
while kill -0 "$LOAD_PID" 2>/dev/null; do
  sudo -u postgres psql -d "$DATABASE" -At -F ',' -c "SELECT EXTRACT(EPOCH FROM NOW())::bigint,COUNT(*),COUNT(*) FILTER (WHERE wait_event_type='Lock'),COUNT(*) FILTER (WHERE state='active') FROM pg_stat_activity WHERE datname='${DATABASE}'" >>"$OUT_DIR/pg_lock_samples.csv"
  sleep 0.25
done
wait "$LOAD_PID"
sudo -u postgres psql -d "$DATABASE" -At -F ',' -c "SELECT xact_commit,xact_rollback,deadlocks,blks_read,blks_hit FROM pg_stat_database WHERE datname='${DATABASE}'" >"$OUT_DIR/pg_stats_after.csv"

for _ in $(seq 1 60); do
  processed="$(sudo -u postgres psql -d "$DATABASE" -Atc "SELECT COUNT(*) FROM mobility.provider_webhook_event WHERE processed_at IS NOT NULL AND processing_error IS NULL")"
  [[ "$processed" == "$PAYMENT_EVENTS" ]] && break
  sleep 1
done
[[ "${processed:-0}" == "$PAYMENT_EVENTS" ]]

sudo -u postgres psql -d "$DATABASE" -At -F ',' -c "SELECT state::text,COUNT(*) FROM mobility.ride_trip WHERE id::text LIKE '30000000-%' GROUP BY state ORDER BY state" >"$OUT_DIR/dispatch_trip_states.csv"
sudo -u postgres psql -d "$DATABASE" -At -F ',' -c "SELECT state::text,COUNT(*) FROM mobility.provider_payment GROUP BY state ORDER BY state" >"$OUT_DIR/payment_states.csv"
sudo -u postgres psql -d "$DATABASE" -At -F ',' -c "SELECT COUNT(*) FROM mobility.driver_offer WHERE state='pending'" >"$OUT_DIR/pending_offer_count.txt"
sudo -u postgres psql -d "$DATABASE" -At -F ',' -c "SELECT COUNT(*) FROM mobility.provider_webhook_event WHERE processed_at IS NOT NULL AND processing_error IS NULL" >"$OUT_DIR/processed_webhook_count.txt"
redis-cli --raw -p "$REDIS_PORT" ZCARD 'rh:zone:{30000000-0000-0000-0000-000000000001}:available' >"$OUT_DIR/redis_available_driver_count.txt"

python3 "$ROOT/scripts/testing/analyze-ride-peak-load.py" "$OUT_DIR"
