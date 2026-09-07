#!/usr/bin/env bash
set -euo pipefail

# Validates migration 0044 against a disposable local PostgreSQL/PostGIS database only.
# It does not use shared, staging, or production databases.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATION="$ROOT_DIR/drizzle/0044_field_service_operations.sql"
EXTENSION_MIGRATION="$ROOT_DIR/drizzle/0047_field_service_proof_and_public_collection.sql"
RUN_ID="${FIELD_SERVICE_TEST_RUN_ID:-fs_${$}_$(date +%s)}"
DB_NAME="field_service_validation_${RUN_ID//[^a-zA-Z0-9_]/_}"
ROLE_API="field_service_api"
ROLE_UNTRUSTED="field_service_untrusted"
CREATED_API_ROLE=0
CREATED_UNTRUSTED_ROLE=0

cleanup() {
  set +e
  sudo -u postgres dropdb --if-exists "$DB_NAME" >/dev/null 2>&1
  if [ "$CREATED_API_ROLE" -eq 1 ]; then sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${ROLE_API}" >/dev/null 2>&1; fi
  if [ "$CREATED_UNTRUSTED_ROLE" -eq 1 ]; then sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${ROLE_UNTRUSTED}" >/dev/null 2>&1; fi
}
trap cleanup EXIT

if [ ! -f "$MIGRATION" ]; then
  echo "field_service_result=FAIL reason=migration_not_found" >&2
  exit 1
fi

role_exists() {
  sudo -u postgres psql -X -At -d postgres -v ON_ERROR_STOP=1 -c "SELECT 1 FROM pg_roles WHERE rolname = '$1'" | grep -qx 1
}
role_safe() {
  local role="$1"
  sudo -u postgres psql -X -At -d postgres -v ON_ERROR_STOP=1 -c "
    SELECT (NOT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid OR roleid = pg_roles.oid))
    FROM pg_roles WHERE rolname = '$role'
  " | grep -qx t
}

for role in "$ROLE_API" "$ROLE_UNTRUSTED"; do
  if role_exists "$role"; then
    if ! role_safe "$role"; then
      echo "field_service_result=FAIL reason=unsafe_existing_role role=$role" >&2
      exit 1
    fi
  else
    sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS" >/dev/null
    if [ "$role" = "$ROLE_API" ]; then CREATED_API_ROLE=1; else CREATED_UNTRUSTED_ROLE=1; fi
  fi
done

