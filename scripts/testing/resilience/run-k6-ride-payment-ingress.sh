#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NAMESPACE="${RESILIENCE_TEST_NAMESPACE:-resilience-test}"
EXPECTED_CONTEXT="${RESILIENCE_TEST_CONTEXT:?RESILIENCE_TEST_CONTEXT must name the exact non-production kubectl context}"
TARGET_ENV="${TARGET_ENV:-staging}"
MATCHING_BASE_URL="${MATCHING_BASE_URL:?MATCHING_BASE_URL must be an HTTPS non-production ingress URL}"
PAYMENT_BASE_URL="${PAYMENT_BASE_URL:?PAYMENT_BASE_URL must be an HTTPS non-production ingress URL}"
RUN_ID="${RUN_ID:-resilience-$(date -u +%Y%m%dT%H%M%SZ)}"
SECRET_NAME="${RESILIENCE_K6_SECRET_NAME:-resilience-k6-credentials}"
MATCH_RATE_PER_SECOND="${MATCH_RATE_PER_SECOND:-80}"
MATCH_DURATION="${MATCH_DURATION:-15m}"
PAYMENT_RATE_PER_SECOND="${PAYMENT_RATE_PER_SECOND:-10}"
PAYMENT_DURATION="${PAYMENT_DURATION:-15m}"
PRE_ALLOCATED_VUS="${PRE_ALLOCATED_VUS:-50}"
MAX_VUS="${MAX_VUS:-250}"
TRIP_ID_PREFIX="${TRIP_ID_PREFIX:-30000000-0000-0000-0000-}"
PAYMENT_REFERENCE_PREFIX="${PAYMENT_REFERENCE_PREFIX:-peak-payment-}"
PAYMENT_EVENT_PREFIX="${PAYMENT_EVENT_PREFIX:-k6-payment-event-}"
TRIP_OFFSET="${TRIP_OFFSET:-1}"
PAYMENT_OFFSET="${PAYMENT_OFFSET:-1}"
ARTIFACT_DIR="${ARTIFACT_DIR:-$ROOT/validation/resilience_runs/$RUN_ID}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || { printf 'missing required command: %s\n' "$1" >&2; exit 1; }
}

require_non_production_url() {
  local url="$1"
  [[ "$url" =~ ^https:// ]] || { printf 'endpoint must use HTTPS: %s\n' "$url" >&2; exit 1; }
  [[ ! "$url" =~ (^|[./-])(prod|production)([./:-]|$) ]] || { printf 'refusing production-like endpoint: %s\n' "$url" >&2; exit 1; }
}

require_positive_integer() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || { printf '%s must be a positive integer\n' "$name" >&2; exit 1; }
}

require_duration() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[1-9][0-9]*[smh]$ ]] || { printf '%s must use a whole-number s, m, or h duration\n' "$name" >&2; exit 1; }
}

require_command kubectl
[[ "${CONFIRM_NON_PRODUCTION_RESILIENCE_TESTS:-}" == "run" ]] || {
  printf 'set CONFIRM_NON_PRODUCTION_RESILIENCE_TESTS=run to start an isolated resilience test\n' >&2
  exit 1
}
[[ "$TARGET_ENV" == "test" || "$TARGET_ENV" == "staging" || "$TARGET_ENV" == "preproduction" ]] || {
  printf 'TARGET_ENV must be test, staging, or preproduction\n' >&2
  exit 1
}
require_non_production_url "$MATCHING_BASE_URL"
require_non_production_url "$PAYMENT_BASE_URL"
require_positive_integer MATCH_RATE_PER_SECOND "$MATCH_RATE_PER_SECOND"
require_positive_integer PAYMENT_RATE_PER_SECOND "$PAYMENT_RATE_PER_SECOND"
require_positive_integer PRE_ALLOCATED_VUS "$PRE_ALLOCATED_VUS"
require_positive_integer MAX_VUS "$MAX_VUS"
require_positive_integer TRIP_OFFSET "$TRIP_OFFSET"
require_positive_integer PAYMENT_OFFSET "$PAYMENT_OFFSET"
require_duration MATCH_DURATION "$MATCH_DURATION"
require_duration PAYMENT_DURATION "$PAYMENT_DURATION"

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

