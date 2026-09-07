#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_NAME="medusa_commerce_validation_${$}_$(date +%s)"
ROLES=(commerce_gateway_service commerce_operator_service commerce_untrusted)
CREATED=()
cleanup(){ set +e; sudo -u postgres dropdb --if-exists "$DB_NAME" >/dev/null 2>&1; for r in "${CREATED[@]:-}"; do sudo -u postgres psql -X -d postgres -c "DROP ROLE IF EXISTS $r" >/dev/null 2>&1; done; }
trap cleanup EXIT
safe_role(){ sudo -u postgres psql -XAt -d postgres -c "SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid OR roleid=pg_roles.oid) FROM pg_roles WHERE rolname='$1'" | grep -qx t; }
for r in "${ROLES[@]}"; do if sudo -u postgres psql -XAt -d postgres -c "SELECT 1 FROM pg_roles WHERE rolname='$r'" | grep -qx 1; then safe_role "$r" || { echo "medusa_commerce_result=FAIL reason=unsafe_existing_role role=$r" >&2; exit 1; }; else sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE $r NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS" >/dev/null; CREATED+=("$r"); fi; done
sudo -u postgres createdb "$DB_NAME"
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION pgcrypto;
CREATE TYPE public.user_role AS ENUM ('user','admin');
CREATE TYPE public.provider_status AS ENUM ('pending','active','suspended','rejected');
CREATE TABLE public.users(id serial PRIMARY KEY,open_id varchar(64) UNIQUE NOT NULL,name text,email varchar(320),role public.user_role NOT NULL DEFAULT 'user',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),last_signed_in timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.service_providers(id serial PRIMARY KEY,vertical_id integer NOT NULL DEFAULT 1,name varchar(255) NOT NULL,business_name varchar(255) NOT NULL,email varchar(320) NOT NULL,phone varchar(20) NOT NULL,status public.provider_status NOT NULL DEFAULT 'active');
CREATE TABLE public.orders(id serial PRIMARY KEY);
INSERT INTO public.users(id,open_id,name,role) VALUES(1,'commerce-admin','Commerce Admin','admin');
INSERT INTO public.service_providers(id,name,business_name,email,phone,status) VALUES(1,'Retailer','Retailer Ltd','retailer@example.test','+2348000000000','active');
SQL
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$ROOT_DIR/drizzle/0046_medusa_commerce_fulfillment.sql" >/dev/null
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE commerce_operator_service;
SELECT commerce.upsert_medusa_store_connection(1,1,'retailer-store-001','https://medusa.retailer.example.test','secret/retailer/medusa',true);
RESET ROLE;
SET ROLE commerce_gateway_service;
SELECT commerce.ingest_medusa_event_for_store('retailer-store-001','evt_medusa_0001','commerce.order.placed',jsonb_build_object('order_id','order_0001','data',jsonb_build_object('id','order_0001')),public.digest('{"order_id":"order_0001","data":{"id":"order_0001"}}','sha256')) AS event_id \gset
SELECT commerce.ingest_medusa_event_for_store('retailer-store-001','evt_medusa_0001','commerce.order.placed',jsonb_build_object('order_id','order_0001','data',jsonb_build_object('id','order_0001')),public.digest('{"order_id":"order_0001","data":{"id":"order_0001"}}','sha256')) AS repeated_event_id \gset
SELECT CASE WHEN :'event_id' = :'repeated_event_id' THEN 'ingest_idempotency=PASS' ELSE 'ingest_idempotency=FAIL' END;
RESET ROLE;
SELECT id AS fulfillment_id FROM commerce.fulfillment_request WHERE medusa_order_id='order_0001' \gset
SET ROLE commerce_operator_service;
SELECT commerce.transition_fulfillment(:'fulfillment_id'::uuid,1,'accept','{}'::jsonb,'commerce-accept-0001');
SELECT commerce.transition_fulfillment(:'fulfillment_id'::uuid,1,'assign',jsonb_build_object('delivery_reference','DEL-001'),'commerce-assign-0001');
SELECT commerce.transition_fulfillment(:'fulfillment_id'::uuid,1,'dispatch','{}'::jsonb,'commerce-dispatch-0001');
SELECT commerce.transition_fulfillment(:'fulfillment_id'::uuid,1,'deliver',jsonb_build_object('proof_reference','proof/001'),'commerce-deliver-0001');
RESET ROLE;
SQL
summary="$(sudo -u postgres psql -XAt -d "$DB_NAME" -c "SELECT (SELECT state::text FROM commerce.fulfillment_request)||'|'||(SELECT count(*) FROM commerce.fulfillment_event)||'|'||(SELECT state::text FROM commerce.medusa_event)")"
printf 'medusa_commerce_lifecycle=%s\n' "$summary"
[ "$summary" = 'delivered|5|fulfillment_requested' ]
if sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null 2>&1
SET ROLE commerce_untrusted; SELECT commerce.ingest_medusa_event(1,'evt_untrusted_0001','commerce.order.placed','{}'::jsonb,public.digest('{}','sha256'));
SQL
then echo 'medusa_commerce_result=FAIL reason=untrusted_execute_allowed' >&2; exit 1; fi
if sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null 2>&1
SET ROLE commerce_gateway_service; SELECT * FROM commerce.medusa_event;
SQL
then echo 'medusa_commerce_result=FAIL reason=direct_event_read_allowed' >&2; exit 1; fi
if sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null 2>&1
UPDATE commerce.fulfillment_event SET event_type='tampered';
SQL
then echo 'medusa_commerce_result=FAIL reason=append_only_mutation_allowed' >&2; exit 1; fi
sudo -u postgres psql -XAt -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' | grep -qx 'medusa_commerce_security=PASS'
SELECT CASE WHEN NOT has_function_privilege('public','commerce.ingest_medusa_event_for_store(text,text,text,jsonb,bytea,timestamp with time zone)','EXECUTE') AND (SELECT prosecdef FROM pg_proc WHERE oid='commerce.ingest_medusa_event_for_store(text,text,text,jsonb,bytea,timestamp with time zone)'::regprocedure) AND (SELECT array_to_string(proconfig,',') FROM pg_proc WHERE oid='commerce.ingest_medusa_event_for_store(text,text,text,jsonb,bytea,timestamp with time zone)'::regprocedure)='search_path=pg_catalog, commerce' THEN 'medusa_commerce_security=PASS' ELSE 'medusa_commerce_security=FAIL' END;
SQL
echo "medusa_commerce_result=PASS database=$DB_NAME"
