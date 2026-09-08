#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_NAME="vehicle_tracker_safety_validation_${$}_$(date +%s)"
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
    role_safe "$role" || { echo "vehicle_tracker_safety=FAIL reason=unsafe_existing_role role=$role" >&2; exit 1; }
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
  (1,'tracker-requesting-operator','Tracker Requesting Operator','admin'),
  (2,'tracker-worker','Tracker Worker','user'),
  (3,'tracker-untrusted','Tracker Untrusted','user'),
  (4,'tracker-authorizing-operator','Tracker Authorizing Operator','admin');
SQL
for migration in \
  "$ROOT_DIR/drizzle/0050_gig_worker_vehicle_access.sql" \
  "$ROOT_DIR/drizzle/0058_gig_vehicle_rental_operations.sql" \
  "$ROOT_DIR/drizzle/0059_vehicle_tracker_geofence_safety_controls.sql"; do
  sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$migration" >/dev/null
done

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE vehicle_access_service;
SELECT vehicle_access.create_provider(1,'Tracker Fleet','Tracker Fleet Limited',timestamptz '2026-09-08 08:00:00+00') AS provider_id \gset
SELECT vehicle_access.register_asset(1, :'provider_id'::uuid,'TRK-SAFE-001',encode(public.digest('JTHBK1GG2F1234567','sha256'),'hex'),'Toyota','Corolla',2019,10000,4::smallint,'["ride_hailing"]'::jsonb,timestamptz '2026-09-08 08:01:00+00') AS asset_id \gset
SELECT vehicle_access.record_asset_evidence(1, :'asset_id'::uuid, evidence_kind, 'vehicle/evidence/' || evidence_kind || '.pdf', encode(public.digest(evidence_kind,'sha256'),'hex'),timestamptz '2027-09-08 00:00:00+00','tracker-evidence-' || evidence_kind,timestamptz '2026-09-08 08:02:00+00')
FROM unnest(ARRAY['registration','roadworthiness','commercial_cover','ownership_authority','inspection']) AS evidence_kind;
SELECT vehicle_access.activate_asset(1, :'asset_id'::uuid,'tracker-asset-activate-0001',timestamptz '2026-09-08 08:03:00+00');
SELECT vehicle_access.create_offer(1, :'provider_id'::uuid, :'asset_id'::uuid,'NGN'::char(3),650000::bigint,100000::bigint,1200,150::bigint,7::smallint,timestamptz '2026-09-08 08:04:00+00') AS offer_id \gset
SELECT vehicle_access.upsert_worker_eligibility(1,2,'["ride_hailing"]'::jsonb,timestamptz '2027-09-08 00:00:00+00',timestamptz '2026-09-08 08:04:30+00');
SELECT vehicle_access.request_contract_with_add_ons(2, :'offer_id'::uuid,timestamptz '2026-09-10 08:00:00+00',timestamptz '2026-09-24 08:00:00+00','[]'::jsonb,'tracker-contract-request-0001',timestamptz '2026-09-08 08:05:00+00') AS contract_id \gset
SELECT vehicle_access.transition_contract(1, :'contract_id'::uuid,'approve',NULL,'tracker-contract-approve-0001',timestamptz '2026-09-09 08:00:00+00');
SELECT vehicle_access.record_inspection(2, :'contract_id'::uuid,'handover','vehicle/contracts/handover.jpg','image/jpeg',encode(public.digest('tracker-handover','sha256'),'hex'),10000,'tracker-handover-proof-0001',timestamptz '2026-09-10 08:00:00+00');
SELECT vehicle_access.record_agreement_acceptance(2, :'contract_id'::uuid,'rental-terms-2026-09',encode(public.digest('agreement-v1','sha256'),'hex'),encode(public.digest('tracker-worker-acceptance','sha256'),'hex'),'tracker-agreement-0001',timestamptz '2026-09-10 08:01:00+00');
SELECT vehicle_access.transition_contract(1, :'contract_id'::uuid,'handover',NULL,'tracker-contract-handover-0001',timestamptz '2026-09-10 08:02:00+00');

