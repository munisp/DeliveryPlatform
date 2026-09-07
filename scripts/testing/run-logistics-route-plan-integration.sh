#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATABASE="logistics_route_plan_integration"
ROLE="logistics_route_plan_test"
PASSWORD="logistics-route-plan-test-password"
PORT=8090
TOKEN="0123456789abcdef0123456789abcdef0123456789abcdef"
OUT_DIR="$ROOT/validation/logistics_route_plan_integration_20260903"

cleanup() {
  if [[ -n "${DISPATCH_PID:-}" ]]; then kill -- "-${DISPATCH_PID}" 2>/dev/null || true; wait "$DISPATCH_PID" 2>/dev/null || true; fi
  fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
  sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DATABASE}' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
  sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${DATABASE};" >/dev/null 2>&1 || true
  sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${ROLE};" >/dev/null 2>&1 || true
  rm -f /tmp/logistics_operations_0028.sql /tmp/logistics_route_0030.sql
}
trap cleanup EXIT

cleanup
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}';"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DATABASE} OWNER ${ROLE};"
cp "$ROOT/drizzle/0028_logistics_operations.sql" /tmp/logistics_operations_0028.sql
cp "$ROOT/drizzle/0030_logistics_route_planning.sql" /tmp/logistics_route_0030.sql
chmod 0644 /tmp/logistics_*.sql
sudo -u postgres psql -d "$DATABASE" -v ON_ERROR_STOP=1 <<SQL
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE public.users (id serial PRIMARY KEY, open_id varchar(64) NOT NULL UNIQUE);
INSERT INTO public.users (id, open_id) VALUES (1,'route-planner-operator');
\i /tmp/logistics_operations_0028.sql
\i /tmp/logistics_route_0030.sql
GRANT USAGE ON SCHEMA operations TO ${ROLE};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA operations TO ${ROLE};
INSERT INTO operations.service_zone (id, tenant_id, code, display_name, boundary, created_by) VALUES ('b1000000-0000-4000-8000-000000000001','integration-tenant','LAG-TEST','Lagos test zone',ST_Multi(ST_SetSRID(ST_GeomFromText('POLYGON((3.35 6.42,3.45 6.42,3.45 6.52,3.35 6.52,3.35 6.42))'),4326))::geography,1);
INSERT INTO operations.work_order (id, tenant_id, external_reference, title, state, service_zone_id, created_by) VALUES ('c1000000-0000-4000-8000-000000000001','integration-tenant','ROUTE-INTEGRATION-1','Pickup-safe route test','queued','b1000000-0000-4000-8000-000000000001',1);
INSERT INTO operations.work_order_stop (id, work_order_id, sequence_no, stop_kind, display_name, address_text, location) VALUES
('d1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001',1,'pickup','Pickup A','Lagos Pickup A',ST_SetSRID(ST_MakePoint(3.390,6.455),4326)::geography),
('d1000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000001',2,'dropoff','Drop-off A','Lagos Drop-off A',ST_SetSRID(ST_MakePoint(3.410,6.480),4326)::geography),
('d1000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-000000000001',3,'checkpoint','Checkpoint','Lagos Checkpoint',ST_SetSRID(ST_MakePoint(3.405,6.470),4326)::geography);
SQL
setsid bash -c 'cd "$1" && DATABASE_URL="$2" INTERNAL_SERVICE_TOKEN="$3" BIND_HOST=127.0.0.1 PORT="$4" DATABASE_POOL_MAX_SIZE=4 cargo run --quiet' _ "$ROOT/services/rust/dispatch-optimizer" "postgresql://${ROLE}:${PASSWORD}@127.0.0.1:5432/${DATABASE}?sslmode=disable" "$TOKEN" "$PORT" >"$OUT_DIR/dispatch.log" 2>&1 &
DISPATCH_PID=$!
for _ in $(seq 1 45); do curl --silent --fail "http://127.0.0.1:${PORT}/health" >/dev/null && break; sleep 1; done
curl --silent --fail "http://127.0.0.1:${PORT}/health" >/dev/null
route_status="$(curl --silent --show-error -o "$OUT_DIR/route_plan_response.json" -w '%{http_code}' -X POST -H "content-type: application/json" -H "x-internal-service-token: $TOKEN" --data '{"work_order_id":"c1000000-0000-4000-8000-000000000001","created_by":1}' "http://127.0.0.1:${PORT}/operations/route-plans")"
if [[ "$route_status" != "200" ]]; then
  cat "$OUT_DIR/route_plan_response.json" >&2
  exit 1
fi
sudo -u postgres psql -d "$DATABASE" -Atc "SELECT json_build_object('route_plans', (SELECT count(*) FROM operations.route_plan), 'route_stops', (SELECT count(*) FROM operations.route_plan_stop), 'first_stop_kind', (SELECT s.stop_kind::text FROM operations.route_plan_stop p JOIN operations.work_order_stop s ON s.id=p.work_order_stop_id ORDER BY p.visit_sequence LIMIT 1), 'plan_state', (SELECT state FROM operations.route_plan LIMIT 1))::text" > "$OUT_DIR/database_assertions.json"
node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync('$OUT_DIR/route_plan_response.json')); const a=JSON.parse(fs.readFileSync('$OUT_DIR/database_assertions.json')); if(!r.route_plan_id||r.stops.length!==3||r.stops[0].stop_kind!=='pickup'||a.route_plans!==1||a.route_stops!==3||a.first_stop_kind!=='pickup'||a.plan_state!=='planned')process.exit(1); fs.writeFileSync('$OUT_DIR/summary.json',JSON.stringify({passed:true,route_plan_id:r.route_plan_id,stops:r.stops.length,total_distance_m:r.total_distance_m,first_stop_kind:a.first_stop_kind},null,2)+'\\n');"
