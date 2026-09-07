#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESULT_DIR="$ROOT/.pricing-dispatch-tail-load"
DATABASE_URL="${TEST_DATABASE_URL:-postgresql://switchos_it:switchos_it@127.0.0.1:5432/switchos_it?sslmode=disable}"
INTERNAL_SERVICE_TOKEN="${INTERNAL_SERVICE_TOKEN:-integration-token-for-switchos-services-2026}"
CONCURRENT_CLIENTS="${CONCURRENT_CLIENTS:-120}"

case "$DATABASE_URL" in
  *production*|*prod*)
    echo "Refusing to run write-enabled tail-latency validation against a production-looking database URL" >&2
    exit 2
    ;;
esac
if [ "${#INTERNAL_SERVICE_TOKEN}" -lt 32 ]; then
  echo "INTERNAL_SERVICE_TOKEN must contain at least 32 characters" >&2
  exit 2
fi
if ! [[ "$CONCURRENT_CLIENTS" =~ ^[1-9][0-9]*$ ]] || [ "$CONCURRENT_CLIENTS" -gt 250 ]; then
  echo "CONCURRENT_CLIENTS must be an integer from 1 to 250" >&2
  exit 2
fi

mkdir -p "$RESULT_DIR"
rm -f "$RESULT_DIR"/*
for port in 8090 8101; do
  fuser -k "${port}/tcp" >/dev/null 2>&1 || true
done

export ROOT RESULT_DIR DATABASE_URL INTERNAL_SERVICE_TOKEN
pids=()
cleanup() {
  local pid
  for pid in "${pids[@]:-}"; do kill -- "-${pid}" 2>/dev/null || true; done
  wait 2>/dev/null || true
  for port in 8090 8101; do fuser -k "${port}/tcp" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

start() {
  local name="$1" directory="$2" command="$3"
  setsid bash -lc "cd '$directory' && exec bash -lc '$command'" >"$RESULT_DIR/${name}.log" 2>&1 &
  pids+=("$!")
}
wait_for_health() {
  local name="$1" url="$2" attempt
  for attempt in $(seq 1 90); do
    if curl --silent --show-error --fail "$url" >"$RESULT_DIR/${name}.health.json" 2>/dev/null; then return 0; fi
    sleep 1
  done
  cat "$RESULT_DIR/${name}.log" >&2 || true
  return 1
}
request_price() {
  local id="$1"
  local base="$RESULT_DIR/pricing-${id}"
  local status
  status=$(curl --silent --show-error --max-time 30 --output "${base}.json" --write-out '%{http_code} %{time_total}' \
    -H 'content-type: application/json' -H "x-internal-service-token: ${INTERNAL_SERVICE_TOKEN}" -H "x-trace-id: tail-pricing-${id}" \
    --data '{"base_price":1000,"distance_km":4.2,"current_demand":0,"available_drivers":0,"hour_of_day":19,"day_of_week":2,"weather_condition":"rain","price_floor":900,"price_ceiling":2000}' \
    http://127.0.0.1:8101/price 2>"${base}.stderr" || true)
  printf '%s\n' "$status" >"${base}.status"
}
request_dispatch() {
  local id="$1"
  local base="$RESULT_DIR/dispatch-${id}"
  local status
  status=$(curl --silent --show-error --max-time 30 --output "${base}.json" --write-out '%{http_code} %{time_total}' \
    -H 'content-type: application/json' -H "x-internal-service-token: ${INTERNAL_SERVICE_TOKEN}" -H "x-trace-id: tail-dispatch-${id}" \
    --data '{"trip_mode":"delivery","drivers":[]}' \
    http://127.0.0.1:8090/optimize 2>"${base}.stderr" || true)
  printf '%s\n' "$status" >"${base}.status"
}
run_concurrent_requests() {
  local handler="$1"
  local -a workers=()
  local request_id
  for request_id in $(seq 1 "$CONCURRENT_CLIENTS"); do
    "$handler" "$request_id" &
    workers+=("$!")
  done
  local worker
  for worker in "${workers[@]}"; do
    wait "$worker"
  done
}

start pricing-engine "$ROOT/services/rust/pricing-engine" 'cargo build --quiet && PORT=8101 exec target/debug/switchos-pricing-engine'
start dispatch-optimizer "$ROOT/services/rust/dispatch-optimizer" 'cargo build --quiet && PORT=8090 exec target/debug/switchos-dispatch-optimizer'
wait_for_health pricing-engine http://127.0.0.1:8101/health
wait_for_health dispatch-optimizer http://127.0.0.1:8090/health

run_concurrent_requests request_price
run_concurrent_requests request_dispatch

printf 'service,requests,successes,failures,min_seconds,p50_seconds,p90_seconds,p95_seconds,p99_seconds,max_seconds,mean_seconds\n' > "$RESULT_DIR/summary.csv"
for service in pricing dispatch; do
  mapfile -t files < <(find "$RESULT_DIR" -maxdepth 1 -type f -name "${service}-*.status" | sort)
  request_count=$(cat "${files[@]}" | wc -l | tr -d ' ')
  success_count=$(awk '$1 == "200" { count++ } END { print count + 0 }' "${files[@]}")
  failure_count=$((request_count - success_count))
  if [ "$success_count" -eq 0 ]; then
    printf '%s,%s,0,%s,,,,,,,,\n' "$service" "$request_count" "$failure_count" >> "$RESULT_DIR/summary.csv"
    continue
  fi
  mapfile -t timings < <(awk '$1 == "200" { print $2 }' "${files[@]}" | sort -n)
  p50_index=$(( (success_count * 50 + 99) / 100 ))
  p90_index=$(( (success_count * 90 + 99) / 100 ))
  p95_index=$(( (success_count * 95 + 99) / 100 ))
  p99_index=$(( (success_count * 99 + 99) / 100 ))
  mean=$(printf '%s\n' "${timings[@]}" | awk '{ sum += $1 } END { printf "%.6f", sum / NR }')
  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$service" "$request_count" "$success_count" "$failure_count" \
    "${timings[0]}" "${timings[$((p50_index - 1))]}" "${timings[$((p90_index - 1))]}" \
    "${timings[$((p95_index - 1))]}" "${timings[$((p99_index - 1))]}" "${timings[$((success_count - 1))]}" "$mean" \
    >> "$RESULT_DIR/summary.csv"
done

cat "$RESULT_DIR/summary.csv"
printf '\n--- status distribution ---\n'
awk '{print $1}' "$RESULT_DIR"/*.status | sort | uniq -c
printf '\n--- PostgreSQL connection ceiling ---\n'
export PGPASSWORD=switchos_it
psql "$DATABASE_URL" -Atc 'SHOW max_connections;' | tee "$RESULT_DIR/postgres_max_connections.txt"
printf '\n--- service error markers ---\n'
grep -RInE 'too many clients|connection error|ERROR|panic|FATAL' "$RESULT_DIR"/*.log || true
