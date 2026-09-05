#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NAMESPACE="${RESILIENCE_TEST_NAMESPACE:-resilience-test}"
EXPECTED_CONTEXT="${RESILIENCE_TEST_CONTEXT:?RESILIENCE_TEST_CONTEXT must name the exact non-production kubectl context}"
TARGET_ENV="${TARGET_ENV:-staging}"
SCENARIO="${SCENARIO:?SCENARIO must be one of baseline, gateway-latency, gateway-timeout, gateway-reset, gateway-outage, or matching-worker-pod-kill}"
CHANGE_ID="${CHANGE_ID:?CHANGE_ID must identify the approved staging-chaos change}"
RUN_ID="${RUN_ID:-chaos-$(date -u +%Y%m%dT%H%M%SZ)}"
ARTIFACT_DIR="${ARTIFACT_DIR:-$ROOT/validation/resilience_runs/$RUN_ID}"
TESTRUN_NAME="ride-payment-ingress"
TESTRUN_TIMEOUT_SECONDS="${TESTRUN_TIMEOUT_SECONDS:-1500}"
MIN_MATCHING_REPLICAS="${MIN_MATCHING_REPLICAS:-3}"
TOXIPROXY_LATENCY_MS="${TOXIPROXY_LATENCY_MS:-300}"
TOXIPROXY_JITTER_MS="${TOXIPROXY_JITTER_MS:-100}"
TOXIPROXY_TIMEOUT_MS="${TOXIPROXY_TIMEOUT_MS:-1000}"

K6_RUNNER="$ROOT/scripts/testing/resilience/run-k6-ride-payment-ingress.sh"
TOXIPROXY_RUNNER="$ROOT/scripts/testing/resilience/toxiproxy-payment-faults.sh"
POD_CHAOS_MANIFEST="$ROOT/deploy/kubernetes/resilience-test/chaos-mesh/matching-worker-pod-kill.yaml"
INVARIANT_PROBE_SQL="$ROOT/deploy/kubernetes/resilience-test/invariant-probe.sql"
INVARIANT_PROBE_TEMPLATE="$ROOT/deploy/kubernetes/resilience-test/invariant-probe-job.yaml"
MATCHING_DEPLOYMENT="${MATCHING_DEPLOYMENT:-ride-matching-worker}"
safe_run_id="$(printf '%s' "$RUN_ID" | tr '[:upper:]_' '[:lower:]-' | tr -cd 'a-z0-9-' | cut -c1-32)"
INVARIANT_PROBE_JOB="resilience-invariant-${safe_run_id}"
CIRCUIT_BREAKER_NAME="resilience-validation-circuit-breaker"
circuit_breaker_armed=false
proxy_fault_active=false
pod_chaos_active=false
pod_chaos_injected=false

require_command() {
  command -v "$1" >/dev/null 2>&1 || { printf 'missing required command: %s\n' "$1" >&2; exit 1; }
}

require_positive_integer() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || { printf '%s must be a positive integer\n' "$name" >&2; exit 1; }
}

require_safe_identifier() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$ ]] || { printf '%s must be 3-81 characters using letters, digits, dot, underscore, or hyphen\n' "$name" >&2; exit 1; }
}

open_circuit_breaker() {
  local reason="$1"
  kubectl -n "$NAMESPACE" patch configmap "$CIRCUIT_BREAKER_NAME" --type merge \
    -p "{\"data\":{\"state\":\"open\",\"incident_id\":\"${CHANGE_ID}\",\"opened_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"opened_by\":\"staging-chaos-controller\",\"reason\":\"${reason}\"}}" >/dev/null
  printf 'circuit breaker opened: reason=%s change=%s\n' "$reason" "$CHANGE_ID" >&2
}