kubectl api-resources --api-group=k6.io -o name | grep -qx 'testruns' || {
  printf 'k6 Operator TestRun CRD is not installed in context %s\n' "$current_context" >&2
  exit 1
}

kubectl -n "$NAMESPACE" get secret "$SECRET_NAME" >/dev/null
for key in internal-service-token payment-webhook-secret; do
  kubectl -n "$NAMESPACE" get secret "$SECRET_NAME" -o "jsonpath={.data.${key}}" | grep -q . || {
    printf 'required key %s is absent from the test-only secret %s\n' "$key" "$SECRET_NAME" >&2
    exit 1
  }
done

mkdir -p "$ARTIFACT_DIR"
printf '%s\n' "$RUN_ID" >"$ARTIFACT_DIR/run_id.txt"
kubectl config view --minify -o jsonpath='{.current-context}' >"$ARTIFACT_DIR/kubernetes_context.txt"

kubectl -n "$NAMESPACE" apply -f "$ROOT/deploy/kubernetes/resilience-test/k6/k6-runner-service-account.yaml"
kubectl -n "$NAMESPACE" create configmap ride-payment-ingress-script \
  --from-file=ride_payment_ingress.js="$ROOT/deploy/kubernetes/resilience-test/k6/ride_payment_ingress.js" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NAMESPACE" create configmap resilience-k6-run-config \
  --from-literal=TARGET_ENV="$TARGET_ENV" \
  --from-literal=MATCHING_BASE_URL="$MATCHING_BASE_URL" \
  --from-literal=PAYMENT_BASE_URL="$PAYMENT_BASE_URL" \
  --from-literal=RUN_ID="$RUN_ID" \
  --from-literal=TRIP_ID_PREFIX="$TRIP_ID_PREFIX" \
  --from-literal=PAYMENT_REFERENCE_PREFIX="$PAYMENT_REFERENCE_PREFIX" \
  --from-literal=PAYMENT_EVENT_PREFIX="$PAYMENT_EVENT_PREFIX" \
  --from-literal=TRIP_OFFSET="$TRIP_OFFSET" \
  --from-literal=PAYMENT_OFFSET="$PAYMENT_OFFSET" \
  --from-literal=MATCH_RATE_PER_SECOND="$MATCH_RATE_PER_SECOND" \
  --from-literal=MATCH_DURATION="$MATCH_DURATION" \
  --from-literal=PAYMENT_RATE_PER_SECOND="$PAYMENT_RATE_PER_SECOND" \
  --from-literal=PAYMENT_DURATION="$PAYMENT_DURATION" \
  --from-literal=PRE_ALLOCATED_VUS="$PRE_ALLOCATED_VUS" \
  --from-literal=MAX_VUS="$MAX_VUS" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$NAMESPACE" delete testrun ride-payment-ingress --ignore-not-found --wait=true
kubectl -n "$NAMESPACE" apply -f "$ROOT/deploy/kubernetes/resilience-test/k6/ride-payment-ingress-testrun.yaml"
kubectl -n "$NAMESPACE" get testrun ride-payment-ingress -o yaml >"$ARTIFACT_DIR/testrun_created.yaml"

cat <<EOF
Started TestRun ride-payment-ingress in namespace ${NAMESPACE} with run ID ${RUN_ID}.
Do not treat this as passed until all runner pods have completed and the PostgreSQL invariant/queue-drain probe succeeds.
Suggested observation commands:
  kubectl -n ${NAMESPACE} get testrun,pods,jobs -w
  kubectl -n ${NAMESPACE} get events --sort-by=.metadata.creationTimestamp
Artifact directory: ${ARTIFACT_DIR}
EOF
