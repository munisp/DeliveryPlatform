#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESULT_DIR="${TRACKER_REHEARSAL_RESULT_DIR:-$ROOT_DIR/.vehicle-tracker-rehearsal}"
KUBE_CONTEXT="${TEST_CLUSTER_CONTEXT:-}"
TRACKER_NAMESPACE="${TRACKER_REHEARSAL_NAMESPACE:-switchos-rehearsal}"
PROMETHEUS_URL="${TEST_PROMETHEUS_URL:-http://127.0.0.1:9090}"
INGRESS_URL="${TRACKER_REHEARSAL_INGRESS_URL:-}"
DATABASE_URL="${TRACKER_REHEARSAL_DATABASE_URL:-}"
INTEGRATION_KEY="${TRACKER_REHEARSAL_INTEGRATION_KEY:-}"
WEBHOOK_SECRET="${TRACKER_REHEARSAL_WEBHOOK_SECRET:-}"
DEVICE_IDS="${TRACKER_REHEARSAL_DEVICE_IDS:-}"
STAGES="${TRACKER_REHEARSAL_STAGES:-16 32 48 64}"
WARMUP_DURATION="${TRACKER_REHEARSAL_WARMUP_DURATION:-5m}"
STEADY_DURATION="${TRACKER_REHEARSAL_STEADY_DURATION:-15m}"
RECOVERY_DURATION="${TRACKER_REHEARSAL_RECOVERY_DURATION:-10m}"
USERS_PER_STAGE="${TRACKER_REHEARSAL_USERS_PER_STAGE:-16}"
SPAWN_RATE="${TRACKER_REHEARSAL_SPAWN_RATE:-4}"
EXPECTED_POOLERS="${TRACKER_EXPECTED_POOLERS:-4}"
TOTAL_TRACKER_BACKEND_BUDGET="${TRACKER_TOTAL_BACKEND_BUDGET:-80}"
NON_TRACKER_CONNECTION_BUDGET="${TRACKER_NON_TRACKER_CONNECTION_BUDGET:-}"
MAINTENANCE_CONNECTION_BUDGET="${TRACKER_MAINTENANCE_CONNECTION_BUDGET:-}"
OPERATIONAL_CONNECTION_RESERVE="${TRACKER_OPERATIONAL_CONNECTION_RESERVE:-}"
ALLOW_REHEARSAL="${ALLOW_NON_PRODUCTION_TRACKER_REHEARSAL:-}"
LOCUST_FILE="$ROOT_DIR/scripts/testing/locust/locustfile_vehicle_tracker_rehearsal.py"
QUERY_ASSERT="$ROOT_DIR/scripts/testing/assert-prometheus-instant-query.py"
HEADROOM_GATE="$ROOT_DIR/scripts/testing/check-vehicle-tracker-pgbouncer-headroom.sh"
RUN_ID="${TRACKER_REHEARSAL_RUN_ID:-tracker-rehearsal-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
RUN_PGBOUNCER_CAP_TEST="${TRACKER_REHEARSAL_RUN_PGBOUNCER_CAP_TEST:-false}"
PGBOUNCER_CAP_TEST="$ROOT_DIR/scripts/testing/run-vehicle-tracker-pgbouncer-cap-rehearsal.sh"

fail() {
  printf 'vehicle_tracker_multipod_rehearsal=FAIL reason=%s\n' "$1" >&2
  exit 2
}

require_integer() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || fail "${name}_must_be_a_nonnegative_integer"
}

require_duration() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[1-9][0-9]*[smh]$ ]] || fail "${name}_must_match_positive_number_plus_s_m_or_h"
}

