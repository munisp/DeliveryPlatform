#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATABASE="operations_schema_test"
ROLE="operations_schema_test"
PASSWORD="operations-schema-test-password"
MIGRATION="$ROOT/drizzle/0028_logistics_operations.sql"
TEMP_MIGRATION="/tmp/logistics_operations_schema_test.sql"

cleanup() {
  sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE}' AND pid <> pg_backend_pid();" >/dev/null || true
  sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${DATABASE};" >/dev/null || true
  sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${ROLE};" >/dev/null || true
  rm -f "$TEMP_MIGRATION"
}
trap cleanup EXIT

cleanup
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}';"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DATABASE} OWNER ${ROLE};"
cp "$MIGRATION" "$TEMP_MIGRATION"
chmod 0644 "$TEMP_MIGRATION"

sudo -u postgres psql -d "$DATABASE" -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE public.users (id serial PRIMARY KEY, open_id varchar(64) NOT NULL UNIQUE);
\i /tmp/logistics_operations_schema_test.sql
INSERT INTO public.users (id, open_id) VALUES (99101, 'operations-owner'), (99102, 'operations-driver');
INSERT INTO operations.service_zone (id, tenant_id, code, display_name, boundary, created_by)
VALUES ('30000000-0000-0000-0000-000000000001', 'tenant-lagos-beta', 'IKOYI-A', 'Ikoyi A',
  ST_Multi(ST_GeomFromText('POLYGON((3.372 6.442,3.420 6.442,3.420 6.490,3.372 6.490,3.372 6.442))',4326))::geography, 99101);
INSERT INTO operations.workflow_definition (id, tenant_id, code, display_name, transitions, created_by)
VALUES ('30000000-0000-0000-0000-000000000002', 'tenant-lagos-beta', 'DELIVERY-V1', 'Delivery v1',
  '{"draft":["queued","cancelled"],"queued":["allocated"]}', 99101);
INSERT INTO operations.work_order (id, tenant_id, external_reference, title, state, service_zone_id, workflow_id, assignee_user_id, created_by)
VALUES ('30000000-0000-0000-0000-000000000003', 'tenant-lagos-beta', 'OPS-E2E-1', 'Collect documents', 'draft',
 '30000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 99102, 99101);
INSERT INTO operations.work_order_stop (work_order_id, sequence_no, stop_kind, display_name, address_text, location)
VALUES ('30000000-0000-0000-0000-000000000003', 1, 'pickup', 'Pickup', 'Ikoyi', ST_SetSRID(ST_MakePoint(3.38,6.46),4326)::geography),
       ('30000000-0000-0000-0000-000000000003', 2, 'dropoff', 'Dropoff', 'Victoria Island', ST_SetSRID(ST_MakePoint(3.40,6.47),4326)::geography);
INSERT INTO operations.work_order_event (work_order_id, sequence_no, event_type, next_state, actor_user_id, idempotency_key, payload)
VALUES ('30000000-0000-0000-0000-000000000003', 1, 'work_order_created', 'draft', 99101, 'create:OPS-E2E-1', '{"stopCount":2}');
INSERT INTO operations.tracking_position (tenant_id, work_order_id, subject_user_id, observed_at, point, source)
VALUES ('tenant-lagos-beta','30000000-0000-0000-0000-000000000003',99102,NOW(),ST_SetSRID(ST_MakePoint(3.381,6.461),4326)::geography,'driver_app');
INSERT INTO operations.webhook_subscription (id, tenant_id, display_name, endpoint_url, secret_ref, event_types, created_by)
VALUES ('30000000-0000-0000-0000-000000000004','tenant-lagos-beta','Partner Webhook','https://partner.example.com/events','operations_partner_v1',ARRAY['work_order_created'],99101);
INSERT INTO operations.webhook_delivery (subscription_id,event_id,event_type,payload)
SELECT '30000000-0000-0000-0000-000000000004', id, event_type, '{"workOrderId":"30000000-0000-0000-0000-000000000003"}'::jsonb
FROM operations.work_order_event WHERE idempotency_key='create:OPS-E2E-1';
DO $$
DECLARE count_zones integer; count_orders integer; count_stops integer; count_events integer; count_positions integer; count_deliveries integer;
BEGIN
  SELECT COUNT(*) INTO count_zones FROM operations.service_zone WHERE tenant_id='tenant-lagos-beta';
  SELECT COUNT(*) INTO count_orders FROM operations.work_order WHERE tenant_id='tenant-lagos-beta' AND state='draft';
  SELECT COUNT(*) INTO count_stops FROM operations.work_order_stop WHERE work_order_id='30000000-0000-0000-0000-000000000003';
  SELECT COUNT(*) INTO count_events FROM operations.work_order_event WHERE work_order_id='30000000-0000-0000-0000-000000000003';
  SELECT COUNT(*) INTO count_positions FROM operations.tracking_position WHERE work_order_id='30000000-0000-0000-0000-000000000003';
  SELECT COUNT(*) INTO count_deliveries FROM operations.webhook_delivery WHERE state='queued';
  IF count_zones <> 1 OR count_orders <> 1 OR count_stops <> 2 OR count_events <> 1 OR count_positions <> 1 OR count_deliveries <> 1 THEN
    RAISE EXCEPTION 'operations schema invariant failed zones=% orders=% stops=% events=% positions=% deliveries=%', count_zones,count_orders,count_stops,count_events,count_positions,count_deliveries;
  END IF;
END $$;
SQL

echo "operations_schema_validation=passed"
