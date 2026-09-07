#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_NAME="vehicle_access_validation_${$}_$(date +%s)"
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
    role_safe "$role" || { echo "vehicle_access_result=FAIL reason=unsafe_existing_role role=$role" >&2; exit 1; }
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
  (1,'vehicle-admin','Vehicle Admin','admin'),
  (2,'vehicle-worker','Vehicle Worker','user'),
  (3,'vehicle-other','Vehicle Other','user');
SQL
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$ROOT_DIR/drizzle/0050_gig_worker_vehicle_access.sql" >/dev/null

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE vehicle_access_service;
SELECT vehicle_access.create_provider(1,'Starter Fleet','Starter Fleet Limited',timestamptz '2026-09-07 08:00:00+00') AS provider_id \gset
SELECT vehicle_access.register_asset(1, :'provider_id'::uuid,'LAG-ABC-001',encode(public.digest('1HGBH41JXMN109186','sha256'),'hex'),'Toyota','Corolla',2018,85400,4::smallint,'["ride_hailing","delivery"]'::jsonb,timestamptz '2026-09-07 08:01:00+00') AS asset_id \gset
SELECT vehicle_access.record_asset_evidence(1, :'asset_id'::uuid, evidence_kind, 'vehicle/evidence/' || evidence_kind || '.pdf', encode(public.digest(evidence_kind,'sha256'),'hex'),timestamptz '2027-09-07 00:00:00+00','asset-evidence-' || evidence_kind,timestamptz '2026-09-07 08:02:00+00')
FROM unnest(ARRAY['registration','roadworthiness','commercial_cover','ownership_authority','inspection']) AS evidence_kind;
SELECT vehicle_access.activate_asset(1, :'asset_id'::uuid,'asset-activate-0001',timestamptz '2026-09-07 08:03:00+00') AS asset_state;
SELECT vehicle_access.create_offer(1, :'provider_id'::uuid, :'asset_id'::uuid,'NGN'::char(3),650000::bigint,100000::bigint,1200,150::bigint,7::smallint,timestamptz '2026-09-07 08:04:00+00') AS offer_id \gset
SELECT count(*) AS discoverable_offer_count FROM vehicle_access.list_active_offers(10);
DO $$
BEGIN
  BEGIN
    PERFORM vehicle_access.request_contract(3,(SELECT id FROM vehicle_access.list_active_offers(1) LIMIT 1),timestamptz '2026-09-08 08:00:00+00',timestamptz '2026-09-22 08:00:00+00','unverified-worker-0001',timestamptz '2026-09-07 08:04:15+00');
    RAISE EXCEPTION 'unverified worker contract request unexpectedly allowed';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
END;
$$;
SELECT vehicle_access.upsert_worker_eligibility(1,2,'["ride_hailing","delivery"]'::jsonb,timestamptz '2027-09-07 00:00:00+00',timestamptz '2026-09-07 08:04:30+00') AS worker_eligibility_state;
SELECT vehicle_access.request_contract(2, :'offer_id'::uuid,timestamptz '2026-09-08 08:00:00+00',timestamptz '2026-09-22 08:00:00+00','contract-request-0001',timestamptz '2026-09-07 08:05:00+00') AS contract_id \gset
SELECT vehicle_access.transition_contract(1, :'contract_id'::uuid,'approve',NULL,'contract-approve-0001',timestamptz '2026-09-07 08:06:00+00') AS approved_state;
SELECT vehicle_access.record_inspection(2, :'contract_id'::uuid,'handover','vehicle/contracts/handover.jpg','image/jpeg',encode(public.digest('handover-photo','sha256'),'hex'),85400,'handover-proof-0001',timestamptz '2026-09-08 08:00:00+00') AS handover_evidence_id;
SELECT vehicle_access.transition_contract(1, :'contract_id'::uuid,'handover',NULL,'contract-handover-0001',timestamptz '2026-09-08 08:01:00+00') AS active_state;
SELECT vehicle_access.transition_contract(2, :'contract_id'::uuid,'begin_return',NULL,'contract-return-0001',timestamptz '2026-09-21 09:00:00+00') AS return_pending_state;
SELECT vehicle_access.record_inspection(2, :'contract_id'::uuid,'return','vehicle/contracts/return.jpg','image/jpeg',encode(public.digest('return-photo','sha256'),'hex'),85950,'return-proof-0001',timestamptz '2026-09-22 08:00:00+00') AS return_evidence_id;
SELECT vehicle_access.transition_contract(1, :'contract_id'::uuid,'close',NULL,'contract-close-0001',timestamptz '2026-09-22 08:05:00+00') AS closed_state;
RESET ROLE;
SELECT state AS final_contract_state FROM vehicle_access.access_contract WHERE id=:'contract_id'::uuid;
SELECT state AS final_asset_state FROM vehicle_access.vehicle_asset WHERE id=:'asset_id'::uuid;
SELECT count(*) AS immutable_event_count FROM vehicle_access.contract_event WHERE contract_id=:'contract_id'::uuid;
SELECT count(*) AS outbox_count FROM vehicle_access.outbox_event WHERE aggregate_id=:'contract_id'::uuid;
RESET ROLE;
SQL

if sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null 2>&1
SET ROLE vehicle_access_service;
SELECT vehicle_access.transition_contract(2, (SELECT id FROM vehicle_access.access_contract LIMIT 1),'approve',NULL,'worker-approve-0001');
SQL
then echo "vehicle_access_result=FAIL reason=worker_approval_allowed" >&2; exit 1; fi
if sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null 2>&1
SET ROLE vehicle_access_untrusted;
SELECT * FROM vehicle_access.access_contract;
SQL
then echo "vehicle_access_result=FAIL reason=untrusted_direct_contract_read_allowed" >&2; exit 1; fi
if sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null 2>&1
UPDATE vehicle_access.inspection_evidence SET odometer_km=1;
SQL
then echo "vehicle_access_result=FAIL reason=immutable_inspection_mutation_allowed" >&2; exit 1; fi
if sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null 2>&1
UPDATE vehicle_access.contract_event SET event_type='tampered';
SQL
then echo "vehicle_access_result=FAIL reason=immutable_event_mutation_allowed" >&2; exit 1; fi

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 -At <<'SQL' | grep -qx 'vehicle_access_security=PASS'
SELECT 'vehicle_access_security=PASS';
SQL
echo "vehicle_access_result=PASS database=${DB_NAME} lifecycle=requested-approved-active-return_pending-closed"
