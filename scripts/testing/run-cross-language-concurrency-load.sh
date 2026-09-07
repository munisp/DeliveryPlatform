#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESULT_DIR="$ROOT/.integration-cross-language-load"
DATABASE_URL="${TEST_DATABASE_URL:-postgresql://switchos_it:switchos_it@127.0.0.1:5432/switchos_it?sslmode=disable}"
INTERNAL_SERVICE_TOKEN="${INTERNAL_SERVICE_TOKEN:-integration-token-for-switchos-services-2026}"
CONCURRENT_CLIENTS="${CONCURRENT_CLIENTS:-25}"

case "$DATABASE_URL" in
  *production*|*prod*)
    echo "Refusing to run write-enabled concurrency validation against a production-looking database URL" >&2
    exit 2
    ;;
esac

if [ "${#INTERNAL_SERVICE_TOKEN}" -lt 32 ]; then
  echo "INTERNAL_SERVICE_TOKEN must contain at least 32 characters" >&2
  exit 2
fi

if ! [[ "$CONCURRENT_CLIENTS" =~ ^[1-9][0-9]*$ ]] || [ "$CONCURRENT_CLIENTS" -gt 100 ]; then
  echo "CONCURRENT_CLIENTS must be an integer from 1 to 100" >&2
  exit 2
fi