validate_test_only_environment() {
  [[ "$ALLOW_REHEARSAL" == "yes" ]] || fail "set_ALLOW_NON_PRODUCTION_TRACKER_REHEARSAL_yes"
  [[ -n "$KUBE_CONTEXT" ]] || fail "TEST_CLUSTER_CONTEXT_required"
  [[ "$KUBE_CONTEXT" =~ (kind|test|staging|rehearsal|sandbox) ]] || fail "context_must_be_explicitly_non_production"
  [[ "$TRACKER_NAMESPACE" =~ (test|rehearsal|sandbox) ]] || fail "namespace_must_be_explicitly_test_only"
  [[ "$INGRESS_URL" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]{2,5})?$ ]] || fail "TRACKER_REHEARSAL_INGRESS_URL_must_be_a_local_port_forward"
  [[ "$PROMETHEUS_URL" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]{2,5})?$ ]] || fail "TEST_PROMETHEUS_URL_must_be_a_local_port_forward"
  [[ "$DATABASE_URL" =~ ^postgres(ql)?:// ]] || fail "TRACKER_REHEARSAL_DATABASE_URL_required"
  [[ "$DATABASE_URL" != *production* && "$DATABASE_URL" != *prod.* && "$DATABASE_URL" != *prod-* ]] || fail "database_url_looks_production"
  [[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{7,95}$ ]] || fail "TRACKER_REHEARSAL_RUN_ID_invalid"
  [[ "$INTEGRATION_KEY" =~ ^[a-z][a-z0-9_.-]{2,80}$ ]] || fail "TRACKER_REHEARSAL_INTEGRATION_KEY_invalid"
  [[ ${#WEBHOOK_SECRET} -ge 16 ]] || fail "TRACKER_REHEARSAL_WEBHOOK_SECRET_too_short"
  [[ -n "$DEVICE_IDS" ]] || fail "TRACKER_REHEARSAL_DEVICE_IDS_required"
  require_integer "TRACKER_REHEARSAL_USERS_PER_STAGE" "$USERS_PER_STAGE"
  (( USERS_PER_STAGE >= 1 && USERS_PER_STAGE <= 2000 )) || fail "TRACKER_REHEARSAL_USERS_PER_STAGE_out_of_range"
  require_integer "TRACKER_REHEARSAL_SPAWN_RATE" "$SPAWN_RATE"
  (( SPAWN_RATE >= 1 && SPAWN_RATE <= 200 )) || fail "TRACKER_REHEARSAL_SPAWN_RATE_out_of_range"
  require_integer "TRACKER_EXPECTED_POOLERS" "$EXPECTED_POOLERS"
  [[ "$EXPECTED_POOLERS" == "4" ]] || fail "this_rehearsal_requires_exactly_four_poolers"
  require_integer "TRACKER_TOTAL_BACKEND_BUDGET" "$TOTAL_TRACKER_BACKEND_BUDGET"
  [[ "$TOTAL_TRACKER_BACKEND_BUDGET" == "80" ]] || fail "this_rehearsal_requires_the_declared_80_session_budget"
  require_integer "TRACKER_NON_TRACKER_CONNECTION_BUDGET" "$NON_TRACKER_CONNECTION_BUDGET"
  require_integer "TRACKER_MAINTENANCE_CONNECTION_BUDGET" "$MAINTENANCE_CONNECTION_BUDGET"
  require_integer "TRACKER_OPERATIONAL_CONNECTION_RESERVE" "$OPERATIONAL_CONNECTION_RESERVE"
  require_duration "TRACKER_REHEARSAL_WARMUP_DURATION" "$WARMUP_DURATION"
  require_duration "TRACKER_REHEARSAL_STEADY_DURATION" "$STEADY_DURATION"
  require_duration "TRACKER_REHEARSAL_RECOVERY_DURATION" "$RECOVERY_DURATION"
  command -v kubectl >/dev/null || fail "kubectl_required"
  command -v curl >/dev/null || fail "curl_required"
  command -v psql >/dev/null || fail "psql_required"
  command -v locust >/dev/null || fail "locust_required_install_requirements_testing_locust"
  command -v python3 >/dev/null || fail "python3_required"
  [[ -f "$LOCUST_FILE" ]] || fail "locustfile_missing"
  [[ -x "$QUERY_ASSERT" ]] || fail "prometheus_assertion_helper_missing_or_not_executable"
  [[ -x "$HEADROOM_GATE" ]] || fail "headroom_gate_missing_or_not_executable"
  [[ -x "$PGBOUNCER_CAP_TEST" ]] || fail "pgbouncer_cap_test_missing_or_not_executable"
  [[ "$RUN_PGBOUNCER_CAP_TEST" == "true" || "$RUN_PGBOUNCER_CAP_TEST" == "false" ]] || fail "TRACKER_REHEARSAL_RUN_PGBOUNCER_CAP_TEST_must_be_true_or_false"
  if [[ "$RUN_PGBOUNCER_CAP_TEST" == "true" ]]; then
    [[ -n "${TRACKER_REHEARSAL_PGBOUNCER_URLS:-}" ]] || fail "TRACKER_REHEARSAL_PGBOUNCER_URLS_required_for_cap_test"
  fi
}

K=()
ORIGINAL_HPA_MIN=""
ORIGINAL_HPA_MAX=""
RESTORE_HPA="false"

restore_hpa() {
  if [[ "$RESTORE_HPA" != "true" ]]; then
    return
  fi
  kubectl --context "$KUBE_CONTEXT" -n "$TRACKER_NAMESPACE" patch hpa vehicle-tracker-ingest --type merge \
    -p "{\"spec\":{\"minReplicas\":${ORIGINAL_HPA_MIN},\"maxReplicas\":${ORIGINAL_HPA_MAX}}}" \
    >"$RESULT_DIR/hpa-restore.json" 2>"$RESULT_DIR/hpa-restore.stderr" || true
}
trap restore_hpa EXIT

query_prometheus() {
  local label="$1"
  local promql="$2"
  local stage_dir="$3"
  local output="$stage_dir/prometheus-${label}.json"
  curl --fail --silent --show-error --get "$PROMETHEUS_URL/api/v1/query" \
    --data-urlencode "query=${promql}" >"$output"
  printf '%s\n' "$output"
}

assert_prometheus() {
  local label="$1"
  local promql="$2"
  local operator="$3"
  local threshold="$4"
  local samples="$5"
  local stage_dir="$6"
  local response
  response="$(query_prometheus "$label" "$promql" "$stage_dir")"
  python3 "$QUERY_ASSERT" --input "$response" --operator "$operator" --threshold "$threshold" \
    --expected-samples "$samples" --label "$label" | tee -a "$stage_dir/prometheus-checks.txt"
}

wait_for_ready_workers() {
  local expected="$1"
  local deadline=$((SECONDS + 600))
  while (( SECONDS < deadline )); do
    local available desired
    available="$("${K[@]}" get deployment vehicle-tracker-ingest -o jsonpath='{.status.availableReplicas}')"
    desired="$("${K[@]}" get deployment vehicle-tracker-ingest -o jsonpath='{.status.replicas}')"
    if [[ "$available" == "$expected" && "$desired" == "$expected" ]]; then
      return 0
    fi
    sleep 5
  done
  fail "workers_not_ready_at_stage_${expected}"
}

check_postgres_admission() {
  local max_connections reserve required
  max_connections="$(psql "$DATABASE_URL" -X -Atqc 'SHOW max_connections')"
  reserve="$(psql "$DATABASE_URL" -X -Atqc 'SHOW superuser_reserved_connections')"
  require_integer "postgres_max_connections" "$max_connections"
  require_integer "postgres_superuser_reserved_connections" "$reserve"
  required=$((TOTAL_TRACKER_BACKEND_BUDGET + NON_TRACKER_CONNECTION_BUDGET + MAINTENANCE_CONNECTION_BUDGET + OPERATIONAL_CONNECTION_RESERVE + reserve))
  if (( max_connections < required )); then
    fail "postgres_max_connections_${max_connections}_below_required_${required}"
  fi
  printf 'postgres_admission=PASS max_connections=%s superuser_reserved=%s tracker_budget=%s non_tracker=%s maintenance=%s operational_reserve=%s required=%s\n' \
    "$max_connections" "$reserve" "$TOTAL_TRACKER_BACKEND_BUDGET" "$NON_TRACKER_CONNECTION_BUDGET" "$MAINTENANCE_CONNECTION_BUDGET" "$OPERATIONAL_CONNECTION_RESERVE" "$required" \
    | tee "$RESULT_DIR/postgres-admission.txt"
}

capture_cluster_state() {
  local stage_dir="$1"
  "${K[@]}" get deployment vehicle-tracker-ingest -o yaml >"$stage_dir/tracker-ingest-deployment.yaml"
  "${K[@]}" get deployment vehicle-tracker-pgbouncer -o yaml >"$stage_dir/tracker-pgbouncer-deployment.yaml"
  "${K[@]}" get hpa vehicle-tracker-ingest -o yaml >"$stage_dir/tracker-ingest-hpa.yaml"
  "${K[@]}" get pods -l app.kubernetes.io/name=vehicle-tracker-ingest -o wide >"$stage_dir/tracker-ingest-pods.txt"
  "${K[@]}" get pods -l app.kubernetes.io/name=vehicle-tracker-pgbouncer -o wide >"$stage_dir/tracker-pgbouncer-pods.txt"
}

run_locust() {
  local stage="$1"
  local phase="$2"
  local duration="$3"
  local stage_dir="$4"
  local phase_run_id="${RUN_ID}-${stage}-${phase}"
  local csv_prefix="$stage_dir/locust-${phase}"

  TRACKER_REHEARSAL_RUN_ID="$phase_run_id" \
  TRACKER_REHEARSAL_INTEGRATION_KEY="$INTEGRATION_KEY" \
  TRACKER_REHEARSAL_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
  TRACKER_REHEARSAL_DEVICE_IDS="$DEVICE_IDS" \
  locust --headless --host "$INGRESS_URL" -f "$LOCUST_FILE" \
    --users "$USERS_PER_STAGE" --spawn-rate "$SPAWN_RATE" --run-time "$duration" \
    --csv "$csv_prefix" --csv-full-history --exit-code-on-error 1 \
    >"$stage_dir/locust-${phase}.log" 2>&1

  local requested durable duplicate_events
  requested="$(awk -F'[ =]' '/vehicle_tracker_locust_summary/ {for (i=1; i<=NF; i++) if ($i ~ /^requests=/) {sub(/^requests=/,"",$i); print $i}}' "$stage_dir/locust-${phase}.log" | tail -n 1)"
  [[ "$requested" =~ ^[1-9][0-9]*$ ]] || fail "locust_did_not_report_requests_stage_${stage}_${phase}"
  durable="$(psql "$DATABASE_URL" -X -Atqc "SELECT count(*) FROM vehicle_access.vehicle_tracker_signal WHERE external_event_id LIKE '${phase_run_id}-%'")"
  duplicate_events="$(psql "$DATABASE_URL" -X -Atqc "SELECT count(*) - count(DISTINCT external_event_id) FROM vehicle_access.vehicle_tracker_signal WHERE external_event_id LIKE '${phase_run_id}-%'")"
  [[ "$durable" == "$requested" ]] || fail "durable_event_mismatch_stage_${stage}_${phase}_requested_${requested}_durable_${durable}"
  [[ "$duplicate_events" == "0" ]] || fail "duplicate_durable_event_ids_stage_${stage}_${phase}"
  printf 'locust_phase=PASS stage=%s phase=%s requested=%s durable=%s run_id=%s\n' \
    "$stage" "$phase" "$requested" "$durable" "$phase_run_id" | tee -a "$stage_dir/summary.txt"
}

run_stage() {
  local stage="$1"
  [[ "$stage" =~ ^(16|32|48|64)$ ]] || fail "stages_must_be_exactly_from_16_32_48_64"
  local stage_dir="$RESULT_DIR/stage-${stage}"
  mkdir -p "$stage_dir"

  "${K[@]}" patch hpa vehicle-tracker-ingest --type merge \
    -p "{\"spec\":{\"minReplicas\":${stage},\"maxReplicas\":${stage}}}" >"$stage_dir/hpa-freeze.json"
  wait_for_ready_workers "$stage"
  capture_cluster_state "$stage_dir"

  ALLOW_NON_PRODUCTION_TRACKER_REHEARSAL=yes \
  TEST_CLUSTER_CONTEXT="$KUBE_CONTEXT" \
  TRACKER_REHEARSAL_NAMESPACE="$TRACKER_NAMESPACE" \
  TEST_PROMETHEUS_URL="$PROMETHEUS_URL" \
  TRACKER_EXPECTED_POOLERS="$EXPECTED_POOLERS" \
  TRACKER_MAX_BACKEND_CONNECTIONS=48 \
  TRACKER_MAX_CLIENT_WAITING=0 \
  TRACKER_MAX_OLDEST_WAIT_SECONDS=0.5 \
  TRACKER_REHEARSAL_RESULT_DIR="$stage_dir" \
  "$HEADROOM_GATE"

  run_locust "$stage" warmup "$WARMUP_DURATION" "$stage_dir"
  run_locust "$stage" steady "$STEADY_DURATION" "$stage_dir"

  assert_prometheus pooler_count "count(pgbouncer_up{namespace=\"${TRACKER_NAMESPACE}\",service=\"vehicle-tracker-pgbouncer\"})" eq "$EXPECTED_POOLERS" 1 "$stage_dir"
  assert_prometheus exporter_health "min(pgbouncer_up{namespace=\"${TRACKER_NAMESPACE}\",service=\"vehicle-tracker-pgbouncer\"})" eq 1 1 "$stage_dir"
  assert_prometheus backend_budget "sum(vehicle_tracker_pgbouncer_server_connections{namespace=\"${TRACKER_NAMESPACE}\"})" le "$TOTAL_TRACKER_BACKEND_BUDGET" 1 "$stage_dir"

  sleep "$RECOVERY_DURATION"
  assert_prometheus recovery_queue "sum(pgbouncer_pools_client_waiting_connections{namespace=\"${TRACKER_NAMESPACE}\",service=\"vehicle-tracker-pgbouncer\"})" eq 0 1 "$stage_dir"
  assert_prometheus recovery_wait "max(pgbouncer_pools_client_maxwait_seconds{namespace=\"${TRACKER_NAMESPACE}\",service=\"vehicle-tracker-pgbouncer\"})" le 0.5 1 "$stage_dir"
  capture_cluster_state "$stage_dir"
  printf 'stage=PASS workers=%s warmup=%s steady=%s recovery=%s\n' \
    "$stage" "$WARMUP_DURATION" "$STEADY_DURATION" "$RECOVERY_DURATION" | tee -a "$stage_dir/summary.txt"
}

validate_test_only_environment
mkdir -p "$RESULT_DIR"
: >"$RESULT_DIR/rehearsal.log"
K=(kubectl --context "$KUBE_CONTEXT" -n "$TRACKER_NAMESPACE")
cluster_server="$(kubectl --context "$KUBE_CONTEXT" config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
[[ "$cluster_server" != *"production"* && "$cluster_server" != *"prod."* ]] || fail "cluster_server_looks_production"

"${K[@]}" get deployment vehicle-tracker-ingest >/dev/null
"${K[@]}" get deployment vehicle-tracker-pgbouncer >/dev/null
ORIGINAL_HPA_MIN="$("${K[@]}" get hpa vehicle-tracker-ingest -o jsonpath='{.spec.minReplicas}')"
ORIGINAL_HPA_MAX="$("${K[@]}" get hpa vehicle-tracker-ingest -o jsonpath='{.spec.maxReplicas}')"
require_integer "original_hpa_min" "$ORIGINAL_HPA_MIN"
require_integer "original_hpa_max" "$ORIGINAL_HPA_MAX"
RESTORE_HPA="true"

check_postgres_admission
if [[ "$RUN_PGBOUNCER_CAP_TEST" == "true" ]]; then
  ALLOW_NON_PRODUCTION_TRACKER_REHEARSAL=yes \
  TEST_PROMETHEUS_URL="$PROMETHEUS_URL" \
  TRACKER_REHEARSAL_NAMESPACE="$TRACKER_NAMESPACE" \
  TRACKER_REHEARSAL_RESULT_DIR="$RESULT_DIR" \
  TRACKER_REHEARSAL_PGBOUNCER_URLS="$TRACKER_REHEARSAL_PGBOUNCER_URLS" \
  "$PGBOUNCER_CAP_TEST"
fi
for stage in $STAGES; do
  run_stage "$stage"
done

printf 'vehicle_tracker_multipod_rehearsal=PASS run_id=%s stages="%s" result_dir=%s\n' \
  "$RUN_ID" "$STAGES" "$RESULT_DIR" | tee "$RESULT_DIR/summary.txt"
