#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$ROOT/.integration-cross-language"
DATABASE_URL="${TEST_DATABASE_URL:-postgresql://switchos_it:switchos_it@127.0.0.1:5432/switchos_it?sslmode=disable}"
INTERNAL_SERVICE_TOKEN="${INTERNAL_SERVICE_TOKEN:-integration-token-for-switchos-services-2026}"

case "$DATABASE_URL" in
  *production*|*prod*)
    echo "Refusing to run write-enabled integration validation against a production-looking database URL" >&2
    exit 2
    ;;
esac

if [ "${#INTERNAL_SERVICE_TOKEN}" -lt 32 ]; then
  echo "INTERNAL_SERVICE_TOKEN must contain at least 32 characters" >&2
  exit 2
fi

mkdir -p "$LOG_DIR"
rm -f "$LOG_DIR"/*.log "$LOG_DIR"/*.json
for port in 8090 8101 8114 8115 8116 8117; do
  fuser -k "${port}/tcp" >/dev/null 2>&1 || true
done

export ROOT LOG_DIR DATABASE_URL INTERNAL_SERVICE_TOKEN
export NODE_ENV=test
export BIND_HOST=127.0.0.1
export RETAIL_FORECAST_SERVICE_URL=http://127.0.0.1:8115
export PROCUREMENT_PLANNER_SERVICE_URL=http://127.0.0.1:8116
export INVENTORY_CONTROL_SERVICE_URL=http://127.0.0.1:8117
export LOCAL_COMMERCE_GATEWAY_URL=http://127.0.0.1:8114
export DISPATCH_OPTIMIZER_URL=http://127.0.0.1:8090
export PRICING_ENGINE_URL=http://127.0.0.1:8101

pids=()
cleanup() {
  local pid
  for pid in "${pids[@]:-}"; do
    kill -- "-${pid}" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  for port in 8090 8101 8114 8115 8116 8117; do
    fuser -k "${port}/tcp" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

start_service() {
  local name="$1"
  local directory="$2"
  local command="$3"
  setsid bash -lc "cd '$directory' && exec bash -lc '$command'" >"$LOG_DIR/${name}.log" 2>&1 &
  pids+=("$!")
}

wait_for_health() {
  local name="$1"
  local url="$2"
  local attempt
  for attempt in $(seq 1 90); do
    if curl --silent --show-error --fail "$url" >"$LOG_DIR/${name}.health.json" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "${name} did not become healthy; log follows:" >&2
  cat "$LOG_DIR/${name}.log" >&2 || true
  return 1
}

assert_status() {
  local expected="$1"
  shift
  local actual
  actual=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$@")
  if [ "$actual" != "$expected" ]; then
    echo "Expected HTTP ${expected}; received ${actual} for: $*" >&2
    return 1
  fi
}

post_json() {
  local name="$1"
  local url="$2"
  local payload="$3"
  curl --silent --show-error --fail \
    -H 'content-type: application/json' \
    -H "x-internal-service-token: $INTERNAL_SERVICE_TOKEN" \
    -H "x-trace-id: e2e-$name" \
    --data "$payload" \
    "$url" >"$LOG_DIR/${name}.json"
}

start_service retail-forecast "$ROOT/services/python/retail-forecast" 'exec python3 -m uvicorn main:app --host 127.0.0.1 --port 8115'
start_service procurement-planner "$ROOT/services/python/procurement-planner" 'exec python3 -m uvicorn main:app --host 127.0.0.1 --port 8116'
start_service inventory-control "$ROOT/services/go/inventory-control" 'go build -o "$LOG_DIR/inventory-control-bin" . && PORT=8117 exec "$LOG_DIR/inventory-control-bin"'
start_service local-commerce-gateway "$ROOT/services/go/local-commerce-gateway" 'go build -o "$LOG_DIR/local-commerce-gateway-bin" . && PORT=8114 exec "$LOG_DIR/local-commerce-gateway-bin"'
start_service dispatch-optimizer "$ROOT/services/rust/dispatch-optimizer" 'cargo build --quiet && PORT=8090 exec target/debug/switchos-dispatch-optimizer'
start_service pricing-engine "$ROOT/services/rust/pricing-engine" 'cargo build --quiet && PORT=8101 exec target/debug/switchos-pricing-engine'

wait_for_health retail-forecast http://127.0.0.1:8115/health
wait_for_health procurement-planner http://127.0.0.1:8116/health
wait_for_health inventory-control http://127.0.0.1:8117/health
wait_for_health local-commerce-gateway http://127.0.0.1:8114/health
wait_for_health dispatch-optimizer http://127.0.0.1:8090/health
wait_for_health pricing-engine http://127.0.0.1:8101/health

# Confirm route-level access controls reject unauthenticated business requests.
assert_status 401 -X POST -H 'content-type: application/json' --data '{"base_price":10,"distance_km":1,"current_demand":1,"available_drivers":1}' http://127.0.0.1:8101/price
assert_status 401 -X POST -H 'content-type: application/json' --data '{"merchant_name":"Unauthenticated","city":"Lagos","skus":[]}' http://127.0.0.1:8115/forecast
assert_status 401 -X POST -H 'content-type: application/json' --data '{"warehouse_id":1,"sku":"unauth","city":"Lagos","source":"test","reason":"test"}' http://127.0.0.1:8117/inventory/adjustment

# Exercise real business requests through every language runtime.
post_json retail-forecast http://127.0.0.1:8115/forecast '{"merchant_id":91,"merchant_name":"E2E Grocer","city":"Lagos","planning_horizon_hours":24,"skus":[{"sku":"milk-1l","label":"Milk 1L","on_hand_units":4,"reserved_units":1,"inbound_units":2,"lead_time_hours":6,"shelf_life_hours":24,"service_level":0.95,"event_multiplier":1.2,"weather_multiplier":1.0,"substitution_group":"dairy_alt","cold_chain_required":true}]}'
post_json procurement-plan http://127.0.0.1:8116/procurement/plan '{"city":"Lagos","planning_horizon_hours":48,"trigger":"e2e_restock","requested_by":"cross_language_e2e","workflow_reason":"Preserve availability","skus":[{"sku":"milk-1l","label":"Milk 1L","warehouse_id":701,"warehouse_label":"VI Dark Store","zone_key":"Victoria Island","current_available_units":3,"current_reserved_units":1,"current_inbound_units":2,"forecast_units":18,"recommended_restock_units":16,"safety_stock_units":10,"stockout_risk":"elevated","supplier":{"supplier_id":"sup-01","supplier_name":"E2E Supplier","lead_time_hours":6,"fill_rate":0.91,"spoilage_risk":0.04,"reliability_band":"watch"}}]}'
post_json inventory-adjustment http://127.0.0.1:8117/inventory/adjustment '{"warehouse_id":701,"sku":"milk-1l","merchant_id":91,"city":"Lagos","zone_key":"Victoria Island","delta_units":12,"reserved_delta_units":1,"inbound_delta_units":4,"stock_accuracy":0.97,"freshness_hours":18,"cold_chain_ready":true,"source":"cross_language_e2e","reason":"initial durable inventory position"}'
post_json inventory-replenishment http://127.0.0.1:8117/inventory/replenishment-request '{"city":"Lagos","planning_horizon_hours":48,"trigger":"e2e_restock","requested_by":"cross_language_e2e","workflow_reason":"Preserve availability","approval_mode":"operator_review","skus":[{"sku":"milk-1l","label":"Milk 1L","warehouse_id":701,"warehouse_label":"VI Dark Store","supplier_id":"sup-01","supplier_name":"E2E Supplier","recommended_units":16,"safety_stock_units":10,"current_available_units":3,"current_inbound_units":2,"lead_time_hours":6,"service_level":0.985,"risk_band":"elevated"}]}'
post_json pricing http://127.0.0.1:8101/price '{"base_price":1000,"distance_km":4.2,"current_demand":12,"available_drivers":4,"hour_of_day":19,"day_of_week":2,"weather_condition":"rain","price_floor":900,"price_ceiling":2000,"merchant_elasticity":1.0,"incentive_budget_ratio":0.1}'
post_json dispatch http://127.0.0.1:8090/optimize '{"trip_mode":"delivery","demand_level":12,"supply_level":4,"multi_stop":false,"long_trip_minutes":25,"priority_level":"high","drivers":[{"driver_id":901,"name":"Ada","tier":"gold","acceptance_rate":0.98,"completion_rate":0.99,"utilization_rate":0.35,"distance_km":1.4,"idle_minutes":14,"recent_rejections":0,"on_trip":false},{"driver_id":902,"name":"Bola","tier":"silver","acceptance_rate":0.84,"completion_rate":0.91,"utilization_rate":0.67,"distance_km":3.9,"idle_minutes":3,"recent_rejections":2,"on_trip":false}]}'

# Run the repository-owned multi-service concierge harness over the live local endpoints.
pnpm --dir "$ROOT" exec tsx validation/meituan_competitive_upgrade_e2e.ts >"$LOG_DIR/concierge-harness.log" 2>&1

# Assert response contracts and durable effects rather than only accepting HTTP success.
grep -q 'recommendations' "$LOG_DIR/retail-forecast.json"
grep -q 'procurement_actions' "$LOG_DIR/procurement-plan.json"
grep -q 'workflow_id' "$LOG_DIR/inventory-adjustment.json"
grep -q 'recommended_driver_id' "$LOG_DIR/dispatch.json"
grep -q 'final_price' "$LOG_DIR/pricing.json"

export PGPASSWORD=switchos_it
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT CASE WHEN (SELECT COUNT(*) FROM service_execution_records) >= 2 AND (SELECT COUNT(*) FROM inventory_positions WHERE warehouse_id=701 AND sku='milk-1l') = 1 AND (SELECT COUNT(*) FROM inventory_workflows) >= 2 AND (SELECT COUNT(*) FROM pricing_engine_runs) >= 1 AND (SELECT COUNT(*) FROM dispatch_optimizer_runs) >= 1 THEN 'durable-effects-verified' ELSE 'durable-effects-missing' END" | grep -qx 'durable-effects-verified'

printf 'Cross-language E2E integration PASSED. Artifacts: %s\n' "$LOG_DIR"
