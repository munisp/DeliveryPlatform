#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_NAME="driver_fairness_validation_${$}_$(date +%s)"
ROLE_SERVICE="switchos_service"
ROLE_UNTRUSTED="driver_fairness_untrusted"
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
    role_safe "$role" || { echo "driver_fairness_result=FAIL reason=unsafe_existing_role role=$role" >&2; exit 1; }
  else
    sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS" >/dev/null
    CREATED_ROLES+=("$role")
  fi
done

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
  (1,'fairness-admin','admin'),
  (2,'fairness-driver','user'),
  (3,'fairness-rider','user'),
  (4,'fairness-rider-two','user');
SQL
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$ROOT_DIR/drizzle/0026_ride_hailing_dispatch.sql" >/dev/null
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$ROOT_DIR/drizzle/0051_driver_dispatch_fairness.sql" >/dev/null

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO mobility.service_zone(id,city_code,zone_code,version,display_name,boundary,active,dispatch_enabled,policy_version,effective_from)
VALUES ('11111111-1111-4111-8111-111111111111','LAG','LAG-FAIR',1,'Fair Dispatch Zone',ST_GeomFromText('MULTIPOLYGON(((3.30 6.45,3.50 6.45,3.50 6.60,3.30 6.60,3.30 6.45)))',4326),true,true,'zone-v1',timestamptz '2026-09-07 07:00:00+00');
INSERT INTO mobility.driver_profile(user_id,legal_name,display_name,account_state,safety_state,payout_state)
VALUES (2,'Fairness Driver','Fair Driver','active','clear','verified');
INSERT INTO mobility.vehicle(id,driver_user_id,registration_number,make,model,manufacture_year,colour,passenger_capacity,vehicle_class,active)
VALUES ('22222222-2222-4222-8222-222222222222',2,'LAG-FAIR-001','Toyota','Corolla',2018,'Silver',4,'beta_standard',true);
INSERT INTO mobility.driver_eligibility(driver_user_id,active_vehicle_id,eligible,eligible_until,policy_version)
VALUES (2,'22222222-2222-4222-8222-222222222222',true,timestamptz '2026-09-08 12:00:00+00','eligibility-v1');
INSERT INTO mobility.driver_presence(driver_user_id,state,zone_id,last_point,last_location_at,location_valid_until,integrity_score)
VALUES (2,'available','11111111-1111-4111-8111-111111111111',ST_SetSRID(ST_MakePoint(3.390,6.510),4326)::geography,timestamptz '2026-09-07 08:00:00+00',timestamptz '2026-09-07 10:00:00+00',95);
INSERT INTO mobility.fare_rule_version(id,zone_id,version,currency,base_kobo,per_km_kobo,per_minute_kobo,minimum_kobo,cancellation_kobo,demand_cap_basis_points,effective_from)
VALUES ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','fare-v1','NGN',10000,0,0,0,0,10000,timestamptz '2026-09-07 07:00:00+00');
INSERT INTO mobility.fare_quote(id,rider_user_id,zone_id,fare_rule_id,route_provider,route_provider_version,quoted_distance_m,quoted_duration_s,base_kobo,distance_kobo,time_kobo,demand_kobo,taxes_and_fees_kobo,total_kobo,disclosure_version,calculation,expires_at,created_at)
VALUES ('44444444-4444-4444-8444-444444444444',3,'11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','test-route','v1',8500,1500,10000,5000,3000,0,2000,20000,'quote-v1','{}'::jsonb,timestamptz '2026-09-07 09:00:00+00',timestamptz '2026-09-07 08:00:00+00');
INSERT INTO mobility.ride_trip(id,rider_user_id,state,zone_id,fare_quote_id,pickup,destination,pickup_address,destination_address,requested_at)
VALUES ('55555555-5555-4555-8555-555555555555',3,'matching','11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444',ST_SetSRID(ST_MakePoint(3.380,6.500),4326)::geography,ST_SetSRID(ST_MakePoint(3.450,6.550),4326)::geography,'Pickup, Lagos','Destination, Lagos',timestamptz '2026-09-07 08:01:00+00');
INSERT INTO mobility.match_attempt(id,trip_id,wave_no,algorithm_version,candidate_query_snapshot,candidate_count,state)
VALUES ('66666666-6666-4666-8666-666666666666','55555555-5555-4555-8555-555555555555',1,'fairness-v1','{}'::jsonb,1,'offering');
SET ROLE switchos_service;
SELECT mobility.set_driver_dispatch_fairness_policy(1,'11111111-1111-4111-8111-111111111111','fairness-v1',1200,3000,600,timestamptz '2026-09-07 08:00:00+00',timestamptz '2026-09-07 08:00:00+00') AS policy_id \gset
SELECT * FROM mobility.create_transparent_driver_offer('77777777-7777-4777-8777-777777777777','66666666-6666-4666-8666-666666666666','55555555-5555-4555-8555-555555555555',2,1::smallint,0.5::numeric,'{"distance_m":500,"eta_seconds":120}'::jsonb,timestamptz '2026-09-07 08:05:00+00',500,120,70,timestamptz '2026-09-07 08:01:00+00');
SELECT offer_id::text,destination_address,gross_fare_kobo,taxes_and_fees_kobo,platform_commission_bp,platform_commission_kobo,expected_driver_net_kobo FROM mobility.list_driver_offer_disclosures(2,timestamptz '2026-09-07 08:01:01+00');
DO $$
DECLARE v_net bigint; v_commission bigint; v_destination text;
BEGIN
  SELECT expected_driver_net_kobo,platform_commission_kobo,destination_address INTO v_net,v_commission,v_destination FROM mobility.list_driver_offer_disclosures(2,timestamptz '2026-09-07 08:01:01+00') WHERE offer_id='77777777-7777-4777-8777-777777777777';
  IF v_net <> 15840 OR v_commission <> 2160 OR v_destination <> 'Destination, Lagos' THEN RAISE EXCEPTION 'transparent economics calculation mismatch'; END IF;