collect_artifacts() {
  local result="$1"
  mkdir -p "$ARTIFACT_DIR"
  printf '%s\n' "$RUN_ID" >"$ARTIFACT_DIR/run_id.txt"
  printf '%s\n' "$SCENARIO" >"$ARTIFACT_DIR/scenario.txt"
  printf '%s\n' "$CHANGE_ID" >"$ARTIFACT_DIR/change_id.txt"
  printf '%s\n' "$result" >"$ARTIFACT_DIR/result.txt"
  kubectl config current-context >"$ARTIFACT_DIR/kubernetes_context.txt" 2>/dev/null || true
  kubectl -n "$NAMESPACE" get testrun "$TESTRUN_NAME" -o yaml >"$ARTIFACT_DIR/testrun.yaml" 2>/dev/null || true
  kubectl -n "$NAMESPACE" get pods,jobs,events -o yaml >"$ARTIFACT_DIR/kubernetes_resources.yaml" 2>/dev/null || true
  kubectl -n "$NAMESPACE" get podchaos resilience-matching-worker-pod-kill -o yaml >"$ARTIFACT_DIR/podchaos.yaml" 2>/dev/null || true
}

capture_pre_cleanup_state() {
  mkdir -p "$ARTIFACT_DIR"
  kubectl -n "$NAMESPACE" get testrun "$TESTRUN_NAME" -o yaml >"$ARTIFACT_DIR/testrun_before_cleanup.yaml" 2>/dev/null || true
  kubectl -n "$NAMESPACE" get podchaos resilience-matching-worker-pod-kill -o yaml >"$ARTIFACT_DIR/podchaos_before_cleanup.yaml" 2>/dev/null || true
}

stop_active_test_run() {
  kubectl -n "$NAMESPACE" delete "testrun/${TESTRUN_NAME}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}

clear_active_faults() {
  local cleanup_failed=0
  if [[ "$pod_chaos_active" == true ]]; then
    if kubectl -n "$NAMESPACE" delete -f "$POD_CHAOS_MANIFEST" --ignore-not-found >/dev/null 2>&1; then
      pod_chaos_active=false
    else
      cleanup_failed=1
    fi
  fi
  if [[ "$proxy_fault_active" == true ]]; then
    if CONFIRM_NON_PRODUCTION_GATEWAY_FAULTS=run \
      RESILIENCE_TEST_CONTEXT="$EXPECTED_CONTEXT" \
      TARGET_ENV="$TARGET_ENV" \
      RESILIENCE_TEST_NAMESPACE="$NAMESPACE" \
      PROVIDER_SIMULATOR_UPSTREAM="${PROVIDER_SIMULATOR_UPSTREAM:-}" \
      "$TOXIPROXY_RUNNER" clear >/dev/null 2>&1; then
      proxy_fault_active=false
    else
      cleanup_failed=1
    fi
  fi
  return "$cleanup_failed"
}

cleanup() {
  local exit_code=$? cleanup_exit_code=0
  set +e
  if [[ $exit_code -ne 0 ]]; then
    capture_pre_cleanup_state
    stop_active_test_run
  fi
  clear_active_faults
  cleanup_exit_code=$?
  if [[ "$circuit_breaker_armed" == true && ( $exit_code -ne 0 || $cleanup_exit_code -ne 0 ) ]]; then
    open_circuit_breaker "scenario-or-cleanup-failure"
  fi
  if [[ $exit_code -ne 0 || $cleanup_exit_code -ne 0 ]]; then
    collect_artifacts "failed"
  fi
  if [[ $exit_code -eq 0 && $cleanup_exit_code -ne 0 ]]; then
    exit_code=$cleanup_exit_code
  fi
  exit "$exit_code"
}
trap cleanup EXIT

require_command kubectl
require_positive_integer TESTRUN_TIMEOUT_SECONDS "$TESTRUN_TIMEOUT_SECONDS"
require_positive_integer MIN_MATCHING_REPLICAS "$MIN_MATCHING_REPLICAS"
require_safe_identifier CHANGE_ID "$CHANGE_ID"
require_safe_identifier RUN_ID "$RUN_ID"
[[ "${CONFIRM_APPROVED_STAGING_CHAOS:-}" == "${SCENARIO}:${CHANGE_ID}" ]] || {
  printf 'set CONFIRM_APPROVED_STAGING_CHAOS=%s:%s after change approval to run this fixed scenario\n' "$SCENARIO" "$CHANGE_ID" >&2
  exit 1
}
[[ "$TARGET_ENV" == "test" || "$TARGET_ENV" == "staging" || "$TARGET_ENV" == "preproduction" ]] || {
  printf 'TARGET_ENV must be test, staging, or preproduction\n' >&2
  exit 1
}
current_context="$(kubectl config current-context)"
[[ "$current_context" == "$EXPECTED_CONTEXT" ]] || {
  printf 'refusing context %s; expected exact non-production context %s\n' "$current_context" "$EXPECTED_CONTEXT" >&2
  exit 1
}
namespace_label="$(kubectl get namespace "$NAMESPACE" -o jsonpath='{.metadata.labels.resilience\.delivery-platform\.io/environment}' 2>/dev/null || true)"
[[ "$namespace_label" == "non-production" ]] || {
  printf 'namespace %s must have resilience.delivery-platform.io/environment=non-production\n' "$NAMESPACE" >&2
  exit 1
}
circuit_breaker_state="$(kubectl -n "$NAMESPACE" get configmap "$CIRCUIT_BREAKER_NAME" -o jsonpath='{.data.state}' 2>/dev/null || true)"
[[ "$circuit_breaker_state" == "closed" ]] || {
  printf 'resilience circuit breaker is not closed (state=%s); investigate and obtain explicit close approval before another run\n' "${circuit_breaker_state:-missing}" >&2
  exit 1
}

case "$SCENARIO" in
  baseline|gateway-latency|gateway-timeout|gateway-reset|gateway-outage|matching-worker-pod-kill) ;;
  *)
    printf 'unsupported scenario: %s\n' "$SCENARIO" >&2
    exit 1
    ;;
