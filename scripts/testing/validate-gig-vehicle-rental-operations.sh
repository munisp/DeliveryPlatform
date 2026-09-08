#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_NAME="gig_rental_operations_validation_${$}_$(date +%s)"
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
    role_safe "$role" || { echo "gig_vehicle_rental_operations=FAIL reason=unsafe_existing_role role=$role" >&2; exit 1; }
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
  (1,'rental-admin','Rental Admin','admin'),
  (2,'rental-worker','Rental Worker','user'),
  (3,'rental-other','Rental Other','user');
SQL
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$ROOT_DIR/drizzle/0050_gig_worker_vehicle_access.sql" >/dev/null
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$ROOT_DIR/drizzle/0058_gig_vehicle_rental_operations.sql" >/dev/null

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE vehicle_access_service;
SELECT vehicle_access.create_provider(1,'City Mobility Fleet','City Mobility Fleet Limited',timestamptz '2026-09-08 08:00:00+00') AS provider_id \gset
SELECT vehicle_access.register_asset(1, :'provider_id'::uuid,'LAG-RNT-001',encode(public.digest('1HGBH41JXMN109186','sha256'),'hex'),'Toyota','Corolla',2018,85400,4::smallint,'["ride_hailing","delivery"]'::jsonb,timestamptz '2026-09-08 08:01:00+00') AS asset_id \gset
SELECT vehicle_access.record_asset_evidence(1, :'asset_id'::uuid, evidence_kind, 'vehicle/evidence/' || evidence_kind || '.pdf', encode(public.digest(evidence_kind,'sha256'),'hex'),timestamptz '2027-09-08 00:00:00+00','asset-evidence-' || evidence_kind,timestamptz '2026-09-08 08:02:00+00')
FROM unnest(ARRAY['registration','roadworthiness','commercial_cover','ownership_authority','inspection']) AS evidence_kind;
SELECT vehicle_access.activate_asset(1, :'asset_id'::uuid,'asset-activate-0001',timestamptz '2026-09-08 08:03:00+00');
SELECT vehicle_access.create_offer(1, :'provider_id'::uuid, :'asset_id'::uuid,'NGN'::char(3),650000::bigint,100000::bigint,1200,150::bigint,7::smallint,timestamptz '2026-09-08 08:04:00+00') AS offer_id \gset
SELECT vehicle_access.upsert_worker_eligibility(1,2,'["ride_hailing","delivery"]'::jsonb,timestamptz '2027-09-08 00:00:00+00',timestamptz '2026-09-08 08:04:30+00');

SELECT vehicle_access.create_provider_location(1, :'provider_id'::uuid,'LAG_IKEJA','Ikeja Hub','1 Mobility Way, Ikeja','Africa/Lagos','location-create-0001',timestamptz '2026-09-08 08:05:00+00') AS location_id \gset
SELECT vehicle_access.create_provider_location(1, :'provider_id'::uuid,'LAG_IKEJA_CHANGED','Changed Hub','2 Mobility Way, Ikeja','Africa/Lagos','location-create-0001',timestamptz '2026-09-08 08:05:01+00') = :'location_id'::uuid AS location_retry_idempotent;
SELECT vehicle_access.assign_asset_location(1, :'asset_id'::uuid, :'location_id'::uuid,'asset-location-0001',timestamptz '2026-09-08 08:06:00+00') AS location_assignment_id \gset
SELECT vehicle_access.assign_asset_location(1, :'asset_id'::uuid, :'location_id'::uuid,'asset-location-0001',timestamptz '2026-09-08 08:06:01+00') = :'location_assignment_id'::uuid AS assignment_retry_idempotent;
SELECT vehicle_access.create_rental_add_on(1, :'provider_id'::uuid,'safety_kit','Safety kit','equipment','NGN'::char(3),'flat'::vehicle_access.rental_add_on_charge_unit,5000::bigint,1::smallint,'add-on-create-0001',timestamptz '2026-09-08 08:07:00+00') AS add_on_id \gset
SELECT vehicle_access.create_rental_add_on(1, :'provider_id'::uuid,'changed_kit','Changed kit','equipment','NGN'::char(3),'flat'::vehicle_access.rental_add_on_charge_unit,7000::bigint,1::smallint,'add-on-create-0001',timestamptz '2026-09-08 08:07:01+00') = :'add_on_id'::uuid AS add_on_retry_idempotent;
SELECT id AS add_on_version_id FROM vehicle_access.list_rental_add_ons_for_offer(:'offer_id'::uuid, 1) LIMIT 1 \gset
SELECT vehicle_access.request_contract_with_add_ons(2, :'offer_id'::uuid,timestamptz '2026-09-10 08:00:00+00',timestamptz '2026-09-24 08:00:00+00',jsonb_build_array(jsonb_build_object('add_on_version_id', :'add_on_version_id', 'quantity', 1)),'contract-request-0001',timestamptz '2026-09-08 08:08:00+00') AS contract_id \gset
SELECT vehicle_access.request_contract_with_add_ons(2, :'offer_id'::uuid,timestamptz '2026-09-10 08:00:00+00',timestamptz '2026-09-24 08:00:00+00',jsonb_build_array(jsonb_build_object('add_on_version_id', :'add_on_version_id', 'quantity', 1)),'contract-request-0001',timestamptz '2026-09-08 08:08:01+00') = :'contract_id'::uuid AS add_on_request_retry_idempotent;

