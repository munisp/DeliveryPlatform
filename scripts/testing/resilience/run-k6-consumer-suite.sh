#!/usr/bin/env bash
set -euo pipefail

# P5-SCALE consumer-path k6 suite runner.
# Mirrors run-k6-ride-payment-ingress.sh env-gate discipline: refuses to run
# unless every non-production guard passes, then launches the three consumer
# TestRuns (checkout ingress, catalog read, ride request) via the k6 operator.
# SLO budget and evidence convention: validation/consumer_scale_baseline_20261112.md.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NAMESPACE="${RESILIENCE_TEST_NAMESPACE:-resilience-test}"
EXPECTED_CONTEXT="${RESILIENCE_TEST_CONTEXT:?RESILIENCE_TEST_CONTEXT must name the exact non-production kubectl context}"
TARGET_ENV="${TARGET_ENV:-staging}"
CONSUMER_BASE_URL="${CONSUMER_BASE_URL:?CONSUMER_BASE_URL must be an HTTPS non-production ingress URL serving /api/trpc}"
RUN_ID="${RUN_ID:-consumer-scale-$(date -u +%Y%m%dT%H%M%SZ)}"
SECRET_NAME="${RESILIENCE_K6_SECRET_NAME:-resilience-k6-credentials}"
VERTICAL_ID="${VERTICAL_ID:-1}"
PROVIDER_ID="${PROVIDER_ID:-1}"
CHECKOUT_RATE_PER_SECOND="${CHECKOUT_RATE_PER_SECOND:-20}"
CHECKOUT_DURATION="${CHECKOUT_DURATION:-15m}"
READ_RATE_PER_SECOND="${READ_RATE_PER_SECOND:-60}"
READ_DURATION="${READ_DURATION:-15m}"
RIDE_REQUEST_RATE_PER_SECOND="${RIDE_REQUEST_RATE_PER_SECOND:-15}"
RIDE_READ_RATE_PER_SECOND="${RIDE_READ_RATE_PER_SECOND:-30}"
RIDE_DURATION="${RIDE_DURATION:-15m}"
PRE_ALLOCATED_VUS="${PRE_ALLOCATED_VUS:-30}"
MAX_VUS="${MAX_VUS:-150}"
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
require_non_production_url "$CONSUMER_BASE_URL"
require_positive_integer VERTICAL_ID "$VERTICAL_ID"
require_positive_integer PROVIDER_ID "$PROVIDER_ID"
require_positive_integer CHECKOUT_RATE_PER_SECOND "$CHECKOUT_RATE_PER_SECOND"
require_positive_integer READ_RATE_PER_SECOND "$READ_RATE_PER_SECOND"
require_positive_integer RIDE_REQUEST_RATE_PER_SECOND "$RIDE_REQUEST_RATE_PER_SECOND"
require_positive_integer RIDE_READ_RATE_PER_SECOND "$RIDE_READ_RATE_PER_SECOND"
require_positive_integer PRE_ALLOCATED_VUS "$PRE_ALLOCATED_VUS"
require_positive_integer MAX_VUS "$MAX_VUS"
require_duration CHECKOUT_DURATION "$CHECKOUT_DURATION"
require_duration READ_DURATION "$READ_DURATION"
require_duration RIDE_DURATION "$RIDE_DURATION"

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
# consumer-session-token: a test-only consumer account session token (accepted
# as a bearer credential by server/_core/auth.ts). Never a production user.
kubectl -n "$NAMESPACE" get secret "$SECRET_NAME" -o "jsonpath={.data.consumer-session-token}" | grep -q . || {
  printf 'required key consumer-session-token is absent from the test-only secret %s\n' "$SECRET_NAME" >&2
  exit 1
}

mkdir -p "$ARTIFACT_DIR"
printf '%s\n' "$RUN_ID" >"$ARTIFACT_DIR/run_id.txt"
kubectl config view --minify -o jsonpath='{.current-context}' >"$ARTIFACT_DIR/kubernetes_context.txt"

kubectl -n "$NAMESPACE" apply -f "$ROOT/deploy/kubernetes/resilience-test/k6/k6-runner-service-account.yaml"
kubectl -n "$NAMESPACE" create configmap consumer-suite-scripts \
  --from-file=consumer_checkout_ingress.js="$ROOT/deploy/kubernetes/resilience-test/k6/consumer_checkout_ingress.js" \
  --from-file=consumer_catalog_read.js="$ROOT/deploy/kubernetes/resilience-test/k6/consumer_catalog_read.js" \
  --from-file=consumer_ride_request.js="$ROOT/deploy/kubernetes/resilience-test/k6/consumer_ride_request.js" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NAMESPACE" create configmap resilience-k6-consumer-run-config \
  --from-literal=TARGET_ENV="$TARGET_ENV" \
  --from-literal=CONSUMER_BASE_URL="$CONSUMER_BASE_URL" \
  --from-literal=RUN_ID="$RUN_ID" \
  --from-literal=VERTICAL_ID="$VERTICAL_ID" \
  --from-literal=PROVIDER_ID="$PROVIDER_ID" \
  --from-literal=CHECKOUT_RATE_PER_SECOND="$CHECKOUT_RATE_PER_SECOND" \
  --from-literal=CHECKOUT_DURATION="$CHECKOUT_DURATION" \
  --from-literal=READ_RATE_PER_SECOND="$READ_RATE_PER_SECOND" \
  --from-literal=READ_DURATION="$READ_DURATION" \
  --from-literal=RIDE_REQUEST_RATE_PER_SECOND="$RIDE_REQUEST_RATE_PER_SECOND" \
  --from-literal=RIDE_READ_RATE_PER_SECOND="$RIDE_READ_RATE_PER_SECOND" \
  --from-literal=RIDE_DURATION="$RIDE_DURATION" \
  --from-literal=PRE_ALLOCATED_VUS="$PRE_ALLOCATED_VUS" \
  --from-literal=MAX_VUS="$MAX_VUS" \
  --dry-run=client -o yaml | kubectl apply -f -