esac

if [[ "$SCENARIO" == "matching-worker-pod-kill" ]]; then
  test -s "$POD_CHAOS_MANIFEST" || { printf 'missing fixed PodChaos manifest\n' >&2; exit 1; }
  kubectl get crd podchaos.chaos-mesh.org >/dev/null
  ready_matching_pods="$(kubectl -n "$NAMESPACE" get pods -l 'app.kubernetes.io/name=ride-matching-worker,app.kubernetes.io/part-of=deliveryplatform-resilience-testing' --field-selector=status.phase=Running -o name | wc -l | tr -d ' ')"
  [[ "$ready_matching_pods" -ge "$MIN_MATCHING_REPLICAS" ]] || {
    printf 'matching-worker pod-kill requires at least %s running labelled resilience replicas; found %s\n' "$MIN_MATCHING_REPLICAS" "$ready_matching_pods" >&2
    exit 1
  }
fi

if [[ "$SCENARIO" == gateway-* ]]; then
  test -n "${PROVIDER_SIMULATOR_UPSTREAM:-}" || { printf 'PROVIDER_SIMULATOR_UPSTREAM is required for gateway fault scenarios\n' >&2; exit 1; }
  toxiproxy_env=(
    CONFIRM_NON_PRODUCTION_GATEWAY_FAULTS=run
    RESILIENCE_TEST_CONTEXT="$EXPECTED_CONTEXT"
    TARGET_ENV="$TARGET_ENV"
    RESILIENCE_TEST_NAMESPACE="$NAMESPACE"
    PROVIDER_SIMULATOR_UPSTREAM="$PROVIDER_SIMULATOR_UPSTREAM"
  )
fi

circuit_breaker_armed=true
if [[ "$SCENARIO" == gateway-* ]]; then
  case "$SCENARIO" in
    gateway-latency) env "${toxiproxy_env[@]}" "$TOXIPROXY_RUNNER" latency "$TOXIPROXY_LATENCY_MS" "$TOXIPROXY_JITTER_MS" ;;
    gateway-timeout) env "${toxiproxy_env[@]}" "$TOXIPROXY_RUNNER" timeout "$TOXIPROXY_TIMEOUT_MS" ;;
    gateway-reset) env "${toxiproxy_env[@]}" "$TOXIPROXY_RUNNER" reset 0 ;;
    gateway-outage) env "${toxiproxy_env[@]}" "$TOXIPROXY_RUNNER" down ;;
  esac
  proxy_fault_active=true