END;
$$;
SELECT * FROM mobility.decline_driver_offer_fairly('77777777-7777-4777-8777-777777777777',2,'pickup_distance_unprofitable','fair-decline-0001',timestamptz '2026-09-07 08:01:30+00');
SELECT * FROM mobility.decline_driver_offer_fairly('77777777-7777-4777-8777-777777777777',2,'pickup_distance_unprofitable','fair-decline-0001',timestamptz '2026-09-07 08:01:31+00');
RESET ROLE;
SELECT state AS driver_presence_after_decline FROM mobility.driver_presence WHERE driver_user_id=2;
SELECT account_state,safety_state FROM mobility.driver_profile WHERE user_id=2;
SELECT eligible FROM mobility.driver_eligibility WHERE driver_user_id=2;
INSERT INTO mobility.ride_trip(id,rider_user_id,state,zone_id,fare_quote_id,pickup,destination,pickup_address,destination_address,requested_at)
VALUES ('88888888-8888-4888-8888-888888888888',4,'matching','11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444',ST_SetSRID(ST_MakePoint(3.381,6.501),4326)::geography,ST_SetSRID(ST_MakePoint(3.451,6.551),4326)::geography,'Pickup Two, Lagos','Destination Two, Lagos',timestamptz '2026-09-07 08:02:00+00');
INSERT INTO mobility.match_attempt(id,trip_id,wave_no,algorithm_version,candidate_query_snapshot,candidate_count,state)
VALUES ('99999999-9999-4999-8999-999999999999','88888888-8888-4888-8888-888888888888',1,'fairness-v1','{}'::jsonb,1,'offering');
INSERT INTO mobility.driver_offer(id,match_attempt_id,trip_id,driver_user_id,rank,score,score_explanation,offered_at,expires_at)
VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','99999999-9999-4999-8999-999999999999','88888888-8888-4888-8888-888888888888',2,1,0.5,'{}'::jsonb,timestamptz '2026-09-07 08:02:00+00',timestamptz '2026-09-07 08:06:00+00');
DO $$
BEGIN
  BEGIN
    PERFORM mobility.accept_driver_offer('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',2,'opaque-accept-0001',timestamptz '2026-09-07 08:02:01+00');
    RAISE EXCEPTION 'opaque offer acceptance unexpectedly allowed';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
END;
$$;
SET ROLE switchos_service;
SELECT * FROM mobility.create_transparent_driver_offer('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','99999999-9999-4999-8999-999999999999','88888888-8888-4888-8888-888888888888',2,1::smallint,0.5::numeric,'{}'::jsonb,timestamptz '2026-09-07 08:06:00+00',4001,120,70,timestamptz '2026-09-07 08:02:00+00');
RESET ROLE;
SQL

if sudo -u postgres psql -X -At -d "$DB_NAME" -c "SELECT state::text FROM mobility.driver_offer WHERE id='77777777-7777-4777-8777-777777777777'" | grep -qx 'declined'; then :; else echo "driver_fairness_result=FAIL reason=decline_not_persisted" >&2; exit 1; fi
if sudo -u postgres psql -X -At -d "$DB_NAME" -c "SELECT state::text FROM mobility.driver_presence WHERE driver_user_id=2" | grep -qx 'available'; then :; else echo "driver_fairness_result=FAIL reason=driver_not_restored_available" >&2; exit 1; fi
if sudo -u postgres psql -X -At -d "$DB_NAME" -c "SELECT count(*) FROM mobility.driver_offer_decline WHERE offer_id='77777777-7777-4777-8777-777777777777'" | grep -qx '1'; then :; else echo "driver_fairness_result=FAIL reason=decline_not_idempotent" >&2; exit 1; fi
if sudo -u postgres psql -X -At -d "$DB_NAME" -c "SELECT rematch_required FROM mobility.driver_offer_decline WHERE offer_id='77777777-7777-4777-8777-777777777777'" | grep -qx 't'; then :; else echo "driver_fairness_result=FAIL reason=idempotent_rematch_outcome_not_preserved" >&2; exit 1; fi
if sudo -u postgres psql -X -At -d "$DB_NAME" -c "SELECT count(*) FROM mobility.outbox_event WHERE event_type='ride.driver_offer_declined' AND aggregate_id='55555555-5555-4555-8555-555555555555'" | grep -qx '1'; then :; else echo "driver_fairness_result=FAIL reason=duplicate_decline_event" >&2; exit 1; fi
if sudo -u postgres psql -X -At -d "$DB_NAME" -c "SELECT count(*) FROM mobility.driver_offer WHERE id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'" | grep -qx '0'; then :; else echo "driver_fairness_result=FAIL reason=excessive_pickup_offer_issued" >&2; exit 1; fi
if sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null 2>&1
SET ROLE driver_fairness_untrusted;
SELECT * FROM mobility.driver_offer_disclosure;
SQL
then echo "driver_fairness_result=FAIL reason=untrusted_disclosure_read_allowed" >&2; exit 1; fi

echo "driver_fairness_result=PASS database=${DB_NAME} controls=transparent_offer-commission_cap-nonpunitive_decline-pickup_cap"
