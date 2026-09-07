#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PG_BIN="/usr/lib/postgresql/16/bin"
RUN_TOKEN="$(date -u +%Y%m%d%H%M%S)-$$"
TEST_DB="deliveryplatform_safety_${RUN_TOKEN//-/}"
SERVICE_ROLE="mobility_trip_lifecycle_service"
OPERATOR_ROLE="mobility_safety_operator_service"
SUPPORT_ROLE="mobility_support_operator_service"
BILLING_ROLE="mobility_business_billing_service"
CONTAINER_NAME="${PRIVATE_BETA_POSTGRES_CONTAINER:-}"
CREATED_ROLES=()
MIGRATIONS=(
  "$ROOT/drizzle/0000_jittery_pride.sql"
  "$ROOT/drizzle/0026_ride_hailing_dispatch.sql"
  "$ROOT/drizzle/0038_payment_webhook_verification_queue.sql"
  "$ROOT/drizzle/0039_payment_webhook_correlation.sql"
  "$ROOT/drizzle/0040_payment_settlement_reconciliation.sql"
  "$ROOT/drizzle/0041_private_beta_trip_lifecycle.sql"
  "$ROOT/drizzle/0042_private_beta_safety_incident_operations.sql"
  "$ROOT/drizzle/0043_private_beta_experience_and_business.sql"
)

psql_admin() {
  if [[ -n "$CONTAINER_NAME" ]]; then
    sudo docker exec -i "$CONTAINER_NAME" psql -X -U postgres "$@"
  else
    sudo -u postgres psql -X "$@"
  fi
}

createdb_admin() {
  if [[ -n "$CONTAINER_NAME" ]]; then
    sudo docker exec -i "$CONTAINER_NAME" createdb -U postgres "$@"
  else
    sudo -u postgres createdb "$@"
  fi
}

dropdb_admin() {
  if [[ -n "$CONTAINER_NAME" ]]; then
    sudo docker exec -i "$CONTAINER_NAME" dropdb -U postgres "$@"
  else
    sudo -u postgres dropdb "$@"
  fi
}

cleanup() {
  local exit_code=$?
  local role
  set +e
  dropdb_admin --if-exists "$TEST_DB" >/dev/null 2>&1
  for role in "${CREATED_ROLES[@]}"; do
    psql_admin -d postgres -c "DROP ROLE IF EXISTS ${role}" >/dev/null 2>&1
  done
  exit "$exit_code"
}
trap cleanup EXIT

