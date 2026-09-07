#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_NAME="driver_offer_economics_e2e_${$}_$(date +%s)"
DB_ROLE="driver_offer_economics_e2e"
DB_PASSWORD="driver-offer-economics-e2e-password"
REDIS_PORT="${ECONOMICS_E2E_REDIS_PORT:-6383}"
HTTP_PORT="${ECONOMICS_E2E_HTTP_PORT:-8123}"
TOKEN="0123456789abcdef0123456789abcdef0123456789abcdef"
WORKER_DIR="$ROOT_DIR/services/go/ride-matching-worker"
WORKER_BINARY="/tmp/driver-offer-economics-matching-worker-${$}"
LOG_FILE="$ROOT_DIR/validation/driver_offer_economics_matching_worker_e2e_20260907.txt"

cleanup() {
  set +e
  if [[ -n "${WORKER_PID:-}" ]]; then
    kill "$WORKER_PID" >/dev/null 2>&1 || true
    wait "$WORKER_PID" >/dev/null 2>&1 || true
  fi
  rm -f "$WORKER_BINARY"
  redis-cli -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
  sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
  sudo -u postgres dropdb --if-exists "$DB_NAME" >/dev/null 2>&1 || true
  sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${DB_ROLE}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1; then
  echo "driver_offer_economics_e2e_result=FAIL reason=redis_port_in_use port=${REDIS_PORT}" >&2
  exit 1
fi

sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${DB_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${DB_PASSWORD}'" >/dev/null
sudo -u postgres createdb "$DB_NAME"

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION postgis;
CREATE EXTENSION pgcrypto;
CREATE TYPE public.user_role AS ENUM ('user','admin');
CREATE TABLE public.users (
  id serial PRIMARY KEY,
  open_id varchar(64) NOT NULL UNIQUE,
  role public.user_role NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.users(id,open_id,role) VALUES
  (1,'economics-e2e-admin','admin'),
  (98001,'economics-e2e-driver','user'),
  (98002,'economics-e2e-rider-one','user'),
  (98003,'economics-e2e-rider-two','user');
SQL

for migration in \
  drizzle/0026_ride_hailing_dispatch.sql \
  drizzle/0027_h3_dispatch_spatial_index.sql \
  drizzle/0051_driver_dispatch_fairness.sql \
  drizzle/0052_driver_offer_economics.sql; do
  sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$ROOT_DIR/$migration" >/dev/null
done

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<SQL
GRANT USAGE ON SCHEMA mobility TO ${DB_ROLE};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mobility TO ${DB_ROLE};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mobility TO ${DB_ROLE};
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.users TO ${DB_ROLE};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${DB_ROLE};
GRANT EXECUTE ON FUNCTION mobility.create_transparent_driver_offer(uuid, uuid, uuid, integer, smallint, numeric, jsonb, timestamptz, integer, integer, integer, timestamptz) TO ${DB_ROLE};
GRANT EXECUTE ON FUNCTION mobility.decline_driver_offer_fairly(uuid, integer, mobility.driver_offer_decline_reason, text, timestamptz) TO ${DB_ROLE};
GRANT EXECUTE ON FUNCTION mobility.list_driver_offer_disclosures(integer, timestamptz) TO ${DB_ROLE};
SQL

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO mobility.service_zone(id,city_code,zone_code,version,display_name,boundary,active,dispatch_enabled,policy_version,effective_from)
VALUES ('20000000-0000-4000-8000-000000000001','LAG','ECO-E2E',1,'Economics E2E Zone',ST_Multi(ST_GeomFromText('POLYGON((3.30 6.45,3.50 6.45,3.50 6.60,3.30 6.60,3.30 6.45))',4326)),true,true,'e2e-v1',clock_timestamp());
INSERT INTO mobility.driver_profile(user_id,legal_name,display_name,account_state,safety_state,payout_state)
VALUES (98001,'E2E Driver','E2E Driver','active','clear','verified');
INSERT INTO mobility.vehicle(id,driver_user_id,registration_number,make,model,manufacture_year,colour,passenger_capacity,vehicle_class,active)
VALUES ('20000000-0000-4000-8000-000000000011',98001,'ECO-E2E-001','Test','Car',2024,'Blue',4,'beta_standard',true);
INSERT INTO mobility.driver_eligibility(driver_user_id,active_vehicle_id,eligible,eligible_until,policy_version)
VALUES (98001,'20000000-0000-4000-8000-000000000011',true,clock_timestamp()+INTERVAL '1 day','e2e-v1');
INSERT INTO mobility.driver_presence(driver_user_id,state,zone_id,last_point,last_location_at,location_valid_until,accuracy_m,integrity_score)
VALUES (98001,'available','20000000-0000-4000-8000-000000000001',ST_SetSRID(ST_MakePoint(3.3792,6.5244),4326)::geography,clock_timestamp(),clock_timestamp()+INTERVAL '10 minutes',5,95);
INSERT INTO mobility.fare_rule_version(id,zone_id,version,currency,base_kobo,per_km_kobo,per_minute_kobo,minimum_kobo,cancellation_kobo,demand_cap_basis_points,effective_from)
VALUES ('20000000-0000-4000-8000-000000000021','20000000-0000-4000-8000-000000000001','e2e-v1','NGN',1000,200,50,1000,500,15000,clock_timestamp());
SELECT mobility.set_driver_dispatch_fairness_policy(1,'20000000-0000-4000-8000-000000000001','fairness-e2e-v1',1200,3000,600,transaction_timestamp(),transaction_timestamp());
SELECT mobility.set_driver_offer_economics_policy(1,'20000000-0000-4000-8000-000000000001','economics-e2e-v1',10,100,10000,10000,50,500,50,50,transaction_timestamp(),transaction_timestamp());
INSERT INTO mobility.fare_quote(id,rider_user_id,zone_id,fare_rule_id,route_provider,route_provider_version,quoted_distance_m,quoted_duration_s,base_kobo,distance_kobo,time_kobo,demand_kobo,taxes_and_fees_kobo,total_kobo,disclosure_version,calculation,expires_at)
VALUES ('20000000-0000-4000-8000-000000000031',98002,'20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000021','simulation','destination-v1',1000,300,1000,200,50,0,0,1250,'e2e-v1','{"simulated_destination":true}'::jsonb,clock_timestamp()+INTERVAL '5 minutes');
INSERT INTO mobility.ride_trip(id,rider_user_id,state,zone_id,fare_quote_id,pickup,destination,pickup_address,destination_address,requested_at)
VALUES ('20000000-0000-4000-8000-000000000041',98002,'requested','20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000031',ST_SetSRID(ST_MakePoint(3.3800,6.5250),4326)::geography,ST_SetSRID(ST_MakePoint(3.4000,6.5400),4326)::geography,'Simulated pickup, Lagos','Simulated destination, Lagos',clock_timestamp());
SQL

(cd "$WORKER_DIR" && go build -o "$WORKER_BINARY" .)
redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --save '' --appendonly no --daemonize yes
DATABASE_URL="postgresql://${DB_ROLE}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}?sslmode=disable" \
REDIS_URL="redis://127.0.0.1:${REDIS_PORT}/0" \
INTERNAL_SERVICE_TOKEN="$TOKEN" \
BIND_HOST=127.0.0.1 PORT="$HTTP_PORT" MATCH_OFFER_TTL_SECONDS=30 MATCH_REAPER_INTERVAL_SECONDS=60 \
"$WORKER_BINARY" >"$LOG_FILE" 2>&1 &
WORKER_PID=$!

for _ in $(seq 1 30); do
  if curl --silent --fail "http://127.0.0.1:${HTTP_PORT}/health" >/dev/null; then break; fi
  sleep 1
done
curl --silent --fail "http://127.0.0.1:${HTTP_PORT}/health" >/dev/null

success_match_response="$(curl --silent --show-error --fail -X POST "http://127.0.0.1:${HTTP_PORT}/matches/attempts" \
  -H 'Content-Type: application/json' -H "X-Internal-Service-Token: ${TOKEN}" \
  --data '{"trip_id":"20000000-0000-4000-8000-000000000041","idempotency_key":"economics-e2e-success-0001"}')"

success_state="$(sudo -u postgres psql -X -At -d "$DB_NAME" -c "SELECT state::text FROM mobility.ride_trip WHERE id='20000000-0000-4000-8000-000000000041'::uuid")"
success_offer="$(sudo -u postgres psql -X -At -d "$DB_NAME" -c "SELECT id::text FROM mobility.driver_offer WHERE trip_id='20000000-0000-4000-8000-000000000041'::uuid AND state='pending'")"
success_economics="$(sudo -u postgres psql -X -At -d "$DB_NAME" -c "SELECT base_driver_net_kobo || ':' || driver_earnings_floor_kobo || ':' || pickup_subsidy_kobo || ':' || projected_platform_contribution_kobo FROM mobility.driver_offer_economics WHERE offer_id='${success_offer}'::uuid")"
if [[ "$success_state" != 'driver_offered' || -z "$success_offer" || "$success_economics" != '1100:260:0:100' ]]; then
  echo "driver_offer_economics_e2e_result=FAIL reason=transparent_offer_not_issued state=${success_state} offer=${success_offer} economics=${success_economics}" >&2
  exit 1
fi

decline_response="$(curl --silent --show-error --fail -X POST "http://127.0.0.1:${HTTP_PORT}/offers/decline" \
  -H 'Content-Type: application/json' -H "X-Internal-Service-Token: ${TOKEN}" \
  --data "{\"offer_id\":\"${success_offer}\",\"driver_user_id\":98001,\"reason\":\"pickup_distance_unprofitable\",\"idempotency_key\":\"economics-e2e-decline-0001\"}")"

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
SELECT mobility.set_driver_offer_economics_policy(1,'20000000-0000-4000-8000-000000000001','economics-e2e-v2',500,2000,15000,12000,2500,500,50,50,transaction_timestamp(),transaction_timestamp());
INSERT INTO mobility.fare_quote(id,rider_user_id,zone_id,fare_rule_id,route_provider,route_provider_version,quoted_distance_m,quoted_duration_s,base_kobo,distance_kobo,time_kobo,demand_kobo,taxes_and_fees_kobo,total_kobo,disclosure_version,calculation,expires_at)
VALUES ('20000000-0000-4000-8000-000000000032',98003,'20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000021','simulation','destination-v1',1000,300,1000,200,50,0,0,1250,'e2e-v1','{"simulated_destination":true,"scenario":"fuel-index-floor-failure"}'::jsonb,clock_timestamp()+INTERVAL '5 minutes');
INSERT INTO mobility.ride_trip(id,rider_user_id,state,zone_id,fare_quote_id,pickup,destination,pickup_address,destination_address,requested_at)
VALUES ('20000000-0000-4000-8000-000000000042',98003,'requested','20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000032',ST_SetSRID(ST_MakePoint(3.3800,6.5250),4326)::geography,ST_SetSRID(ST_MakePoint(3.4000,6.5400),4326)::geography,'Simulated pickup two, Lagos','Simulated destination two, Lagos',clock_timestamp());
SQL

failure_match_response="$(curl --silent --show-error --fail -X POST "http://127.0.0.1:${HTTP_PORT}/matches/attempts" \
  -H 'Content-Type: application/json' -H "X-Internal-Service-Token: ${TOKEN}" \
  --data '{"trip_id":"20000000-0000-4000-8000-000000000042","idempotency_key":"economics-e2e-floor-fail-0001"}')"