render_testrun() {
  local name="$1" script_file="$2"
  cat <<EOF
apiVersion: k6.io/v1alpha1
kind: TestRun
metadata:
  name: ${name}
  namespace: ${NAMESPACE}
  labels:
    app.kubernetes.io/name: ${name}
    app.kubernetes.io/part-of: delivery-platform-resilience-testing
    resilience.delivery-platform.io/environment: non-production
spec:
  parallelism: 3
  separate: true
  script:
    configMap:
      name: consumer-suite-scripts
      file: ${script_file}
  runner:
    serviceAccountName: resilience-k6-runner
    env:
      - name: TARGET_ENV
        valueFrom:
          configMapKeyRef:
            name: resilience-k6-consumer-run-config
            key: TARGET_ENV
      - name: CONSUMER_BASE_URL
        valueFrom:
          configMapKeyRef:
            name: resilience-k6-consumer-run-config
            key: CONSUMER_BASE_URL
      - name: RUN_ID
        valueFrom:
          configMapKeyRef:
            name: resilience-k6-consumer-run-config
            key: RUN_ID
      - name: VERTICAL_ID
        valueFrom:
          configMapKeyRef:
            name: resilience-k6-consumer-run-config
            key: VERTICAL_ID
      - name: PROVIDER_ID
        valueFrom:
          configMapKeyRef:
            name: resilience-k6-consumer-run-config
            key: PROVIDER_ID
      - name: CHECKOUT_RATE_PER_SECOND
        valueFrom:
          configMapKeyRef:
            name: resilience-k6-consumer-run-config
            key: CHECKOUT_RATE_PER_SECOND
      - name: CHECKOUT_DURATION
        valueFrom:
          configMapKeyRef:
            name: resilience-k6-consumer-run-config
            key: CHECKOUT_DURATION
      - name: READ_RATE_PER_SECOND
        valueFrom:
          configMapKeyRef:
            name: resilience-k6-consumer-run-config
            key: READ_RATE_PER_SECOND
      - name: READ_DURATION
        valueFrom:
          configMapKeyRef:
            name: resilience-k6-consumer-run-config
            key: READ_DURATION
      - name: RIDE_REQUEST_RATE_PER_SECOND
        valueFrom:
          configMapKeyRef:
            name: resilience-k6-consumer-run-config
            key: RIDE_REQUEST_RATE_PER_SECOND
      - name: RIDE_READ_RATE_PER_SECOND
        valueFrom:
          configMapKeyRef:
            name: resilience-k6-consumer-run-config
            key: RIDE_READ_RATE_PER_SECOND
      - name: RIDE_DURATION
        valueFrom:
          configMapKeyRef:
            name: resilience-k6-consumer-run-config
            key: RIDE_DURATION
      - name: PRE_ALLOCATED_VUS
        valueFrom:
          configMapKeyRef:
            name: resilience-k6-consumer-run-config
            key: PRE_ALLOCATED_VUS
      - name: MAX_VUS
        valueFrom:
          configMapKeyRef:
            name: resilience-k6-consumer-run-config
            key: MAX_VUS
      - name: CONSUMER_SESSION_TOKEN
        valueFrom:
          secretKeyRef:
            name: ${SECRET_NAME}
            key: consumer-session-token
    resources:
      requests:
        cpu: "500m"
        memory: "512Mi"
      limits:
        cpu: "2"
        memory: "2Gi"
EOF
}

for pair in \
  consumer-checkout-ingress:consumer_checkout_ingress.js \
  consumer-catalog-read:consumer_catalog_read.js \
  consumer-ride-request:consumer_ride_request.js; do
  name="${pair%%:*}"
  script_file="${pair##*:}"
  kubectl -n "$NAMESPACE" delete testrun "$name" --ignore-not-found --wait=true
  render_testrun "$name" "$script_file" | kubectl -n "$NAMESPACE" apply -f -
  kubectl -n "$NAMESPACE" get testrun "$name" -o yaml >"$ARTIFACT_DIR/testrun_${name}.yaml"
done

cat <<EOF
Started consumer suite TestRuns (consumer-checkout-ingress, consumer-catalog-read, consumer-ride-request) in namespace ${NAMESPACE} with run ID ${RUN_ID}.
Do not treat this as passed until all runner pods have completed and the observed percentiles are recorded in validation/consumer_scale_baseline_20261112.md.
Suggested observation commands:
  kubectl -n ${NAMESPACE} get testrun,pods,jobs -w
  kubectl -n ${NAMESPACE} get events --sort-by=.metadata.creationTimestamp
Artifact directory: ${ARTIFACT_DIR}
EOF