mkdir -p "$RESULT_DIR"
rm -f "$RESULT_DIR"/*
for port in 8090 8101 8114 8115 8116 8117; do
  fuser -k "${port}/tcp" >/dev/null 2>&1 || true
done

export ROOT RESULT_DIR DATABASE_URL INTERNAL_SERVICE_TOKEN
export NODE_ENV=test BIND_HOST=127.0.0.1

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
  setsid bash -lc "cd '$directory' && exec bash -lc '$command'" >"$RESULT_DIR/${name}.log" 2>&1 &
  pids+=("$!")
}

wait_for_health() {
  local name="$1"
  local url="$2"
  local attempt
  for attempt in $(seq 1 90); do
    if curl --silent --show-error --fail "$url" >"$RESULT_DIR/${name}.health.json" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "${name} did not become healthy" >&2
  cat "$RESULT_DIR/${name}.log" >&2 || true
  return 1
}

send_json() {
  local service="$1"
  local request_id="$2"
  local url="$3"
  local payload="$4"
  local base="$RESULT_DIR/${service}-${request_id}"
  local status
  status=$(curl --silent --show-error --max-time 20 \
    --output "${base}.json" \
    --write-out '%{http_code} %{time_total}' \
    -H 'content-type: application/json' \
    -H "x-internal-service-token: ${INTERNAL_SERVICE_TOKEN}" \
    -H "x-trace-id: load-${service}-${request_id}" \
    --data "$payload" \
    "$url" 2>"${base}.stderr" || true)
  printf '%s\n' "$status" >"${base}.status"
  [ "${status%% *}" = "200" ]
}

run_bundle() {
  local request_id="$1"
  local warehouse_id=$((9000 + request_id))
  local pids=()

  send_json retail "$request_id" http://127.0.0.1:8115/forecast "{\"merchant_id\":${request_id},\"merchant_name\":\"Load Grocer ${request_id}\",\"city\":\"Lagos\",\"planning_horizon_hours\":24,\"skus\":[{\"sku\":\"load-milk-${request_id}\",\"label\":\"Load Milk\",\"on_hand_units\":4,\"reserved_units\":1,\"inbound_units\":2,\"lead_time_hours\":6,\"shelf_life_hours\":48,\"service_level\":0.95,\"event_multiplier\":1.2,\"weather_multiplier\":1.0,\"substitution_group\":\"dairy_alt\",\"cold_chain_required\":true}]}" & pids+=("$!")
  send_json procurement "$request_id" http://127.0.0.1:8116/procurement/plan "{\"city\":\"Lagos\",\"planning_horizon_hours\":48,\"trigger\":\"load_test\",\"requested_by\":\"cross_language_load\",\"workflow_reason\":\"High-concurrency capacity validation\",\"skus\":[{\"sku\":\"load-milk-${request_id}\",\"label\":\"Load Milk\",\"warehouse_id\":${warehouse_id},\"warehouse_label\":\"Load Warehouse\",\"zone_key\":\"VI\",\"current_available_units\":3,\"current_reserved_units\":1,\"current_inbound_units\":2,\"forecast_units\":18,\"recommended_restock_units\":16,\"safety_stock_units\":10,\"stockout_risk\":\"elevated\",\"supplier\":{\"supplier_id\":\"load-supplier\",\"supplier_name\":\"Load Supplier\",\"lead_time_hours\":6,\"fill_rate\":0.91,\"spoilage_risk\":0.04,\"reliability_band\":\"watch\"}}]}" & pids+=("$!")
  send_json inventory "$request_id" http://127.0.0.1:8117/inventory/adjustment "{\"warehouse_id\":${warehouse_id},\"sku\":\"load-milk-${request_id}\",\"merchant_id\":${request_id},\"city\":\"Lagos\",\"zone_key\":\"VI\",\"delta_units\":12,\"reserved_delta_units\":1,\"inbound_delta_units\":4,\"stock_accuracy\":0.97,\"freshness_hours\":18,\"cold_chain_ready\":true,\"source\":\"cross_language_load\",\"reason\":\"parallel durable inventory update\"}" & pids+=("$!")
  send_json pricing "$request_id" http://127.0.0.1:8101/price "{\"base_price\":1000,\"distance_km\":4.2,\"current_demand\":12,\"available_drivers\":4,\"hour_of_day\":19,\"day_of_week\":2,\"weather_condition\":\"rain\",\"price_floor\":900,\"price_ceiling\":2000,\"merchant_elasticity\":1.0,\"incentive_budget_ratio\":0.1}" & pids+=("$!")
  send_json dispatch "$request_id" http://127.0.0.1:8090/optimize "{\"trip_mode\":\"delivery\",\"demand_level\":12,\"supply_level\":4,\"multi_stop\":false,\"long_trip_minutes\":25,\"priority_level\":\"high\",\"drivers\":[{\"driver_id\":$((10000 + request_id)),\"name\":\"Load Ada\",\"tier\":\"gold\",\"acceptance_rate\":0.98,\"completion_rate\":0.99,\"utilization_rate\":0.35,\"distance_km\":1.4,\"idle_minutes\":14,\"recent_rejections\":0,\"on_trip\":false},{\"driver_id\":$((11000 + request_id)),\"name\":\"Load Bola\",\"tier\":\"silver\",\"acceptance_rate\":0.84,\"completion_rate\":0.91,\"utilization_rate\":0.67,\"distance_km\":3.9,\"idle_minutes\":3,\"recent_rejections\":2,\"on_trip\":false}]}" & pids+=("$!")
  send_json gateway "$request_id" http://127.0.0.1:8114/plan "{\"city\":\"Lagos\",\"customer_segment\":\"load_test\",\"categories\":[\"delivery\",\"retail\"],\"request\":\"Prepare a durable high-concurrency local-commerce plan\",\"membership_summary\":{\"active\":true},\"allocation\":{\"warehouse_id\":${warehouse_id},\"fill_rate\":0.95},\"forecast\":{\"sku_count\":1,\"risk\":\"watch\"},\"payload_metrics\":{\"request_id\":${request_id}}}" & pids+=("$!")

  local pid
  for pid in "${pids[@]}"; do
    wait "$pid"
  done
}

run_contention_update() {
  local request_id="$1"
  send_json contention "$request_id" http://127.0.0.1:8117/inventory/adjustment "{\"warehouse_id\":9999,\"sku\":\"contention-sku\",\"merchant_id\":9999,\"city\":\"Lagos\",\"zone_key\":\"VI\",\"delta_units\":1,\"reserved_delta_units\":0,\"inbound_delta_units\":0,\"stock_accuracy\":0.98,\"freshness_hours\":24,\"cold_chain_ready\":true,\"source\":\"concurrency_contention\",\"reason\":\"atomic increment validation\"}"
}

export -f send_json run_bundle run_contention_update

start_service retail-forecast "$ROOT/services/python/retail-forecast" 'exec python3 -m uvicorn main:app --host 127.0.0.1 --port 8115'
start_service procurement-planner "$ROOT/services/python/procurement-planner" 'exec python3 -m uvicorn main:app --host 127.0.0.1 --port 8116'
start_service inventory-control "$ROOT/services/go/inventory-control" 'go build -o "$RESULT_DIR/inventory-control-bin" . && PORT=8117 exec "$RESULT_DIR/inventory-control-bin"'
start_service local-commerce-gateway "$ROOT/services/go/local-commerce-gateway" 'go build -o "$RESULT_DIR/local-commerce-gateway-bin" . && PORT=8114 exec "$RESULT_DIR/local-commerce-gateway-bin"'
start_service dispatch-optimizer "$ROOT/services/rust/dispatch-optimizer" 'cargo build --quiet && PORT=8090 exec target/debug/switchos-dispatch-optimizer'
start_service pricing-engine "$ROOT/services/rust/pricing-engine" 'cargo build --quiet && PORT=8101 exec target/debug/switchos-pricing-engine'

wait_for_health retail-forecast http://127.0.0.1:8115/health
wait_for_health procurement-planner http://127.0.0.1:8116/health
wait_for_health inventory-control http://127.0.0.1:8117/health
wait_for_health local-commerce-gateway http://127.0.0.1:8114/health
wait_for_health dispatch-optimizer http://127.0.0.1:8090/health
wait_for_health pricing-engine http://127.0.0.1:8101/health

started_at=$(date +%s)
seq 1 "$CONCURRENT_CLIENTS" | xargs -P "$CONCURRENT_CLIENTS" -n 1 bash -c 'run_bundle "$1"' _
seq 1 "$CONCURRENT_CLIENTS" | xargs -P "$CONCURRENT_CLIENTS" -n 1 bash -c 'run_contention_update "$1"' _
finished_at=$(date +%s)

expected_bundle_requests=$((CONCURRENT_CLIENTS * 6))
expected_contention_requests="$CONCURRENT_CLIENTS"
status_files=$(find "$RESULT_DIR" -type f -name '*.status' | wc -l | tr -d ' ')
success_files=$(grep -hl '^200 ' "$RESULT_DIR"/*.status | wc -l | tr -d ' ')
expected_total_requests=$((expected_bundle_requests + expected_contention_requests))

if [ "$status_files" -ne "$expected_total_requests" ] || [ "$success_files" -ne "$expected_total_requests" ]; then
  echo "Load request mismatch: expected=${expected_total_requests} status_files=${status_files} successful=${success_files}" >&2
  grep -hL '^200 ' "$RESULT_DIR"/*.status >&2 || true
  exit 1
fi

export PGPASSWORD=switchos_it
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT CASE WHEN
  (SELECT COUNT(*) FROM service_execution_records WHERE trace_id LIKE 'load-%') >= ${CONCURRENT_CLIENTS} * 2 AND
  (SELECT COUNT(*) FROM inventory_positions WHERE warehouse_id BETWEEN 9001 AND $((9000 + CONCURRENT_CLIENTS))) = ${CONCURRENT_CLIENTS} AND
  (SELECT COUNT(*) FROM inventory_workflows WHERE workflow_type = 'inventory_adjustment') >= ${CONCURRENT_CLIENTS} * 2 AND
  (SELECT COUNT(*) FROM pricing_engine_runs) >= ${CONCURRENT_CLIENTS} AND
  (SELECT COUNT(*) FROM dispatch_optimizer_runs) >= ${CONCURRENT_CLIENTS} AND
  (SELECT COUNT(*) FROM local_commerce_gateway_events) >= ${CONCURRENT_CLIENTS} AND
  (SELECT on_hand_units = ${CONCURRENT_CLIENTS} FROM inventory_positions WHERE warehouse_id = 9999 AND sku = 'contention-sku')
THEN 'durable-load-effects-verified' ELSE 'durable-load-effects-missing' END" | grep -qx 'durable-load-effects-verified'

for service in retail procurement inventory pricing dispatch gateway contention; do
  count=$(cat "$RESULT_DIR/${service}-"*.status | wc -l | tr -d ' ')
  p95_index=$(( (count * 95 + 99) / 100 ))
  p95_seconds=$(awk '{print $2}' "$RESULT_DIR/${service}-"*.status | sort -n | sed -n "${p95_index}p")
  printf '%s requests=%s p95_seconds=%s\n' "$service" "$count" "$p95_seconds" | tee -a "$RESULT_DIR/summary.txt"
done

printf 'cross_language_concurrency_load_passed concurrent_clients=%s total_requests=%s elapsed_seconds=%s artifacts=%s\n' \
  "$CONCURRENT_CLIENTS" "$expected_total_requests" "$((finished_at - started_at))" "$RESULT_DIR" | tee -a "$RESULT_DIR/summary.txt"
