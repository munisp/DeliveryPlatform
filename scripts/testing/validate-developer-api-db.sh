#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_NAME="developer_api_validation_${$}_$(date +%s)"
ROLE_FIELD="field_service_api"
ROLE_API="developer_api_service"
ROLE_MANAGEMENT="developer_api_management"
ROLE_UNTRUSTED="developer_api_untrusted"
CREATED_ROLES=()

cleanup() {
  set +e
  sudo -u postgres dropdb --if-exists "$DB_NAME" >/dev/null 2>&1
  for role in "${CREATED_ROLES[@]:-}"; do sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${role}" >/dev/null 2>&1; done
}
trap cleanup EXIT

role_exists() { sudo -u postgres psql -X -At -d postgres -c "SELECT 1 FROM pg_roles WHERE rolname = '$1'" | grep -qx 1; }
role_safe() {
  sudo -u postgres psql -X -At -d postgres -c "SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid OR roleid = pg_roles.oid) FROM pg_roles WHERE rolname = '$1'" | grep -qx t
}
for role in "$ROLE_FIELD" "$ROLE_API" "$ROLE_MANAGEMENT" "$ROLE_UNTRUSTED"; do
  if role_exists "$role"; then role_safe "$role" || { echo "developer_api_result=FAIL reason=unsafe_existing_role role=$role" >&2; exit 1; }
  else sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS" >/dev/null; CREATED_ROLES+=("$role"); fi
done

sudo -u postgres createdb "$DB_NAME"
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION postgis;
CREATE EXTENSION pgcrypto;
CREATE TYPE public.user_role AS ENUM ('user', 'admin');
CREATE TYPE public.provider_status AS ENUM ('pending', 'active', 'suspended', 'rejected');
CREATE TABLE public.users (id serial PRIMARY KEY, open_id varchar(64) NOT NULL UNIQUE, name text, email varchar(320), role public.user_role NOT NULL DEFAULT 'user', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), last_signed_in timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.customers (id serial PRIMARY KEY, open_id varchar(64) NOT NULL UNIQUE, name varchar(255) NOT NULL, email varchar(320));
CREATE TABLE public.service_providers (id serial PRIMARY KEY, vertical_id integer NOT NULL DEFAULT 1, name varchar(255) NOT NULL, business_name varchar(255) NOT NULL, email varchar(320) NOT NULL, phone varchar(20) NOT NULL, status public.provider_status NOT NULL DEFAULT 'active');
CREATE TABLE public.orders (id serial PRIMARY KEY);
INSERT INTO public.users (id, open_id, name, role) VALUES (1,'api-admin','API Admin','admin'),(2,'api-customer','API Customer','user'),(3,'api-tech','API Tech','user');
INSERT INTO public.customers (id, open_id, name) VALUES (1,'api-customer','Customer');
INSERT INTO public.service_providers (id,name,business_name,email,phone,status) VALUES (1,'Provider','Provider Ltd','provider@example.test','+2348000000000','active'),(2,'Other Provider','Other Ltd','other@example.test','+2348000000001','active');
SQL
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$ROOT_DIR/drizzle/0044_field_service_operations.sql" >/dev/null
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$ROOT_DIR/drizzle/0045_developer_api_platform.sql" >/dev/null

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE field_service_api;
SELECT field_service.upsert_service_area(1,1,'api-lagos','API Lagos','{"type":"Polygon","coordinates":[[[3.3,6.4],[3.5,6.4],[3.5,6.6],[3.3,6.6],[3.3,6.4]]]}'::jsonb,'Africa/Lagos',true) AS area_id \gset
RESET ROLE;
SET ROLE developer_api_management;
SELECT developer.create_api_client(1,1,'External Partner') AS api_client_id \gset
SELECT developer.create_api_key(1, :'api_client_id'::uuid,'dpk_abcdef123456',public.digest('partner-test-secret','sha256'),ARRAY['field_service:read','field_service:write']::text[],clock_timestamp()+interval '1 day') AS api_key_id \gset
SELECT developer.create_webhook_endpoint(1, :'api_client_id'::uuid,'https://partner.example.test/hooks',ARRAY['field_service.work_order.created','field_service.work_order.completed']::text[],'secret/partner/webhook') AS endpoint_id \gset
RESET ROLE;
SET ROLE developer_api_service;
SELECT * FROM developer.authenticate_api_key('dpk_abcdef123456',public.digest('partner-test-secret','sha256'),'field_service:write') \gset
SELECT * FROM developer.begin_idempotent_request(:'api_key_id'::uuid,'api-create-0001',public.digest('{"title":"Inspect"}','sha256')) \gset
SELECT field_service.create_work_order(1,1,:'area_id'::uuid,'Inspect meter','Inspect customer meter.','1 Test Street, Lagos',6.5,3.4,'normal'::field_service.work_order_priority,NULL,NULL,NULL,:owner_user_id,'api-create-0001') AS work_order_id \gset
SELECT developer.complete_idempotent_request(:'api_key_id'::uuid,'api-create-0001',201::smallint,jsonb_build_object('id',:'work_order_id'::uuid,'status','requested'));
SELECT detail->>'state' AS public_state FROM (SELECT developer.public_field_service_work_order(:'api_client_id'::uuid, :'work_order_id'::uuid) AS detail) AS public_view;
SELECT developer.publish_field_service_outbox(10) AS published_count;
SELECT * FROM developer.claim_webhook_deliveries(10) \gset
SELECT developer.complete_webhook_delivery(:'delivery_id'::uuid,true,202,NULL) AS delivery_state;
RESET ROLE;
SQL

if sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null 2>&1
SET ROLE developer_api_untrusted;
SELECT developer.authenticate_api_key('dpk_abcdef123456',public.digest('partner-test-secret','sha256'),'field_service:read');
SQL
then echo "developer_api_result=FAIL reason=untrusted_execute_allowed" >&2; exit 1; fi
if sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null 2>&1
SET ROLE developer_api_service;
SELECT * FROM developer.api_key;
SQL
then echo "developer_api_result=FAIL reason=direct_key_read_allowed" >&2; exit 1; fi
if sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null 2>&1
UPDATE developer.webhook_delivery SET event_type = 'tampered';
SQL
then echo "developer_api_result=FAIL reason=immutable_delivery_mutation_allowed" >&2; exit 1; fi

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 -At <<'SQL' | grep -qx 'developer_api_security=PASS'
SELECT CASE WHEN
  NOT has_function_privilege('public','developer.authenticate_api_key(text,bytea,text,timestamp with time zone)','EXECUTE')
  AND (SELECT prosecdef FROM pg_proc WHERE oid = 'developer.authenticate_api_key(text,bytea,text,timestamp with time zone)'::regprocedure)
  AND (SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'developer.authenticate_api_key(text,bytea,text,timestamp with time zone)'::regprocedure) = 'search_path=pg_catalog, developer'
  AND (SELECT count(*) FROM developer.api_idempotency_record) = 1
  AND (SELECT count(*) FROM developer.webhook_endpoint) = 1
  AND (SELECT count(*) FROM developer.webhook_delivery WHERE state = 'delivered'::developer.webhook_delivery_state) = 1
THEN 'developer_api_security=PASS' ELSE 'developer_api_security=FAIL' END;
SQL

echo "developer_api_result=PASS database=${DB_NAME}"