RESET ROLE;
DO $$
DECLARE v_asset uuid;
BEGIN
  SELECT asset_id INTO v_asset FROM vehicle_access.access_contract LIMIT 1;
  BEGIN
    PERFORM vehicle_access.create_availability_block(1, v_asset,'maintenance','Overlapping maintenance',timestamptz '2026-09-12 08:00:00+00',timestamptz '2026-09-13 08:00:00+00','block-conflict-0001',timestamptz '2026-09-08 08:09:00+00');
    RAISE EXCEPTION 'overlapping availability block unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE '23P01' THEN
    RAISE NOTICE 'expected contract availability conflict: SQLSTATE %', SQLSTATE;
  END;
END;
$$;
DO $$
DECLARE v_offer uuid; v_version uuid;
BEGIN
  SELECT id INTO v_offer FROM vehicle_access.vehicle_offer LIMIT 1;
  SELECT id INTO v_version FROM vehicle_access.rental_add_on_version LIMIT 1;
  BEGIN
    PERFORM vehicle_access.request_contract_with_add_ons(2,v_offer,timestamptz '2026-09-10 08:00:00+00',timestamptz '2026-09-24 08:00:00+00',jsonb_build_array(jsonb_build_object('add_on_version_id',v_version,'quantity',0)),'contract-request-0001',timestamptz '2026-09-08 08:08:02+00');
    RAISE EXCEPTION 'altered add-on payload unexpectedly accepted for same idempotency key';
  EXCEPTION WHEN SQLSTATE '23505' THEN
    RAISE NOTICE 'expected altered add-on retry rejection: SQLSTATE %', SQLSTATE;
  END;
END;
$$;
SET ROLE vehicle_access_service;

SELECT vehicle_access.transition_contract(1, :'contract_id'::uuid,'approve',NULL,'contract-approve-0001',timestamptz '2026-09-09 08:00:00+00');
SELECT vehicle_access.record_inspection(2, :'contract_id'::uuid,'handover','vehicle/contracts/handover.jpg','image/jpeg',encode(public.digest('handover-photo','sha256'),'hex'),85400,'handover-proof-0001',timestamptz '2026-09-10 08:00:00+00');
RESET ROLE;
DO $$
DECLARE v_contract uuid;
BEGIN
  SELECT id INTO v_contract FROM vehicle_access.access_contract LIMIT 1;
  BEGIN
    PERFORM vehicle_access.transition_contract(1, v_contract,'handover',NULL,'handover-without-agreement-0001',timestamptz '2026-09-10 08:01:00+00');
    RAISE EXCEPTION 'handover without agreement unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    RAISE NOTICE 'expected agreement prerequisite rejection: SQLSTATE %', SQLSTATE;
  END;
END;
$$;
SET ROLE vehicle_access_service;
SELECT vehicle_access.record_agreement_acceptance(2, :'contract_id'::uuid,'rental-terms-2026-09',encode(public.digest('agreement-v1','sha256'),'hex'),encode(public.digest('acceptance-worker-2','sha256'),'hex'),'agreement-accept-0001',timestamptz '2026-09-10 08:02:00+00') AS agreement_id \gset
SELECT vehicle_access.record_agreement_acceptance(2, :'contract_id'::uuid,'rental-terms-2026-09',encode(public.digest('agreement-v1','sha256'),'hex'),encode(public.digest('acceptance-worker-2','sha256'),'hex'),'agreement-accept-0001',timestamptz '2026-09-10 08:02:01+00') = :'agreement_id'::uuid AS agreement_retry_idempotent;
SELECT vehicle_access.transition_contract(1, :'contract_id'::uuid,'handover',NULL,'contract-handover-0001',timestamptz '2026-09-10 08:03:00+00');
SELECT vehicle_access.request_contract_extension(2, :'contract_id'::uuid,timestamptz '2026-10-01 08:00:00+00','extension-request-0001',timestamptz '2026-09-20 08:00:00+00') AS extension_id \gset
SELECT vehicle_access.request_contract_extension(2, :'contract_id'::uuid,timestamptz '2026-10-01 08:00:00+00','extension-request-0001',timestamptz '2026-09-20 08:00:01+00') = :'extension_id'::uuid AS extension_retry_idempotent;
SELECT vehicle_access.create_availability_block(1, :'asset_id'::uuid,'maintenance','Scheduled maintenance window',timestamptz '2026-09-28 08:00:00+00',timestamptz '2026-10-02 08:00:00+00','block-create-0001',timestamptz '2026-09-20 08:01:00+00') AS block_id \gset
RESET ROLE;
DO $$
DECLARE v_extension uuid;
BEGIN
  SELECT id INTO v_extension FROM vehicle_access.contract_extension_request LIMIT 1;
  BEGIN
    PERFORM vehicle_access.decide_contract_extension(1, v_extension,'approve',NULL,'extension-conflict-0001',timestamptz '2026-09-20 08:02:00+00');
    RAISE EXCEPTION 'extension into a maintenance block unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE '23P01' THEN
    RAISE NOTICE 'expected extension availability conflict: SQLSTATE %', SQLSTATE;
  END;
