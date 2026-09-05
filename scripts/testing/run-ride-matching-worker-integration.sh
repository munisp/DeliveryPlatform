#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATABASE="ride_matching_worker_test"
ROLE="ride_matching_worker_test"
PASSWORD="ride-matching-worker-test-password"
REDIS_PORT=6381
HTTP_PORT=8121
TOKEN="0123456789abcdef0123456789abcdef0123456789abcdef"
MIGRATION="$ROOT/drizzle/0026_ride_hailing_dispatch.sql"
H3_MIGRATION="$ROOT/drizzle/0027_h3_dispatch_spatial_index.sql"
WORKER_DIR="$ROOT/services/go/ride-matching-worker"
WORKER_BINARY="/tmp/ride-matching-worker-integration"
LOG="$ROOT/validation/ride_matching_worker_integration.log"
SUMMARY="$ROOT/validation/ride_matching_worker_integration_summary.txt"

cleanup() {
  if [[ -n "${WORKER_PID:-}" ]]; then
    kill "$WORKER_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi
  rm -f "$WORKER_BINARY"
  redis-cli -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
}
trap cleanup EXIT

sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE}' AND pid <> pg_backend_pid();"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${DATABASE};"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${ROLE};"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}';"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DATABASE} OWNER ${ROLE};"
cp "$MIGRATION" /tmp/ride_hailing_dispatch_matching_test.sql
cp "$H3_MIGRATION" /tmp/h3_dispatch_spatial_matching_test.sql
chmod 0644 /tmp/ride_hailing_dispatch_matching_test.sql /tmp/h3_dispatch_spatial_matching_test.sql
sudo -u postgres psql -d "$DATABASE" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE public.users (id serial PRIMARY KEY, open_id varchar(64) NOT NULL UNIQUE);
\i /tmp/ride_hailing_dispatch_matching_test.sql
\i /tmp/h3_dispatch_spatial_matching_test.sql
GRANT USAGE ON SCHEMA mobility TO ride_matching_worker_test;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mobility TO ride_matching_worker_test;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mobility TO ride_matching_worker_test;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA mobility TO ride_matching_worker_test;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO ride_matching_worker_test;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ride_matching_worker_test;

INSERT INTO public.users (id, open_id) VALUES (98001, 'matching-driver'), (98002, 'matching-rider');
INSERT INTO mobility.service_zone (id, city_code, zone_code, version, display_name, boundary, active, dispatch_enabled, policy_version, effective_from)
VALUES ('20000000-0000-0000-0000-000000000001','LAG','matching-zone',1,'Matching Zone',ST_Multi(ST_GeomFromText('POLYGON((3.30 6.45,3.50 6.45,3.50 6.60,3.30 6.60,3.30 6.45))',4326)),true,true,'beta-v1',NOW());
INSERT INTO mobility.driver_profile (user_id, legal_name, display_name, account_state, safety_state, payout_state)
VALUES (98001,'Driver','Driver','active','clear','verified');
INSERT INTO mobility.vehicle (id, driver_user_id, registration_number, make, model, manufacture_year, colour, passenger_capacity, vehicle_class, active)
VALUES ('20000000-0000-0000-0000-000000000011',98001,'MATCH-98001','Test','Car',2024,'Blue',4,'beta_standard',true);
INSERT INTO mobility.driver_eligibility (driver_user_id, active_vehicle_id, eligible, eligible_until, policy_version)
VALUES (98001,'20000000-0000-0000-0000-000000000011',true,NOW()+INTERVAL '1 day','beta-v1');
INSERT INTO mobility.driver_presence (driver_user_id, state, zone_id, last_point, last_location_at, location_valid_until, accuracy_m, integrity_score)
VALUES (98001,'available','20000000-0000-0000-0000-000000000001',ST_SetSRID(ST_MakePoint(3.3792,6.5244),4326)::geography,NOW(),NOW()+INTERVAL '90 seconds',5,95);
INSERT INTO mobility.fare_rule_version (id, zone_id, version, base_kobo, per_km_kobo, per_minute_kobo, minimum_kobo, cancellation_kobo, demand_cap_basis_points, effective_from)
VALUES ('20000000-0000-0000-0000-000000000021','20000000-0000-0000-0000-000000000001','beta-v1',1000,200,50,1000,500,15000,NOW());
INSERT INTO mobility.fare_quote (id, rider_user_id, zone_id, fare_rule_id, route_provider, route_provider_version, quoted_distance_m, quoted_duration_s, base_kobo, distance_kobo, time_kobo, demand_kobo, taxes_and_fees_kobo, total_kobo, disclosure_version, calculation, expires_at)
VALUES ('20000000-0000-0000-0000-000000000031',98002,'20000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000021','test','v1',1000,300,1000,200,50,0,0,1250,'beta-v1','{}',NOW()+INTERVAL '5 minutes');
INSERT INTO mobility.ride_trip (id, rider_user_id, state, zone_id, fare_quote_id, pickup, destination, pickup_address, destination_address, requested_at)
VALUES ('20000000-0000-0000-0000-000000000041',98002,'requested','20000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000031',ST_SetSRID(ST_MakePoint(3.3800,6.5250),4326)::geography,ST_SetSRID(ST_MakePoint(3.4000,6.5400),4326)::geography,'Pickup','Destination',NOW());
SQL

