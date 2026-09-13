#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESULT_DIR="${TRACKER_REHEARSAL_RESULT_DIR:-$ROOT_DIR/.vehicle-tracker-rehearsal}"
KUBE_CONTEXT="${TEST_CLUSTER_CONTEXT:-}"
PROMETHEUS_URL="${TEST_PROMETHEUS_URL:-http://127.0.0.1:9090}"
TRACKER_NAMESPACE="${TRACKER_REHEARSAL_NAMESPACE:-switchos-rehearsal}"
MAX_BACKEND_CONNECTIONS="${TRACKER_MAX_BACKEND_CONNECTIONS:-48}"
MAX_CLIENT_WAITING="${TRACKER_MAX_CLIENT_WAITING:-0}"
MAX_OLDEST_WAIT_SECONDS="${TRACKER_MAX_OLDEST_WAIT_SECONDS:-0.5}"
EXPECTED_POOLERS="${TRACKER_EXPECTED_POOLERS:-4}"
MAX_WORKER_CLIENT_CONNECTIONS="${TRACKER_MAX_WORKER_CLIENT_CONNECTIONS:-256}"
REQUIRE_MAX_SURGE_ZERO="${TRACKER_REQUIRE_MAX_SURGE_ZERO:-true}"
ALLOW_REHEARSAL="${ALLOW_NON_PRODUCTION_TRACKER_REHEARSAL:-}"
QUERY_ASSERT="$ROOT_DIR/scripts/testing/assert-prometheus-instant-query.py"

fail() {
  printf 'vehicle_tracker_headroom_gate=FAIL reason=%s\n' "$1" >&2
  exit 2
}

[[ "$ALLOW_REHEARSAL" == "yes" ]] || fail "set_ALLOW_NON_PRODUCTION_TRACKER_REHEARSAL_yes"
[[ -n "$KUBE_CONTEXT" ]] || fail "TEST_CLUSTER_CONTEXT_required"
[[ "$KUBE_CONTEXT" =~ (kind|test|staging|rehearsal|sandbox) ]] || fail "context_must_be_explicitly_non_production"
[[ "$TRACKER_NAMESPACE" =~ (test|rehearsal|sandbox) ]] || fail "namespace_must_be_explicitly_test_only"
[[ "$PROMETHEUS_URL" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]{2,5})?$ ]] || fail "TEST_PROMETHEUS_URL_must_be_local_port_forward"
[[ "$MAX_BACKEND_CONNECTIONS" =~ ^[0-9]+$ ]] && (( MAX_BACKEND_CONNECTIONS >= 0 && MAX_BACKEND_CONNECTIONS <= 80 )) || fail "invalid_TRACKER_MAX_BACKEND_CONNECTIONS"
[[ "$MAX_CLIENT_WAITING" =~ ^[0-9]+$ ]] || fail "invalid_TRACKER_MAX_CLIENT_WAITING"
[[ "$EXPECTED_POOLERS" =~ ^[1-9][0-9]*$ ]] || fail "invalid_TRACKER_EXPECTED_POOLERS"
[[ "$MAX_WORKER_CLIENT_CONNECTIONS" =~ ^[1-9][0-9]*$ ]] && (( MAX_WORKER_CLIENT_CONNECTIONS <= 256 )) || fail "invalid_TRACKER_MAX_WORKER_CLIENT_CONNECTIONS"
[[ "$REQUIRE_MAX_SURGE_ZERO" == "true" || "$REQUIRE_MAX_SURGE_ZERO" == "false" ]] || fail "TRACKER_REQUIRE_MAX_SURGE_ZERO_must_be_true_or_false"
command -v kubectl >/dev/null || fail "kubectl_required"
command -v curl >/dev/null || fail "curl_required"
[[ -x "$QUERY_ASSERT" ]] || fail "prometheus_assertion_helper_missing_or_not_executable"

mkdir -p "$RESULT_DIR"
K=(kubectl --context "$KUBE_CONTEXT" -n "$TRACKER_NAMESPACE")

cluster_server="$(kubectl --context "$KUBE_CONTEXT" config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
[[ "$cluster_server" != *"production"* && "$cluster_server" != *"prod."* ]] || fail "cluster_server_looks_production"

"${K[@]}" get deployment vehicle-tracker-ingest >/dev/null
"${K[@]}" get deployment vehicle-tracker-pgbouncer >/dev/null
"${K[@]}" get hpa vehicle-tracker-ingest >/dev/null

