#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_NAME="medusa_inventory_bridge_validation_${$}_$(date +%s)"
ROLES=(commerce_gateway_service commerce_operator_service commerce_untrusted)
CREATED_ROLES=()

cleanup() {
  set +e
  sudo -u postgres dropdb --if-exists "$DB_NAME" >/dev/null 2>&1
  for role in "${CREATED_ROLES[@]:-}"; do
    sudo -u postgres psql -X -d postgres -c "DROP ROLE IF EXISTS ${role}" >/dev/null 2>&1
  done
}
trap cleanup EXIT

safe_role() {
  sudo -u postgres psql -XAt -d postgres -c "
    SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb
       AND NOT rolreplication AND NOT rolbypassrls
       AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid OR roleid = pg_roles.oid)
    FROM pg_roles WHERE rolname = '${1}'" | grep -qx t
}

for role in "${ROLES[@]}"; do
  if sudo -u postgres psql -XAt -d postgres -c "SELECT 1 FROM pg_roles WHERE rolname = '${role}'" | grep -qx 1; then
    safe_role "$role" || {
      echo "medusa_inventory_bridge_result=FAIL reason=unsafe_existing_role role=${role}" >&2
      exit 1
    }
  else
    sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS" >/dev/null
    CREATED_ROLES+=("$role")
  fi
done

sudo -u postgres createdb "$DB_NAME"
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION pgcrypto;
CREATE TYPE public.user_role AS ENUM ('user', 'admin');
CREATE TYPE public.provider_status AS ENUM ('pending', 'active', 'suspended', 'rejected');
CREATE TABLE public.users(
  id serial PRIMARY KEY,
  open_id varchar(64) UNIQUE NOT NULL,
  name text,
  email varchar(320),
  role public.user_role NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_signed_in timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.service_providers(
  id serial PRIMARY KEY,
  vertical_id integer NOT NULL DEFAULT 1,
  name varchar(255) NOT NULL,
  business_name varchar(255) NOT NULL,
  email varchar(320) NOT NULL,
  phone varchar(20) NOT NULL,
  status public.provider_status NOT NULL DEFAULT 'active'
);
CREATE TABLE public.orders(id serial PRIMARY KEY);
INSERT INTO public.users(id, open_id, name, role) VALUES (1, 'inventory-admin', 'Inventory Admin', 'admin');
INSERT INTO public.service_providers(id, name, business_name, email, phone, status)
VALUES (1, 'Retailer', 'Retailer Ltd', 'retailer@example.test', '+2348000000000', 'active');
SQL

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$ROOT_DIR/drizzle/0046_medusa_commerce_fulfillment.sql" >/dev/null
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$ROOT_DIR/drizzle/0057_medusa_inventory_reservation_bridge.sql" >/dev/null

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE commerce_operator_service;
SELECT commerce.upsert_medusa_store_connection(1, 1, 'retailer-store-001', 'https://medusa.retailer.example.test', 'secret/retailer/medusa', true);
SELECT commerce.upsert_medusa_inventory_binding(1, 1, 'sloc_warehouse_001', 'iitem_milk_001', 701, 'milk-1l', true) AS binding_id \gset
RESET ROLE;

SET ROLE commerce_gateway_service;
SELECT applied::text || '|' || on_hand_units::text || '|' || reserved_units::text || '|' || inbound_units::text || '|' || available_units::text AS level_initial
FROM commerce.ingest_medusa_inventory_level_snapshot_for_store(
  'retailer-store-001', 'evt_level_00000001', 'ilevel_milk_001', 'sloc_warehouse_001', 'iitem_milk_001',
  10.000000, 0.000000, 5.000000, '2026-09-08T10:00:00Z',
  public.digest('level-1', 'sha256')
) \gset
SELECT :'level_initial' AS level_initial;

SELECT applied::text || '|' || on_hand_units::text || '|' || reserved_units::text || '|' || inbound_units::text || '|' || available_units::text AS reservation_active
FROM commerce.ingest_medusa_inventory_reservation_snapshot_for_store(
  'retailer-store-001', 'evt_reservation_0001', 'res_milk_001', 'sloc_warehouse_001', 'iitem_milk_001', 'order_milk_001',
  3.000000, 'active', '2026-09-08T10:01:00Z', public.digest('reservation-1', 'sha256')
) \gset
SELECT :'reservation_active' AS reservation_active;

SELECT applied::text || '|' || reserved_units::text || '|' || available_units::text AS reservation_duplicate
FROM commerce.ingest_medusa_inventory_reservation_snapshot_for_store(
  'retailer-store-001', 'evt_reservation_0001', 'res_milk_001', 'sloc_warehouse_001', 'iitem_milk_001', 'order_milk_001',
  3.000000, 'active', '2026-09-08T10:01:00Z', public.digest('reservation-1', 'sha256')
) \gset
SELECT :'reservation_duplicate' AS reservation_duplicate;

SELECT applied::text || '|' || reserved_units::text || '|' || available_units::text AS level_reconciled
FROM commerce.ingest_medusa_inventory_level_snapshot_for_store(
  'retailer-store-001', 'evt_level_00000002', 'ilevel_milk_001', 'sloc_warehouse_001', 'iitem_milk_001',
  10.000000, 3.000000, 5.000000, '2026-09-08T10:02:00Z',
  public.digest('level-2', 'sha256')
) \gset
SELECT :'level_reconciled' AS level_reconciled;
RESET ROLE;
SET ROLE commerce_operator_service;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM commerce.list_medusa_inventory_reconciliation(1, 1, 10)
    WHERE warehouse_id = 701
      AND sku = 'milk-1l'
      AND reservation_reconciled
  ) THEN
    RAISE EXCEPTION 'reservation projection does not reconcile to Medusa reported quantity';
  END IF;