SELECT vehicle_access.create_tracker_provider(1, :'provider_id'::uuid,'generic_webhook','fleet_tracker','Fleet Tracker','secrets/tracker/fleet', 'tracker-provider-0001', timestamptz '2026-09-10 08:03:00+00') AS tracker_provider_id \gset
SELECT vehicle_access.register_asset_tracker(1, :'asset_id'::uuid, :'tracker_provider_id'::uuid,'device-001',encode(public.digest('device-001','sha256'),'hex'),true,'asset-tracker-0001',timestamptz '2026-09-10 08:03:30+00') AS tracker_id \gset
SELECT vehicle_access.create_rental_asset_geofence(1, :'asset_id'::uuid,'restricted','RSTR_HUB','Restricted hub', '{"type":"MultiPolygon","coordinates":[[[[3.3700,6.5200],[3.3900,6.5200],[3.3900,6.5300],[3.3700,6.5300],[3.3700,6.5200]]]]}'::jsonb,'tracker-geofence-0001',timestamptz '2026-09-10 08:04:00+00') AS geofence_id \gset
SELECT vehicle_access.record_tracker_control_consent(2, :'contract_id'::uuid,'tracker-control-v1',encode(public.digest('tracker-consent-v1','sha256'),'hex'),'tracker-consent-0001',timestamptz '2026-09-10 08:04:30+00') AS consent_id \gset
SELECT vehicle_access.record_tracker_control_consent(2, :'contract_id'::uuid,'tracker-control-v1',encode(public.digest('tracker-consent-v1','sha256'),'hex'),'tracker-consent-0001',timestamptz '2026-09-10 08:04:31+00') = :'consent_id'::uuid AS consent_retry_idempotent;
SELECT vehicle_access.record_vehicle_tracker_signal(:'tracker_id'::uuid,'tracker-event-0001','position'::vehicle_access.tracker_signal_kind,timestamptz '2026-09-10 08:05:00+00',6.5244::numeric,3.3792::numeric,0::numeric,180::numeric,8::numeric,10000::numeric,false,98::smallint,encode(public.digest('tracker-event-0001','sha256'),'hex'),'{"source":"validator"}'::jsonb,timestamptz '2026-09-10 08:05:30+00') AS signal_id \gset
SELECT vehicle_access.record_vehicle_tracker_signal(:'tracker_id'::uuid,'tracker-event-0001','position'::vehicle_access.tracker_signal_kind,timestamptz '2026-09-10 08:05:00+00',6.5244::numeric,3.3792::numeric,0::numeric,180::numeric,8::numeric,10000::numeric,false,98::smallint,encode(public.digest('tracker-event-0001','sha256'),'hex'),'{"source":"validator"}'::jsonb,timestamptz '2026-09-10 08:05:31+00') = :'signal_id'::uuid AS signal_retry_idempotent;
SELECT vehicle_access.record_rental_payment_tracking_signal(1, :'contract_id'::uuid,encode(public.digest('payment-reference-001','sha256'),'hex'),'past_due',timestamptz '2026-09-09 08:00:00+00',timestamptz '2026-09-10 08:05:00+00',encode(public.digest('payment-evidence-001','sha256'),'hex'),'rental_payment_authority','payment-signal-0001',timestamptz '2026-09-10 08:05:30+00') AS payment_signal_id \gset
SELECT vehicle_access.request_prevent_next_start(1, :'contract_id'::uuid, :'payment_signal_id'::uuid,'rental.payment_grace_elapsed','prevent-next-start-0001',timestamptz '2026-09-10 08:05:45+00') AS control_case_id \gset
RESET ROLE;

DO $$
DECLARE v_case uuid;
BEGIN
  SELECT id INTO v_case FROM vehicle_access.prevent_next_start_case LIMIT 1;
  BEGIN
    PERFORM vehicle_access.authorize_prevent_next_start(1,v_case,'prevent-next-start-self-authorize-0001',timestamptz '2026-09-10 08:06:00+00');
    RAISE EXCEPTION 'self authorization unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    RAISE NOTICE 'expected independent operator rejection: SQLSTATE %', SQLSTATE;
  END;
END;
$$;
SET ROLE vehicle_access_service;
SELECT vehicle_access.authorize_prevent_next_start(4, :'control_case_id'::uuid,'prevent-next-start-authorize-0001',timestamptz '2026-09-10 08:06:00+00') AS authorization_state;
SELECT * FROM vehicle_access.claim_prevent_next_start_command('validator-tracker-worker',timestamptz '2026-09-10 08:06:15+00') \gset
SELECT vehicle_access.mark_prevent_next_start_dispatched(:'command_id'::uuid, :'claim_token'::uuid,'provider-command-001',timestamptz '2026-09-10 08:06:30+00') AS dispatch_state;
SELECT vehicle_access.complete_prevent_next_start_command(:'command_id'::uuid, :'claim_token'::uuid,true,encode(public.digest('provider-ack-001','sha256'),'hex'),'provider acknowledged prevent-next-start',timestamptz '2026-09-10 08:06:45+00') AS completion_state;
SELECT vehicle_access.tracker_operations_snapshot(1) AS tracker_snapshot \gset
RESET ROLE;

DO $$
DECLARE v_tracker uuid; v_contract uuid;
BEGIN
  SELECT id INTO v_tracker FROM vehicle_access.vehicle_asset_tracker LIMIT 1;
  SELECT id INTO v_contract FROM vehicle_access.access_contract LIMIT 1;
  BEGIN
    PERFORM vehicle_access.record_vehicle_tracker_signal(v_tracker,'tracker-event-0001','position'::vehicle_access.tracker_signal_kind,timestamptz '2026-09-10 08:05:00+00',6.5244::numeric,3.3792::numeric,0::numeric,180::numeric,8::numeric,10000::numeric,false,98::smallint,encode(public.digest('altered-tracker-event','sha256'),'hex'),'{}'::jsonb,timestamptz '2026-09-10 08:07:00+00');
    RAISE EXCEPTION 'altered tracker retry unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE '23505' THEN
    RAISE NOTICE 'expected altered tracker retry rejection: SQLSTATE %', SQLSTATE;
  END;
  BEGIN
    UPDATE vehicle_access.vehicle_tracker_signal SET integrity_score=100;
    RAISE EXCEPTION 'tracker evidence unexpectedly mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    RAISE NOTICE 'expected append-only tracker evidence denial: SQLSTATE %', SQLSTATE;
  END;