fi

mkdir -p "$ARTIFACT_DIR"
CONFIRM_NON_PRODUCTION_RESILIENCE_TESTS=run \
  RESILIENCE_TEST_CONTEXT="$EXPECTED_CONTEXT" \
  RESILIENCE_TEST_NAMESPACE="$NAMESPACE" \
  TARGET_ENV="$TARGET_ENV" \
  RUN_ID="$RUN_ID" \
  ARTIFACT_DIR="$ARTIFACT_DIR" \
  "$K6_RUNNER"

started_epoch="$(date +%s)"
while true; do
  stage="$(kubectl -n "$NAMESPACE" get testrun "$TESTRUN_NAME" -o jsonpath='{.status.stage}' 2>/dev/null || true)"
  case "$stage" in
    started)
      if [[ "$SCENARIO" == "matching-worker-pod-kill" && "$pod_chaos_injected" == false ]]; then
        kubectl -n "$NAMESPACE" apply -f "$POD_CHAOS_MANIFEST"
        pod_chaos_active=true
        pod_chaos_injected=true
      fi
      ;;
    finished)
      if [[ "$SCENARIO" == "matching-worker-pod-kill" && "$pod_chaos_injected" == false ]]; then
        collect_artifacts "k6-finished-before-pod-chaos-injection"
        printf 'k6 TestRun finished before the required pod-chaos injection\n' >&2
        exit 1
      fi
      collect_artifacts "k6-finished-awaiting-invariant-probe"
      break
      ;;
    error|stopped)
      collect_artifacts "k6-${stage}"
      printf 'k6 TestRun reached terminal stage %s\n' "$stage" >&2
      exit 1
      ;;
    '')
      printf 'k6 TestRun status is unavailable\n' >&2
      exit 1
      ;;
  esac
  if (( $(date +%s) - started_epoch > TESTRUN_TIMEOUT_SECONDS )); then
    printf 'k6 TestRun did not finish within %s seconds; last stage=%s\n' "$TESTRUN_TIMEOUT_SECONDS" "$stage" >&2
    exit 1
  fi
  sleep 5
done

clear_active_faults
if [[ "$SCENARIO" == "matching-worker-pod-kill" ]]; then
  kubectl -n "$NAMESPACE" rollout status "deployment/${MATCHING_DEPLOYMENT}" --timeout=5m
fi

test -s "$INVARIANT_PROBE_SQL" || { printf 'missing invariant probe SQL: %s\n' "$INVARIANT_PROBE_SQL" >&2; exit 1; }
test -s "$INVARIANT_PROBE_TEMPLATE" || { printf 'missing invariant probe Job template: %s\n' "$INVARIANT_PROBE_TEMPLATE" >&2; exit 1; }
kubectl -n "$NAMESPACE" create configmap resilience-invariant-probe-sql \
  --from-file=invariant-probe.sql="$INVARIANT_PROBE_SQL" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NAMESPACE" delete "job/${INVARIANT_PROBE_JOB}" --ignore-not-found --wait=true
sed "s/RESILIENCE_INVARIANT_PROBE_JOB_NAME/${INVARIANT_PROBE_JOB}/g" "$INVARIANT_PROBE_TEMPLATE" | kubectl -n "$NAMESPACE" apply -f -
kubectl -n "$NAMESPACE" wait --for=condition=complete "job/${INVARIANT_PROBE_JOB}" --timeout=35m
kubectl -n "$NAMESPACE" logs "job/${INVARIANT_PROBE_JOB}" >"$ARTIFACT_DIR/invariant_probe.log"
collect_artifacts "passed"
printf 'staging-chaos validation completed: run=%s scenario=%s change=%s artifacts=%s\n' "$RUN_ID" "$SCENARIO" "$CHANGE_ID" "$ARTIFACT_DIR"