worker_available="$("${K[@]}" get deployment vehicle-tracker-ingest -o jsonpath='{.status.availableReplicas}')"
worker_desired="$("${K[@]}" get deployment vehicle-tracker-ingest -o jsonpath='{.status.replicas}')"
worker_max_surge="$("${K[@]}" get deployment vehicle-tracker-ingest -o jsonpath='{.spec.strategy.rollingUpdate.maxSurge}')"
pooler_available="$("${K[@]}" get deployment vehicle-tracker-pgbouncer -o jsonpath='{.status.availableReplicas}')"
[[ "$worker_available" =~ ^[0-9]+$ ]] && (( worker_available >= 16 && worker_available <= 64 )) || fail "tracker_worker_count_outside_16_to_64_envelope"
[[ "$worker_desired" =~ ^[0-9]+$ ]] && (( worker_desired >= 16 && worker_desired <= 64 )) || fail "tracker_worker_desired_count_outside_16_to_64_envelope"
if [[ "$REQUIRE_MAX_SURGE_ZERO" == "true" ]]; then
  [[ "$worker_max_surge" == "0" ]] || fail "max_surge_zero_overlay_not_observed"
fi
[[ "$pooler_available" == "$EXPECTED_POOLERS" ]] || fail "unexpected_ready_pooler_count"

query() {
  local label="$1"
  local promql="$2"
  local output="$RESULT_DIR/headroom-${label}.json"
  curl --fail --silent --show-error --get "$PROMETHEUS_URL/api/v1/query" \
    --data-urlencode "query=${promql}" >"$output"
  printf '%s\n' "$output"
}

exporter_count="$(query exporter_count "count(pgbouncer_up{namespace=\"${TRACKER_NAMESPACE}\",service=\"vehicle-tracker-pgbouncer\"})")"
python3 "$QUERY_ASSERT" --input "$exporter_count" --operator eq --threshold "$EXPECTED_POOLERS" --expected-samples 1 --label exporter_count

exporter_health="$(query exporter_health "min(pgbouncer_up{namespace=\"${TRACKER_NAMESPACE}\",service=\"vehicle-tracker-pgbouncer\"})")"
python3 "$QUERY_ASSERT" --input "$exporter_health" --operator eq --threshold 1 --expected-samples 1 --label exporter_health

backend_connections="$(query backend_connections "sum(vehicle_tracker_pgbouncer_server_connections{namespace=\"${TRACKER_NAMESPACE}\"})")"
python3 "$QUERY_ASSERT" --input "$backend_connections" --operator le --threshold "$MAX_BACKEND_CONNECTIONS" --expected-samples 1 --label backend_connections

queued_clients="$(query queued_clients "sum(pgbouncer_pools_client_waiting_connections{namespace=\"${TRACKER_NAMESPACE}\",service=\"vehicle-tracker-pgbouncer\"})")"
python3 "$QUERY_ASSERT" --input "$queued_clients" --operator le --threshold "$MAX_CLIENT_WAITING" --expected-samples 1 --label queued_clients

oldest_wait="$(query oldest_wait "max(pgbouncer_pools_client_maxwait_seconds{namespace=\"${TRACKER_NAMESPACE}\",service=\"vehicle-tracker-pgbouncer\"})")"
python3 "$QUERY_ASSERT" --input "$oldest_wait" --operator le --threshold "$MAX_OLDEST_WAIT_SECONDS" --expected-samples 1 --label oldest_wait

worker_client_ceiling="$(query worker_client_ceiling "sum(vehicle_tracker_pool_max_connections{namespace=\"${TRACKER_NAMESPACE}\"})")"
python3 "$QUERY_ASSERT" --input "$worker_client_ceiling" --operator le --threshold "$MAX_WORKER_CLIENT_CONNECTIONS" --expected-samples 1 --label worker_client_ceiling

printf 'vehicle_tracker_headroom_gate=PASS context=%s namespace=%s workers=%s desired_workers=%s max_surge=%s poolers=%s backend_limit=%s worker_client_limit=%s result_dir=%s\n' \
  "$KUBE_CONTEXT" "$TRACKER_NAMESPACE" "$worker_available" "$worker_desired" "$worker_max_surge" "$pooler_available" "$MAX_BACKEND_CONNECTIONS" "$MAX_WORKER_CLIENT_CONNECTIONS" "$RESULT_DIR" \
  | tee "$RESULT_DIR/headroom-gate-summary.txt"