END;
$$;
SET ROLE vehicle_access_service;
SELECT vehicle_access.record_vehicle_tracker_signal(:'tracker_id'::uuid,'tracker-event-moving-0001','position'::vehicle_access.tracker_signal_kind,timestamptz '2026-09-10 08:07:00+00',6.5245::numeric,3.3793::numeric,30::numeric,180::numeric,8::numeric,10001::numeric,true,98::smallint,encode(public.digest('tracker-event-moving-0001','sha256'),'hex'),'{"source":"validator"}'::jsonb,timestamptz '2026-09-10 08:07:00+00');
SELECT vehicle_access.record_rental_payment_tracking_signal(1, :'contract_id'::uuid,encode(public.digest('payment-reference-002','sha256'),'hex'),'past_due',timestamptz '2026-09-09 08:00:00+00',timestamptz '2026-09-10 08:06:00+00',encode(public.digest('payment-evidence-002','sha256'),'hex'),'rental_payment_authority','payment-signal-0002',timestamptz '2026-09-10 08:07:00+00') AS moving_payment_signal_id \gset
RESET ROLE;
DO $$
DECLARE v_contract uuid; v_payment uuid;
BEGIN
  SELECT id INTO v_contract FROM vehicle_access.access_contract LIMIT 1;
  SELECT id INTO v_payment FROM vehicle_access.rental_payment_tracking_signal ORDER BY created_at DESC LIMIT 1;
  BEGIN
    PERFORM vehicle_access.request_prevent_next_start(1,v_contract,v_payment,'rental.payment_grace_elapsed','prevent-next-start-moving-0001',timestamptz '2026-09-10 08:07:15+00');
    RAISE EXCEPTION 'moving-vehicle control request unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    RAISE NOTICE 'expected moving-vehicle interlock rejection: SQLSTATE %', SQLSTATE;
  END;
END;
$$;
SET ROLE vehicle_access_service;
DO $$
BEGIN
  BEGIN
    PERFORM vehicle_access.append_tracker_control_event('signal',gen_random_uuid(),1,'tampered.event','{}'::jsonb,'tracker-event-helper-0001',clock_timestamp());
    RAISE EXCEPTION 'internal tracker event helper was executable by runtime service';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    RAISE NOTICE 'expected internal tracker helper denial: SQLSTATE %', SQLSTATE;
  END;
  BEGIN
    INSERT INTO vehicle_access.vehicle_tracker_signal(tracker_id,asset_id,signal_kind,external_event_id,observed_at,received_at,integrity_score,payload_digest)
    VALUES(gen_random_uuid(),gen_random_uuid(),'engine','direct-tracker-write-0001',clock_timestamp(),clock_timestamp(),100,public.digest('direct','sha256'));
    RAISE EXCEPTION 'direct tracker table write unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    RAISE NOTICE 'expected direct tracker table write denial: SQLSTATE %', SQLSTATE;
  END;
END;
$$;
RESET ROLE;
SET ROLE vehicle_access_untrusted;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM vehicle_access.vehicle_tracker_signal;
    RAISE EXCEPTION 'untrusted tracker evidence read unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    RAISE NOTICE 'expected untrusted tracker evidence read denial: SQLSTATE %', SQLSTATE;
  END;
END;
$$;
RESET ROLE;

DO $$
DECLARE v_state text; v_flags integer;
BEGIN
  SELECT state::text INTO v_state FROM vehicle_access.prevent_next_start_case ORDER BY created_at ASC LIMIT 1;
  IF v_state <> 'acknowledged' THEN RAISE EXCEPTION 'expected acknowledged prevent-next-start case, got %', v_state; END IF;
  SELECT count(*) INTO v_flags FROM vehicle_access.rental_tracker_risk_flag WHERE flag_code IN ('restricted_geofence_entered','payment_grace_elapsed');
  IF v_flags < 2 THEN RAISE EXCEPTION 'expected restricted-geofence and payment-grace flags'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicle_access.rental_asset_geofence_event) THEN RAISE EXCEPTION 'expected geofence evidence event'; END IF;
END;
$$;
SQL

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 -At <<'SQL' | grep -qx 'vehicle_tracker_safety_security=PASS'
SELECT 'vehicle_tracker_safety_security=PASS';
SQL
echo "vehicle_tracker_safety=PASS database=${DB_NAME} features=tracking,geofences,payment_signals,stationary_only_prevent_next_start"
