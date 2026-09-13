#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESULT_DIR="${TRACKER_REHEARSAL_RESULT_DIR:-$ROOT_DIR/.vehicle-tracker-rehearsal}/pgbouncer-cap"
PROMETHEUS_URL="${TEST_PROMETHEUS_URL:-http://127.0.0.1:9090}"
TRACKER_NAMESPACE="${TRACKER_REHEARSAL_NAMESPACE:-switchos-rehearsal}"
# Exactly four comma-separated test-only PgBouncer PostgreSQL URLs are required.
# Each URL must address a distinct test pooler port-forward or test-only Pod DNS.
PGBOUNCER_URLS="${TRACKER_REHEARSAL_PGBOUNCER_URLS:-}"
HOLD_SECONDS="${TRACKER_CAP_HOLD_SECONDS:-90}"
EXCESS_CLIENTS_PER_POOLER="${TRACKER_CAP_EXCESS_CLIENTS_PER_POOLER:-1}"
ALLOW_REHEARSAL="${ALLOW_NON_PRODUCTION_TRACKER_REHEARSAL:-}"
QUERY_ASSERT="$ROOT_DIR/scripts/testing/assert-prometheus-instant-query.py"

fail() {
  printf 'vehicle_tracker_pgbouncer_cap_rehearsal=FAIL reason=%s\n' "$1" >&2
  exit 2
}

[[ "$ALLOW_REHEARSAL" == "yes" ]] || fail "set_ALLOW_NON_PRODUCTION_TRACKER_REHEARSAL_yes"
[[ "$TRACKER_NAMESPACE" =~ (test|rehearsal|sandbox) ]] || fail "namespace_must_be_explicitly_test_only"
[[ "$PROMETHEUS_URL" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]{2,5})?$ ]] || fail "TEST_PROMETHEUS_URL_must_be_local_port_forward"
[[ "$HOLD_SECONDS" =~ ^[6-9][0-9]$|^[1-9][0-9]{2,}$ ]] || fail "TRACKER_CAP_HOLD_SECONDS_must_be_at_least_60"
[[ "$EXCESS_CLIENTS_PER_POOLER" =~ ^[1-4]$ ]] || fail "TRACKER_CAP_EXCESS_CLIENTS_PER_POOLER_must_be_1_through_4"
command -v psql >/dev/null || fail "psql_required"
command -v curl >/dev/null || fail "curl_required"
[[ -x "$QUERY_ASSERT" ]] || fail "prometheus_assertion_helper_missing_or_not_executable"