END;
$$;
SELECT 'reservation_reconciliation_before_release=PASS';
RESET ROLE;
SET ROLE commerce_gateway_service;

SELECT applied::text || '|' || reserved_units::text || '|' || available_units::text AS reservation_released
FROM commerce.ingest_medusa_inventory_reservation_snapshot_for_store(
  'retailer-store-001', 'evt_reservation_0002', 'res_milk_001', 'sloc_warehouse_001', 'iitem_milk_001', 'order_milk_001',
  3.000000, 'released', '2026-09-08T10:03:00Z', public.digest('reservation-2', 'sha256')
) \gset
SELECT :'reservation_released' AS reservation_released;

SELECT applied::text || '|' || reserved_units::text || '|' || available_units::text AS reservation_stale
FROM commerce.ingest_medusa_inventory_reservation_snapshot_for_store(
  'retailer-store-001', 'evt_reservation_0003', 'res_milk_001', 'sloc_warehouse_001', 'iitem_milk_001', 'order_milk_001',
  3.000000, 'active', '2026-09-08T10:01:00Z', public.digest('reservation-stale', 'sha256')
) \gset
SELECT :'reservation_stale' AS reservation_stale;
RESET ROLE;
SQL

summary="$(sudo -u postgres psql -XAt -d "$DB_NAME" -c "
  SELECT (SELECT on_hand_units::text || '|' || reserved_units::text || '|' || inbound_units::text || '|' || GREATEST(on_hand_units-reserved_units,0)::text FROM public.inventory_positions WHERE warehouse_id=701 AND sku='milk-1l')
       || '|' || (SELECT reservation_reconciled::text FROM commerce.medusa_inventory_reconciliation WHERE provider_id=1 AND warehouse_id=701 AND sku='milk-1l')
       || '|' || (SELECT count(*)::text FROM commerce.medusa_inventory_reservation_event)")"
printf 'medusa_inventory_bridge_summary=%s\n' "$summary"
[ "$summary" = '10.000000|0.000000|5.000000|10.000000|false|2' ]

if sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null 2>&1
SET ROLE commerce_gateway_service;
UPDATE public.inventory_positions SET reserved_units = 9 WHERE warehouse_id = 701 AND sku = 'milk-1l';
SQL
then
  echo 'medusa_inventory_bridge_result=FAIL reason=direct_reservation_projection_update_allowed' >&2
  exit 1
fi

if sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null 2>&1
UPDATE commerce.medusa_inventory_reservation_event SET next_state = 'active';
SQL
then
  echo 'medusa_inventory_bridge_result=FAIL reason=reservation_evidence_mutation_allowed' >&2
  exit 1
fi

if sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null 2>&1
SET ROLE commerce_untrusted;
SELECT commerce.ingest_medusa_inventory_level_snapshot_for_store('retailer-store-001', 'evt_untrusted_0001', 'ilevel_milk_001', 'sloc_warehouse_001', 'iitem_milk_001', 1, 0, 0, now(), public.digest('x', 'sha256'));
SQL
then
  echo 'medusa_inventory_bridge_result=FAIL reason=untrusted_gateway_execute_allowed' >&2
  exit 1
fi

sudo -u postgres psql -XAt -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' | grep -qx 'medusa_inventory_bridge_security=PASS'
SELECT CASE
  WHEN NOT has_table_privilege('commerce_gateway_service', 'public.inventory_positions', 'UPDATE')
   AND NOT has_table_privilege('commerce_gateway_service', 'commerce.medusa_inventory_reservation', 'SELECT')
   AND NOT has_function_privilege('public', 'commerce.ingest_medusa_inventory_reservation_snapshot_for_store(text,text,text,text,text,text,numeric,text,timestamp with time zone,bytea,timestamp with time zone)', 'EXECUTE')
   AND (SELECT prosecdef FROM pg_proc WHERE oid='commerce.ingest_medusa_inventory_reservation_snapshot_for_store(text,text,text,text,text,text,numeric,text,timestamp with time zone,bytea,timestamp with time zone)'::regprocedure)
   AND (SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid='commerce.ingest_medusa_inventory_reservation_snapshot_for_store(text,text,text,text,text,text,numeric,text,timestamp with time zone,bytea,timestamp with time zone)'::regprocedure)='search_path=pg_catalog, commerce'
  THEN 'medusa_inventory_bridge_security=PASS'
  ELSE 'medusa_inventory_bridge_security=FAIL'
END;
SQL

echo "medusa_inventory_bridge_result=PASS database=$DB_NAME"