failure_state="$(sudo -u postgres psql -X -At -d "$DB_NAME" -c "SELECT state::text FROM mobility.ride_trip WHERE id='20000000-0000-4000-8000-000000000042'::uuid")"
failure_offers="$(sudo -u postgres psql -X -At -d "$DB_NAME" -c "SELECT count(*) FROM mobility.driver_offer WHERE trip_id='20000000-0000-4000-8000-000000000042'::uuid")"
if [[ "$failure_state" != 'unfulfilled' || "$failure_offers" != '0' ]]; then
  echo "driver_offer_economics_e2e_result=FAIL reason=fail_closed_not_enforced state=${failure_state} offers=${failure_offers}" >&2
  exit 1
fi

{
  echo "health=ok"
  echo "success_match_response=${success_match_response}"
  echo "success_trip_state=${success_state}"
  echo "success_offer_id=${success_offer}"
  echo "success_economics=base_net:driver_floor:pickup_subsidy:platform_contribution=${success_economics}"
  echo "decline_response=${decline_response}"
  echo "floor_failure_match_response=${failure_match_response}"
  echo "floor_failure_trip_state=${failure_state}"
  echo "floor_failure_offer_count=${failure_offers}"
  echo "driver_offer_economics_e2e_result=PASS scenario=real_go_matching_worker_with_simulated_destination_data"
} | tee "$LOG_FILE"