(cd "$WORKER_DIR" && go build -o "$WORKER_BINARY" .)
redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --save '' --appendonly no --daemonize yes
DATABASE_URL="postgresql://${ROLE}:${PASSWORD}@127.0.0.1:5432/${DATABASE}?sslmode=disable" \
REDIS_URL="redis://127.0.0.1:${REDIS_PORT}/0" \
INTERNAL_SERVICE_TOKEN="$TOKEN" \
BIND_HOST=127.0.0.1 PORT="$HTTP_PORT" MATCH_OFFER_TTL_SECONDS=30 \
"$WORKER_BINARY" >"$LOG" 2>&1 &
WORKER_PID=$!

for _ in $(seq 1 30); do
  if curl --silent --fail "http://127.0.0.1:${HTTP_PORT}/health" >/dev/null; then break; fi
  sleep 1
done
curl --silent --fail "http://127.0.0.1:${HTTP_PORT}/health" >/dev/null

presence_response="$(curl --silent --show-error --fail -X POST "http://127.0.0.1:${HTTP_PORT}/events/driver-presence" -H "Content-Type: application/json" -H "X-Internal-Service-Token: ${TOKEN}" --data '{"driver_user_id":98001,"pg_version":1}')"
match_response="$(curl --silent --show-error --fail -X POST "http://127.0.0.1:${HTTP_PORT}/matches/attempts" -H "Content-Type: application/json" -H "X-Internal-Service-Token: ${TOKEN}" --data '{"trip_id":"20000000-0000-0000-0000-000000000041","idempotency_key":"matching-e2e-1"}')"

state="$(sudo -u postgres psql -d "$DATABASE" -Atc "SELECT state::text FROM mobility.ride_trip WHERE id='20000000-0000-0000-0000-000000000041'::uuid")"
offers="$(sudo -u postgres psql -d "$DATABASE" -Atc "SELECT COUNT(*) FROM mobility.driver_offer WHERE trip_id='20000000-0000-0000-0000-000000000041'::uuid AND state='pending'")"
presence_state="$(sudo -u postgres psql -d "$DATABASE" -Atc "SELECT state::text FROM mobility.driver_presence WHERE driver_user_id=98001")"
geo_members="$(redis-cli --raw -p "$REDIS_PORT" ZCARD 'rh:zone:{20000000-0000-0000-0000-000000000001}:available')"
driver_h3="$(sudo -u postgres psql -d "$DATABASE" -Atc "SELECT COALESCE(h3_cell_r9,'') FROM mobility.driver_presence WHERE driver_user_id=98001")"
trip_h3="$(sudo -u postgres psql -d "$DATABASE" -Atc "SELECT COALESCE(pickup_h3_cell_r9,'') FROM mobility.ride_trip WHERE id='20000000-0000-0000-0000-000000000041'::uuid")"
h3_projection="$(sudo -u postgres psql -d "$DATABASE" -Atc "SELECT COUNT(*) FROM mobility.h3_cell_projection WHERE driver_user_id=98001")"

if [[ "$state" != "driver_offered" || "$offers" != "1" || "$presence_state" != "offer_pending" || "$geo_members" != "0" || -z "$driver_h3" || -z "$trip_h3" || "$h3_projection" != "1" ]]; then
  echo "matching integration assertion failed: state=${state} offers=${offers} presence=${presence_state} geo_members=${geo_members} driver_h3=${driver_h3} trip_h3=${trip_h3} h3_projection=${h3_projection}" >&2
  exit 1
fi

{
  echo "presence_response=${presence_response}"
  echo "match_response=${match_response}"
  echo "trip_state=${state}"
  echo "pending_offers=${offers}"
  echo "driver_presence_state=${presence_state}"
  echo "available_geo_members_after_offer=${geo_members}"
  echo "driver_h3_cell=${driver_h3}"
  echo "trip_h3_cell=${trip_h3}"
  echo "h3_projection_records=${h3_projection}"
} | tee "$SUMMARY"