sudo -u postgres createdb "$DB_NAME"
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION postgis;
CREATE EXTENSION pgcrypto;
CREATE TYPE public.user_role AS ENUM ('user', 'admin');
CREATE TYPE public.provider_status AS ENUM ('pending', 'active', 'suspended', 'rejected');
CREATE TABLE public.users (
  id serial PRIMARY KEY,
  open_id varchar(64) NOT NULL UNIQUE,
  name text,
  email varchar(320),
  role public.user_role NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_signed_in timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.customers (
  id serial PRIMARY KEY,
  open_id varchar(64) NOT NULL UNIQUE,
  name varchar(255) NOT NULL,
  email varchar(320)
);
CREATE TABLE public.service_providers (
  id serial PRIMARY KEY,
  vertical_id integer NOT NULL DEFAULT 1,
  name varchar(255) NOT NULL,
  business_name varchar(255) NOT NULL,
  email varchar(320) NOT NULL,
  phone varchar(20) NOT NULL,
  status public.provider_status NOT NULL DEFAULT 'active'
);
CREATE TABLE public.orders (id serial PRIMARY KEY);
CREATE SCHEMA developer;
CREATE TABLE developer.api_client (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_id integer NOT NULL, state text NOT NULL DEFAULT 'active');
INSERT INTO public.users (id, open_id, name, role) VALUES
  (1, 'field-admin', 'Field Admin', 'admin'),
  (2, 'field-tech', 'Field Tech', 'user'),
  (3, 'field-other', 'Other Tech', 'user'),
  (4, 'field-customer-user', 'Customer User', 'user');
INSERT INTO public.customers (id, open_id, name) VALUES (1, 'field-customer', 'Customer');
INSERT INTO public.service_providers (id, name, business_name, email, phone, status) VALUES (1, 'Provider', 'Provider Ltd', 'provider@example.test', '+2348000000000', 'active');
SQL

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$MIGRATION" >/dev/null
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$EXTENSION_MIGRATION" >/dev/null

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE field_service_api;
SELECT field_service.upsert_service_area(
  1, 1, 'lagos-island', 'Lagos Island',
  '{"type":"Polygon","coordinates":[[[3.30,6.40],[3.50,6.40],[3.50,6.60],[3.30,6.60],[3.30,6.40]]]}'::jsonb,
  'Africa/Lagos', true
) AS service_area_id \gset
SELECT field_service.upsert_technician(1, 2, 1, 'Field Tech', 'TECH-001', '["electrical","inspection"]'::jsonb, 'active'::field_service.technician_state);
SELECT field_service.set_technician_service_area(1, 2, :'service_area_id'::uuid, true);
SELECT field_service.create_work_order(
  1, 1, :'service_area_id'::uuid, 'Inspect breaker', 'Inspect and repair circuit breaker.', '1 Test Street, Lagos',
  6.5, 3.4, 'high'::field_service.work_order_priority,
  clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', NULL, 1, 'fs-create-0001'
) AS work_order_id \gset
SELECT field_service.create_work_order(
  1, 1, :'service_area_id'::uuid, 'Inspect breaker', 'Inspect and repair circuit breaker.', '1 Test Street, Lagos',
  6.5, 3.4, 'high'::field_service.work_order_priority,
  clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', NULL, 1, 'fs-create-0001'
) AS repeated_work_order_id \gset
SELECT CASE WHEN :'work_order_id' = :'repeated_work_order_id' THEN 'idempotent_create=PASS' ELSE 'idempotent_create=FAIL' END;
SELECT field_service.schedule_work_order(:'work_order_id'::uuid, 1, clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'fs-schedule-0001');
SELECT field_service.assign_work_order(:'work_order_id'::uuid, 1, 2, 'fs-assign-0001');
SELECT field_service.advance_work_order(:'work_order_id'::uuid, 2, 'depart', 'leaving depot', 'fs-depart-0001');
SELECT field_service.advance_work_order(:'work_order_id'::uuid, 2, 'arrive', 'arrived at site', 'fs-arrive-0001');
SELECT field_service.record_work_order_proof(:'work_order_id'::uuid,2,'arrival','field-service/arrival-001.jpg','image/jpeg',repeat('b',64),'fs-arrival-proof-0001') AS arrival_proof_id \gset
SELECT field_service.record_work_order_proof(:'work_order_id'::uuid,2,'arrival','field-service/arrival-001.jpg','image/jpeg',repeat('b',64),'fs-arrival-proof-0001') AS repeated_arrival_proof_id \gset
SELECT field_service.record_work_order_proof(:'work_order_id'::uuid,2,'customer_signature','field-service/signature-001.png','image/png',repeat('c',64),'fs-signature-proof-0001') AS signature_proof_id \gset
SELECT CASE WHEN :'arrival_proof_id' = :'repeated_arrival_proof_id' THEN 'idempotent_proof=PASS' ELSE 'idempotent_proof=FAIL' END;
SELECT field_service.complete_work_order(:'work_order_id'::uuid, 2, 'Breaker inspected and repaired.', 'field-service/proof-001.jpg', 'image/jpeg', repeat('a', 64), 'fs-complete-0001');
SELECT field_service.complete_work_order(:'work_order_id'::uuid, 2, 'Breaker inspected and repaired.', 'field-service/proof-001.jpg', 'image/jpeg', repeat('a', 64), 'fs-complete-0001') AS idempotent_complete;
RESET ROLE;
SQL

lifecycle_summary="$(sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 -At <<'SQL'
SELECT concat_ws('|',
  (SELECT state::text FROM field_service.work_order LIMIT 1),
  (SELECT count(*)::text FROM field_service.work_order_event),
  (SELECT count(*)::text FROM field_service.work_order_proof),
  (SELECT count(*)::text FROM field_service.outbox_event)
);
SQL
)"
printf 'field_service_lifecycle=%s\n' "$lifecycle_summary"
[ "$lifecycle_summary" = 'completed|8|3|8' ]

if sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null 2>&1
SET ROLE field_service_api;
INSERT INTO field_service.work_order_event (work_order_id, sequence_no, next_state, idempotency_key)
SELECT id, 999, 'completed'::field_service.work_order_state, 'direct-write-0001' FROM field_service.work_order LIMIT 1;
SQL
then
  echo "field_service_result=FAIL reason=direct_write_was_allowed" >&2
  exit 1
fi

if sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null 2>&1
SET ROLE field_service_untrusted;
SELECT field_service.schedule_work_order(id, 1, clock_timestamp() + interval '3 hours', clock_timestamp() + interval '4 hours', 'untrusted-0001') FROM field_service.work_order LIMIT 1;
SQL
then
  echo "field_service_result=FAIL reason=untrusted_execute_was_allowed" >&2
  exit 1
fi

if sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null 2>&1
UPDATE field_service.work_order_event SET event_type = 'tampered' WHERE true;
SQL
then
  echo "field_service_result=FAIL reason=append_only_mutation_was_allowed" >&2
  exit 1
fi

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 -At <<'SQL' | grep -qx 'field_service_security=PASS'
SELECT CASE WHEN
  NOT has_function_privilege('public', 'field_service.record_work_order_proof(uuid,integer,text,text,text,text,text,timestamp with time zone)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'field_service.create_work_order(integer,integer,uuid,text,text,text,numeric,numeric,field_service.work_order_priority,timestamp with time zone,timestamp with time zone,integer,integer,text,timestamp with time zone)', 'EXECUTE')
  AND (SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'field_service.create_work_order(integer,integer,uuid,text,text,text,numeric,numeric,field_service.work_order_priority,timestamp with time zone,timestamp with time zone,integer,integer,text,timestamp with time zone)'::regprocedure) = 'search_path=pg_catalog, field_service'
  AND (SELECT prosecdef FROM pg_proc WHERE oid = 'field_service.create_work_order(integer,integer,uuid,text,text,text,numeric,numeric,field_service.work_order_priority,timestamp with time zone,timestamp with time zone,integer,integer,text,timestamp with time zone)'::regprocedure)
THEN 'field_service_security=PASS' ELSE 'field_service_security=FAIL' END;
SQL

echo "field_service_result=PASS database=${DB_NAME}"