IFS=',' read -r -a URLS <<< "$PGBOUNCER_URLS"
[[ "${#URLS[@]}" == "4" ]] || fail "TRACKER_REHEARSAL_PGBOUNCER_URLS_must_contain_exactly_four_urls"
for url in "${URLS[@]}"; do
  [[ "$url" =~ ^postgres(ql)?:// ]] || fail "invalid_pgbouncer_url"
  [[ "$url" != *production* && "$url" != *prod.* && "$url" != *prod-* ]] || fail "pgbouncer_url_looks_production"
done

mkdir -p "$RESULT_DIR"
rm -f "$RESULT_DIR"/*
pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT

query() {
  local label="$1"
  local promql="$2"
  local output="$RESULT_DIR/prometheus-${label}.json"
  curl --fail --silent --show-error --get "$PROMETHEUS_URL/api/v1/query" \
    --data-urlencode "query=${promql}" >"$output"
  printf '%s\n' "$output"
}

assert() {
  local label="$1"
  local promql="$2"
  local operator="$3"
  local threshold="$4"
  local samples="$5"
  local response
  response="$(query "$label" "$promql")"
  python3 "$QUERY_ASSERT" --input "$response" --operator "$operator" --threshold "$threshold" \
    --expected-samples "$samples" --label "$label" | tee -a "$RESULT_DIR/prometheus-checks.txt"
}

hold_transaction() {
  local url="$1"
  local label="$2"
  psql "$url" -X -v ON_ERROR_STOP=1 -c "BEGIN; SELECT pg_sleep(${HOLD_SECONDS}); COMMIT;" \
    >"$RESULT_DIR/${label}.out" 2>"$RESULT_DIR/${label}.err"
}

# Establish 80 exactly concurrent transaction-pooling requests: 20 transactions
# per named pooler. Each has a short, finite test hold and is guaranteed to be
# terminated by the local cleanup trap if an assertion fails.
for pooler_index in 0 1 2 3; do
  for client_index in $(seq 1 20); do
    hold_transaction "${URLS[$pooler_index]}" "pooler-${pooler_index}-baseline-${client_index}" &
    pids+=("$!")
  done
done

# Existing ServiceMonitors scrape every 15 seconds. Wait through two intervals
# before judging the observed server cap.
sleep 32
assert pooler_count "count(pgbouncer_up{namespace=\"${TRACKER_NAMESPACE}\",service=\"vehicle-tracker-pgbouncer\"})" eq 4 1
assert pooler_health "min(pgbouncer_up{namespace=\"${TRACKER_NAMESPACE}\",service=\"vehicle-tracker-pgbouncer\"})" eq 1 1
assert aggregate_server_saturation "sum(vehicle_tracker_pgbouncer_server_connections{namespace=\"${TRACKER_NAMESPACE}\"})" eq 80 1
assert per_pooler_server_saturation "max by (instance) (vehicle_tracker_pgbouncer_server_connections{namespace=\"${TRACKER_NAMESPACE}\"})" eq 20 4

# Add a bounded excess wave. PgBouncer must queue/reject it; it must not create
# a 21st PostgreSQL backend session at any pooler. A nonzero exit from these
# excess clients is expected once query_wait_timeout expires and is captured.
excess_pids=()
for pooler_index in 0 1 2 3; do
  for client_index in $(seq 1 "$EXCESS_CLIENTS_PER_POOLER"); do
    (
      set +e
      psql "${URLS[$pooler_index]}" -X -v ON_ERROR_STOP=1 -c 'SELECT 1' \
        >"$RESULT_DIR/pooler-${pooler_index}-excess-${client_index}.out" \
        2>"$RESULT_DIR/pooler-${pooler_index}-excess-${client_index}.err"
      printf '%s\n' "$?" >"$RESULT_DIR/pooler-${pooler_index}-excess-${client_index}.exit"
    ) &
    excess_pids+=("$!")
  done
done

# Wait through one full 15-second scrape interval while baseline transactions
# remain held, so the exporter has time to publish the queue.
sleep 20
assert aggregate_server_cap_after_excess "sum(vehicle_tracker_pgbouncer_server_connections{namespace=\"${TRACKER_NAMESPACE}\"})" le 80 1
assert per_pooler_server_cap_after_excess "max by (instance) (vehicle_tracker_pgbouncer_server_connections{namespace=\"${TRACKER_NAMESPACE}\"})" le 20 4
assert queued_clients_present "sum(pgbouncer_pools_client_waiting_connections{namespace=\"${TRACKER_NAMESPACE}\",service=\"vehicle-tracker-pgbouncer\"})" gt 0 1

for pid in "${excess_pids[@]}"; do
  wait "$pid"
done
for pid in "${pids[@]}"; do
  wait "$pid"
done
pids=()

assert recovery_backend_servers "sum(vehicle_tracker_pgbouncer_server_connections{namespace=\"${TRACKER_NAMESPACE}\"})" le 80 1
assert recovery_queued_clients "sum(pgbouncer_pools_client_waiting_connections{namespace=\"${TRACKER_NAMESPACE}\",service=\"vehicle-tracker-pgbouncer\"})" eq 0 1

printf 'vehicle_tracker_pgbouncer_cap_rehearsal=PASS poolers=4 baseline_clients=80 excess_per_pooler=%s hold_seconds=%s result_dir=%s\n' \
  "$EXCESS_CLIENTS_PER_POOLER" "$HOLD_SECONDS" "$RESULT_DIR" | tee "$RESULT_DIR/summary.txt"