if [[ -n "$CONTAINER_NAME" ]]; then
  command -v docker >/dev/null 2>&1 || { printf 'missing command: docker\n' >&2; exit 1; }
  [[ "$(sudo docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME")" == "true" ]] || { printf 'temporary PostgreSQL container is not running: %s\n' "$CONTAINER_NAME" >&2; exit 1; }
else
  for command in sudo psql createdb dropdb; do command -v "$command" >/dev/null 2>&1 || { printf 'missing command: %s\n' "$command" >&2; exit 1; }; done
  [[ -x "$PG_BIN/pg_isready" ]] || { printf 'PostgreSQL 16 binaries are unavailable\n' >&2; exit 1; }
  "$PG_BIN/pg_isready" -q || { printf 'local PostgreSQL server is unavailable\n' >&2; exit 1; }
fi

for role in "$SERVICE_ROLE" "$OPERATOR_ROLE" "$SUPPORT_ROLE" "$BILLING_ROLE"; do
  if [[ "$(psql_admin -d postgres -At -v ON_ERROR_STOP=1 -c "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}')")" != "t" ]]; then
    psql_admin -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${role} NOLOGIN;" >/dev/null
    CREATED_ROLES+=("$role")
  fi
done
createdb_admin "$TEST_DB"
for migration in "${MIGRATIONS[@]}"; do psql_admin -v ON_ERROR_STOP=1 -d "$TEST_DB" -f - < "$migration" >/dev/null; done

printf '%s\n' '=== Private-beta safety operations integration ==='
psql_admin -v ON_ERROR_STOP=1 -d "$TEST_DB" <<'SQL'
CREATE OR REPLACE FUNCTION public.assert_true(p_condition boolean, p_message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(p_condition, false) = false THEN RAISE EXCEPTION '%', p_message USING ERRCODE = '23514'; END IF;
END;
$$;
BEGIN;
INSERT INTO public.users (id, open_id, name, role, last_signed_in)
VALUES (101, 'safety-rider-101', 'Safety Rider', 'user', NOW()),
       (202, 'safety-driver-202', 'Safety Driver', 'user', NOW()),
       (303, 'safety-operator-303', 'Safety Operator', 'admin', NOW()),
       (304, 'billing-operator-304', 'Billing Operator', 'admin', NOW());
SELECT setval(pg_get_serial_sequence('public.users','id'), 304, true);
INSERT INTO mobility.driver_profile (user_id, legal_name, display_name, account_state, safety_state, payout_state)
VALUES (202, 'Safety Driver', 'Safety Driver', 'active', 'clear', 'verified');
INSERT INTO mobility.vehicle (id, driver_user_id, registration_number, make, model, manufacture_year, colour, passenger_capacity, vehicle_class, active)
VALUES ('00000000-0000-0000-0000-0000000000a1', 202, 'SAFE-202', 'Test', 'Ride', 2022, 'blue', 4, 'beta_standard', true);
INSERT INTO mobility.service_zone (id, city_code, zone_code, version, display_name, boundary, active, dispatch_enabled, policy_version, effective_from)
VALUES ('00000000-0000-0000-0000-0000000000a2', 'LAG', 'safety-zone', 1, 'Safety Zone', ST_GeomFromText('MULTIPOLYGON(((3.30 6.45,3.50 6.45,3.50 6.60,3.30 6.60,3.30 6.45)))',4326), true, true, 'safety-zone-v1', NOW());
INSERT INTO mobility.fare_rule_version (id, zone_id, version, base_kobo, per_km_kobo, per_minute_kobo, minimum_kobo, cancellation_kobo, demand_cap_basis_points, effective_from)
VALUES ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a2', 'safety-fare-v1', 1000, 100, 10, 1000, 200, 10000, NOW());
INSERT INTO mobility.driver_eligibility (driver_user_id, active_vehicle_id, eligible, eligible_until, policy_version)
VALUES (202, '00000000-0000-0000-0000-0000000000a1', true, NOW()+interval '1 hour', 'safety-eligibility-v1');
INSERT INTO mobility.driver_presence (driver_user_id, state, zone_id, last_point, last_location_at, location_valid_until, accuracy_m, integrity_score)
VALUES (202, 'reserved', '00000000-0000-0000-0000-0000000000a2', ST_SetSRID(ST_MakePoint(3.3792,6.5244),4326)::geography, NOW(), NOW()+interval '30 minutes', 5, 95);
INSERT INTO mobility.fare_quote (id, rider_user_id, zone_id, fare_rule_id, route_provider, route_provider_version, quoted_distance_m, quoted_duration_s, base_kobo, distance_kobo, time_kobo, demand_kobo, taxes_and_fees_kobo, total_kobo, disclosure_version, calculation, expires_at)
VALUES ('00000000-0000-0000-0000-0000000000a4', 101, '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'test-route', 'v1', 1000, 600, 1000, 100, 10, 0, 0, 1110, 'v1', '{}'::jsonb, NOW()+interval '15 minutes');
INSERT INTO mobility.ride_trip (id, rider_user_id, assigned_driver_user_id, state, zone_id, fare_quote_id, pickup, destination, pickup_address, destination_address)
VALUES ('00000000-0000-0000-0000-0000000000a5', 101, 202, 'driver_reserved', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4', ST_SetSRID(ST_MakePoint(3.3792,6.5244),4326)::geography, ST_SetSRID(ST_MakePoint(3.3900,6.5300),4326)::geography, 'Pickup', 'Destination');
UPDATE mobility.driver_presence SET active_trip_id='00000000-0000-0000-0000-0000000000a5' WHERE driver_user_id=202;

INSERT INTO mobility.safety_trusted_contact (id, rider_user_id, channel, encrypted_locator, locator_digest, consent_version, verified_at)
VALUES ('00000000-0000-0000-0000-0000000000a6', 101, 'sms', repeat(E'\\001', 28)::bytea, digest('+2348012345678','sha256'), 'private-beta-v1', NOW());
SELECT assert_true((SELECT mobility.create_trip_share_link('00000000-0000-0000-0000-0000000000a5',101,'00000000-0000-0000-0000-0000000000a6',digest('share-token','sha256'),NOW()+interval '1 hour',NOW()) IS NOT NULL), 'verified trusted contact creates bounded share link');
SELECT assert_true((SELECT token_digest = digest('share-token','sha256') AND expires_at <= created_at+interval '24 hours' FROM mobility.trip_share_link LIMIT 1), 'share link stores only digest and bounded expiry');

SELECT assert_true((SELECT created AND severity='critical' AND containment_state='trip_paused' FROM mobility.raise_safety_incident('00000000-0000-0000-0000-0000000000a5',101,'emergency_assist','safety-report-0001','request-safety-001',NULL,NOW())), 'emergency incident is durably recorded and pauses eligible trip');
SELECT assert_true((SELECT NOT created FROM mobility.raise_safety_incident('00000000-0000-0000-0000-0000000000a5',101,'emergency_assist','safety-report-0001','request-safety-001',NULL,NOW())), 'duplicate safety incident is idempotent');
SELECT assert_true((SELECT state='safety_paused' FROM mobility.ride_trip WHERE id='00000000-0000-0000-0000-0000000000a5'), 'emergency containment pauses trip');
SELECT assert_true((SELECT COUNT(*)=1 FROM mobility.safety_incident), 'one incident exists after idempotent retry');

SELECT assert_true((SELECT next_state='triaged' FROM mobility.apply_safety_incident_action((SELECT id FROM mobility.safety_incident),303,'triage','safety-triage-0001','{}'::jsonb,NOW())), 'operator triages incident');
SELECT assert_true((SELECT next_state='acknowledged' FROM mobility.apply_safety_incident_action((SELECT id FROM mobility.safety_incident),303,'acknowledge','safety-ack-0001','{}'::jsonb,NOW())), 'operator acknowledges incident');
SELECT assert_true((SELECT next_state='contained' AND containment_state='driver_restricted' FROM mobility.apply_safety_incident_action((SELECT id FROM mobility.safety_incident),303,'contain','safety-contain-0001','{}'::jsonb,NOW())), 'operator containment restricts associated driver');
SELECT assert_true((SELECT safety_state='review' FROM mobility.driver_profile WHERE user_id=202), 'containment moves driver to review');
SELECT assert_true((SELECT NOT eligible AND exclusion_code='safety_incident' FROM mobility.driver_eligibility WHERE driver_user_id=202), 'containment excludes driver from matching');
SELECT assert_true((SELECT next_state='resolved' FROM mobility.apply_safety_incident_action((SELECT id FROM mobility.safety_incident),303,'resolve','safety-resolve-0001','{"resolution_code":"operator_review"}'::jsonb,NOW())), 'resolution requires immutable disposition event');
SELECT assert_true((SELECT containment_state='released' FROM mobility.apply_safety_incident_action((SELECT id FROM mobility.safety_incident),303,'release_containment','safety-release-0001','{}'::jsonb,NOW())), 'containment release is separately audited');
SELECT assert_true((SELECT next_state='closed' FROM mobility.apply_safety_incident_action((SELECT id FROM mobility.safety_incident),303,'close','safety-close-0001','{"resolution_code":"operator_review"}'::jsonb,NOW())), 'incident closes after disposition and release');

DO $$ BEGIN
  UPDATE mobility.safety_incident_event SET action='altered' WHERE incident_id=(SELECT id FROM mobility.safety_incident LIMIT 1);
  RAISE EXCEPTION 'expected append-only rejection did not occur';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END $$;
SELECT assert_true((SELECT COUNT(*) >= 6 FROM mobility.safety_incident_event), 'incident timeline remains append-only across actions');
SELECT assert_true((SELECT COUNT(*)=0 FROM mobility.ledger_transaction), 'safety workflow does not mutate financial ledger');
COMMIT;
SQL

psql_admin -v ON_ERROR_STOP=1 -d "$TEST_DB" <<SQL
DO \$\$
BEGIN
  IF has_table_privilege('$SERVICE_ROLE','mobility.safety_incident','UPDATE') THEN
    RAISE EXCEPTION 'lifecycle service received incident update privilege';
  END IF;
  IF NOT has_function_privilege('$SERVICE_ROLE','mobility.apply_safety_incident_action(uuid,integer,mobility.safety_incident_action,text,jsonb,timestamp with time zone)','EXECUTE') THEN
    RAISE EXCEPTION 'lifecycle service cannot execute safety function';
  END IF;
  IF has_table_privilege('$OPERATOR_ROLE','mobility.safety_incident_event','UPDATE') THEN
    RAISE EXCEPTION 'operator received append-only event update privilege';
  END IF;
END \$\$;
SQL

psql_admin -v ON_ERROR_STOP=1 -d "$TEST_DB" <<'SQL'
BEGIN;
INSERT INTO mobility.service_category (id, zone_id, code, display_name, state, min_passengers, max_passengers, policy_version)
VALUES ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a2','standard','Standard','active',1,4,'category-v1');
INSERT INTO mobility.driver_service_category (driver_user_id, service_category_id, vehicle_id, state, approved_at)
VALUES (202,'00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1','eligible',NOW());
INSERT INTO mobility.fare_quote (id,rider_user_id,zone_id,fare_rule_id,route_provider,route_provider_version,quoted_distance_m,quoted_duration_s,base_kobo,distance_kobo,time_kobo,demand_kobo,taxes_and_fees_kobo,total_kobo,disclosure_version,calculation,expires_at)
VALUES ('00000000-0000-0000-0000-0000000000b2',101,'00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000a3','test-route','v1',1000,600,1000,100,10,0,0,1110,'v1','{}'::jsonb,NOW()+interval '15 minutes');
INSERT INTO mobility.ride_trip (id,rider_user_id,assigned_driver_user_id,state,zone_id,fare_quote_id,pickup,destination,pickup_address,destination_address)
VALUES ('00000000-0000-0000-0000-0000000000b3',101,202,'quote_created','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000b2',ST_SetSRID(ST_MakePoint(3.3792,6.5244),4326)::geography,ST_SetSRID(ST_MakePoint(3.3900,6.5300),4326)::geography,'Pickup','Destination');
SELECT assert_true(mobility.select_trip_service_category('00000000-0000-0000-0000-0000000000b3',101,'00000000-0000-0000-0000-0000000000b1',NOW())='00000000-0000-0000-0000-0000000000b1'::uuid,'rider selects active zone category before matching');
SELECT assert_true((SELECT service_category_id='00000000-0000-0000-0000-0000000000b1'::uuid FROM mobility.ride_trip WHERE id='00000000-0000-0000-0000-0000000000b3'),'category selection persists on trip');
UPDATE mobility.ride_trip SET state='completed', completed_at=NOW() WHERE id='00000000-0000-0000-0000-0000000000b3';
SELECT assert_true(mobility.submit_trip_feedback('00000000-0000-0000-0000-0000000000b3',101,5::smallint,'["safe","courteous"]'::jsonb,'Good trip','feedback-0001',NOW()) IS NOT NULL,'rider feedback is participant-bound');
SELECT assert_true(mobility.submit_trip_feedback('00000000-0000-0000-0000-0000000000b3',101,5::smallint,'["safe","courteous"]'::jsonb,'Good trip','feedback-0001',NOW())=(SELECT id FROM mobility.trip_feedback WHERE author_user_id=101),'feedback retry is idempotent');
SELECT assert_true(mobility.create_trip_support_case('00000000-0000-0000-0000-0000000000b3',101,'trip_quality','Ride quality','Question about the trip outcome','support-0001',NOW()) IS NOT NULL,'trip participant opens support case');
DO $$ BEGIN
  PERFORM mobility.apply_trip_support_case_action((SELECT id FROM mobility.trip_support_case WHERE requester_user_id=101),101,'assign','support-denied-0001',NULL,NOW());
  RAISE EXCEPTION 'expected non-admin support action denial did not occur';
EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END $$;
SELECT assert_true((SELECT next_state='assigned' FROM mobility.apply_trip_support_case_action((SELECT id FROM mobility.trip_support_case WHERE requester_user_id=101),303,'assign','support-assign-0001',NULL,NOW())),'support operator assigns case');
SELECT assert_true((SELECT next_state='assigned' FROM mobility.apply_trip_support_case_action((SELECT id FROM mobility.trip_support_case WHERE requester_user_id=101),303,'assign','support-assign-0001',NULL,NOW())),'support assignment retry is idempotent');
SELECT assert_true((SELECT next_state='awaiting_requester' FROM mobility.apply_trip_support_case_action((SELECT id FROM mobility.trip_support_case WHERE requester_user_id=101),303,'request_information','support-info-0001','Provide the pickup time for the review.',NOW())),'support operator requests information');
SELECT assert_true((SELECT next_state='resolved' FROM mobility.apply_trip_support_case_action((SELECT id FROM mobility.trip_support_case WHERE requester_user_id=101),303,'resolve','support-resolve-0001','Review completed with rider guidance.',NOW())),'support operator resolves case');
SELECT assert_true((SELECT next_state='closed' FROM mobility.apply_trip_support_case_action((SELECT id FROM mobility.trip_support_case WHERE requester_user_id=101),303,'close','support-close-0001','Closure follows documented resolution.',NOW())),'support operator closes resolved case');
DO $$ BEGIN
  UPDATE mobility.trip_support_case_event SET action='altered';
  RAISE EXCEPTION 'expected support timeline append-only rejection did not occur';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END $$;
INSERT INTO mobility.business_account (id,display_name,billing_email,state,policy_version,created_by)
VALUES ('00000000-0000-0000-0000-0000000000b4','Test Business','billing@example.test','active','business-v1',303);
INSERT INTO mobility.business_traveler (business_account_id,user_id,employee_reference,active)
VALUES ('00000000-0000-0000-0000-0000000000b4',101,'employee-101',true);
INSERT INTO mobility.business_account_operator (business_account_id,user_id,role,active,granted_by)
VALUES ('00000000-0000-0000-0000-0000000000b4',303,'approver',true,303),
       ('00000000-0000-0000-0000-0000000000b4',304,'billing',true,303);
INSERT INTO mobility.fare_quote (id,rider_user_id,zone_id,fare_rule_id,route_provider,route_provider_version,quoted_distance_m,quoted_duration_s,base_kobo,distance_kobo,time_kobo,demand_kobo,taxes_and_fees_kobo,total_kobo,disclosure_version,calculation,expires_at)
VALUES ('00000000-0000-0000-0000-0000000000b5',101,'00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000a3','test-route','v1',1000,600,1000,100,10,0,0,1110,'v1','{}'::jsonb,NOW()+interval '15 minutes');
INSERT INTO mobility.ride_trip (id,rider_user_id,state,zone_id,fare_quote_id,pickup,destination,pickup_address,destination_address)
VALUES ('00000000-0000-0000-0000-0000000000b6',101,'quote_created','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000b5',ST_SetSRID(ST_MakePoint(3.3792,6.5244),4326)::geography,ST_SetSRID(ST_MakePoint(3.3900,6.5300),4326)::geography,'Pickup','Destination');
SELECT assert_true(mobility.attribute_business_trip('00000000-0000-0000-0000-0000000000b6',101,'00000000-0000-0000-0000-0000000000b4','OPS',NOW())='requested','active traveler may request business trip attribution');
DO $$ BEGIN
  PERFORM mobility.apply_business_trip_attribution_action('00000000-0000-0000-0000-0000000000b6',304,'approve','business-denied-0001',NULL,NULL,NOW());
  RAISE EXCEPTION 'expected billing-only approval denial did not occur';
EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END $$;
SELECT assert_true((SELECT next_state='approved' FROM mobility.apply_business_trip_attribution_action('00000000-0000-0000-0000-0000000000b6',303,'approve','business-approve-0001',NULL,NULL,NOW())),'business approver accepts requested attribution');
SELECT assert_true((SELECT next_state='approved' FROM mobility.apply_business_trip_attribution_action('00000000-0000-0000-0000-0000000000b6',303,'approve','business-approve-0001',NULL,NULL,NOW())),'business approval retry is idempotent');
UPDATE mobility.ride_trip SET state='completed', completed_at=NOW() WHERE id='00000000-0000-0000-0000-0000000000b6';
SELECT assert_true((SELECT next_state='invoiced' FROM mobility.apply_business_trip_attribution_action('00000000-0000-0000-0000-0000000000b6',304,'mark_invoiced','business-invoice-0001',NULL,'invoice-ci-0001',NOW())),'billing operator records completed-trip invoice reference');
DO $$ BEGIN
  UPDATE mobility.business_trip_attribution_event SET invoice_reference='altered';
  RAISE EXCEPTION 'expected business attribution timeline append-only rejection did not occur';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END $$;
SELECT assert_true((SELECT COUNT(*)=0 FROM mobility.ledger_transaction),'experience and business attribution do not mutate financial ledger');
COMMIT;
SQL

psql_admin -v ON_ERROR_STOP=1 -d "$TEST_DB" <<SQL
DO \$\$
BEGIN
  IF has_table_privilege('$SERVICE_ROLE','mobility.trip_feedback','UPDATE') OR has_table_privilege('$SERVICE_ROLE','mobility.trip_support_case','INSERT') OR has_table_privilege('$SERVICE_ROLE','mobility.business_trip_attribution','UPDATE') THEN
    RAISE EXCEPTION 'experience lifecycle role received direct mutation privilege';
  END IF;
  IF NOT has_function_privilege('$SERVICE_ROLE','mobility.select_trip_service_category(uuid,integer,uuid,timestamp with time zone)','EXECUTE')
     OR NOT has_function_privilege('$SERVICE_ROLE','mobility.submit_trip_feedback(uuid,integer,smallint,jsonb,text,text,timestamp with time zone)','EXECUTE')
     OR NOT has_function_privilege('$SERVICE_ROLE','mobility.create_trip_support_case(uuid,integer,text,text,text,text,timestamp with time zone)','EXECUTE')
     OR NOT has_function_privilege('$SERVICE_ROLE','mobility.attribute_business_trip(uuid,integer,uuid,text,timestamp with time zone)','EXECUTE') THEN
    RAISE EXCEPTION 'experience lifecycle role is missing required bounded function access';
  END IF;
  IF has_table_privilege('$SUPPORT_ROLE','mobility.trip_support_case','UPDATE')
     OR has_table_privilege('$SUPPORT_ROLE','mobility.trip_support_case_event','INSERT')
     OR NOT has_function_privilege('$SUPPORT_ROLE','mobility.apply_trip_support_case_action(uuid,integer,mobility.support_case_action,text,text,timestamp with time zone)','EXECUTE') THEN
    RAISE EXCEPTION 'support operator role violates least-privilege transition access';
  END IF;
  IF has_table_privilege('$BILLING_ROLE','mobility.business_trip_attribution','UPDATE')
     OR has_table_privilege('$BILLING_ROLE','mobility.business_trip_attribution_event','INSERT')
     OR has_table_privilege('$BILLING_ROLE','mobility.business_account_operator','INSERT')
     OR NOT has_function_privilege('$BILLING_ROLE','mobility.apply_business_trip_attribution_action(uuid,integer,mobility.business_trip_attribution_action,text,text,text,timestamp with time zone)','EXECUTE') THEN
    RAISE EXCEPTION 'business billing role violates least-privilege transition access';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc AS procedure_row
    WHERE procedure_row.oid=to_regprocedure('mobility.apply_trip_support_case_action(uuid,integer,mobility.support_case_action,text,text,timestamp with time zone)')
      AND procedure_row.prosecdef
      AND procedure_row.proconfig @> ARRAY['search_path=pg_catalog, mobility']
  ) THEN
    RAISE EXCEPTION 'support transition function lacks required security-definer search path';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc AS procedure_row
    WHERE procedure_row.oid=to_regprocedure('mobility.apply_business_trip_attribution_action(uuid,integer,mobility.business_trip_attribution_action,text,text,text,timestamp with time zone)')
      AND procedure_row.prosecdef
      AND procedure_row.proconfig @> ARRAY['search_path=pg_catalog, mobility']
  ) THEN
    RAISE EXCEPTION 'business transition function lacks required security-definer search path';
  END IF;
END \$\$;
SQL

printf '%s\n' 'private_beta_experience_result=PASS'