END;
$$;
SET ROLE vehicle_access_service;
SELECT vehicle_access.cancel_availability_block(1, :'block_id'::uuid,'Maintenance rescheduled','block-cancel-0001',timestamptz '2026-09-20 08:03:00+00');
SELECT vehicle_access.cancel_availability_block(1, :'block_id'::uuid,'Maintenance rescheduled','block-cancel-0001',timestamptz '2026-09-20 08:03:01+00') AS block_cancel_retry_idempotent;
SELECT vehicle_access.decide_contract_extension(1, :'extension_id'::uuid,'approve',NULL,'extension-approve-0001',timestamptz '2026-09-20 08:04:00+00');
SELECT vehicle_access.decide_contract_extension(1, :'extension_id'::uuid,'approve',NULL,'extension-approve-0001',timestamptz '2026-09-20 08:04:01+00') AS extension_decision_retry_idempotent;
RESET ROLE;
DO $$
DECLARE v_contract uuid; v_snapshot jsonb;
BEGIN
  SELECT id INTO v_contract FROM vehicle_access.access_contract LIMIT 1;
  IF (SELECT count(*) FROM vehicle_access.contract_add_on_selection WHERE contract_id=v_contract) <> 1 THEN RAISE EXCEPTION 'expected one immutable add-on selection'; END IF;
  IF (SELECT price_snapshot->>'add_ons_total_minor' FROM vehicle_access.access_contract WHERE id=v_contract) <> '5000' THEN RAISE EXCEPTION 'expected add-on total snapshot'; END IF;
  IF (SELECT ends_at FROM vehicle_access.access_contract WHERE id=v_contract) <> timestamptz '2026-10-01 08:00:00+00' THEN RAISE EXCEPTION 'expected approved extension end'; END IF;
  IF (SELECT count(*) FROM vehicle_access.contract_agreement_acceptance WHERE contract_id=v_contract) <> 1 THEN RAISE EXCEPTION 'expected immutable agreement acceptance'; END IF;
  v_snapshot := vehicle_access.rental_operations_snapshot(1);
  IF coalesce((v_snapshot->>'requested_extensions')::integer,-1) <> 0 THEN RAISE EXCEPTION 'expected no remaining requested extensions'; END IF;
END;
$$;
DO $$
BEGIN
  BEGIN
    UPDATE vehicle_access.contract_agreement_acceptance SET agreement_version='tampered';
    RAISE EXCEPTION 'agreement evidence was mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    RAISE NOTICE 'expected append-only agreement denial: SQLSTATE %', SQLSTATE;
  END;
END;
$$;
SET ROLE vehicle_access_service;
DO $$
BEGIN
  BEGIN
    PERFORM vehicle_access.append_rental_operations_event('asset',gen_random_uuid(),1,'tampered.event','{}'::jsonb,'tampered-event-0001',clock_timestamp());
    RAISE EXCEPTION 'internal event helper was executable by service';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    RAISE NOTICE 'expected internal helper denial: SQLSTATE %', SQLSTATE;
  END;
  BEGIN
    PERFORM vehicle_access.is_operator(1);
    RAISE EXCEPTION 'operator role-check helper was executable by service';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    RAISE NOTICE 'expected role-check helper denial: SQLSTATE %', SQLSTATE;
  END;
  BEGIN
    INSERT INTO vehicle_access.asset_availability_block(asset_id,block_reason,note,starts_at,ends_at,created_by_user_id,idempotency_key)
    VALUES(gen_random_uuid(),'maintenance','direct table write attempt',clock_timestamp(),clock_timestamp()+interval '1 hour',1,'direct-block-0001');
    RAISE EXCEPTION 'service direct table write unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    RAISE NOTICE 'expected direct table write denial: SQLSTATE %', SQLSTATE;
  END;
END;
$$;
RESET ROLE;
SET ROLE vehicle_access_untrusted;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM vehicle_access.asset_availability_block;
    RAISE EXCEPTION 'untrusted availability block read unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    RAISE NOTICE 'expected untrusted table read denial: SQLSTATE %', SQLSTATE;
  END;
END;
$$;
RESET ROLE;
SQL

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 -At <<'SQL' | grep -qx 'gig_vehicle_rental_operations_security=PASS'
SELECT 'gig_vehicle_rental_operations_security=PASS';
SQL
echo "gig_vehicle_rental_operations=PASS database=${DB_NAME} features=locations,availability,add_ons,agreements,extensions"
