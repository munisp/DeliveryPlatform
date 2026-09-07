#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NAMESPACE="${RESILIENCE_TEST_NAMESPACE:-resilience-test}"
EXPECTED_CONTEXT="${RESILIENCE_TEST_CONTEXT:?RESILIENCE_TEST_CONTEXT must name the exact non-production kubectl context}"
TARGET_ENV="${TARGET_ENV:-staging}"
ACTION="${1:?usage: $0 open|half-open|close}"
INCIDENT_ID="${INCIDENT_ID:?INCIDENT_ID must identify the anomaly or approved recovery}"
CIRCUIT_BREAKER_NAME="resilience-validation-circuit-breaker"
TESTRUN_NAME="ride-payment-ingress"
POD_CHAOS_MANIFEST="$ROOT/deploy/kubernetes/resilience-test/chaos-mesh/matching-worker-pod-kill.yaml"
TOXIPROXY_RUNNER="$ROOT/scripts/testing/resilience/toxiproxy-payment-faults.sh"
APPROVAL_VERIFIER="$ROOT/scripts/testing/resilience/verify-signed-recovery-approval.py"

BREAKER_STATE=""
BREAKER_RESOURCE_VERSION=""
BREAKER_INCIDENT_ID=""
VERIFIED_APPROVAL_ID=""
VERIFIED_APPROVAL_KEY_ID=""
VERIFIED_APPROVAL_DIGEST=""
VERIFIED_APPROVAL_AT=""

if [[ "${TARGET_ENV}" == "test" && "${LOCAL_RESILIENCE_TEST:-}" == "true" ]]; then
  KUBECTL=(kubectl)
else
  RESILIENCE_OPERATOR_KUBECONFIG="${RESILIENCE_OPERATOR_KUBECONFIG:?RESILIENCE_OPERATOR_KUBECONFIG must contain the dedicated operator identity outside local tests}"
  [[ -f "$RESILIENCE_OPERATOR_KUBECONFIG" ]] || { printf 'circuit-breaker operation refused: RESILIENCE_OPERATOR_KUBECONFIG is unreadable\n' >&2; exit 1; }
  KUBECTL=(kubectl --kubeconfig "$RESILIENCE_OPERATOR_KUBECONFIG")
fi

fail() {
  printf 'circuit-breaker operation refused: %s\n' "$*" >&2
  exit 1
}

require_identifier() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$ ]] || fail "$name must be 3-81 characters using letters, digits, dot, underscore, or hyphen"
}

require_context_and_namespace() {
  [[ "$TARGET_ENV" == "test" || "$TARGET_ENV" == "staging" || "$TARGET_ENV" == "preproduction" ]] || fail "TARGET_ENV must be test, staging, or preproduction"
  local current_context namespace_label
  current_context="$("${KUBECTL[@]}" config current-context)"
  [[ "$current_context" == "$EXPECTED_CONTEXT" ]] || fail "refusing context $current_context; expected exact non-production context $EXPECTED_CONTEXT"
  namespace_label="$("${KUBECTL[@]}" get namespace "$NAMESPACE" -o jsonpath='{.metadata.labels.resilience\.delivery-platform\.io/environment}' 2>/dev/null || true)"
  [[ "$namespace_label" == "non-production" ]] || fail "namespace $NAMESPACE must have resilience.delivery-platform.io/environment=non-production"
}

read_breaker_snapshot() {
  local snapshot
  snapshot="$("${KUBECTL[@]}" -n "$NAMESPACE" get configmap "$CIRCUIT_BREAKER_NAME" -o jsonpath='{.metadata.resourceVersion}{"\t"}{.data.state}{"\t"}{.data.incident_id}' 2>/dev/null || true)"
  [[ -n "$snapshot" && "$snapshot" == *$'\t'* ]] || fail "breaker ConfigMap is missing or unreadable"
  IFS=$'\t' read -r BREAKER_RESOURCE_VERSION BREAKER_STATE BREAKER_INCIDENT_ID <<< "$snapshot"
  [[ "$BREAKER_RESOURCE_VERSION" =~ ^[0-9]+$ ]] || fail "breaker resourceVersion is missing or invalid"
  case "$BREAKER_STATE" in
    closed|open|half_open) ;;
    *) fail "breaker state is missing or unsupported: ${BREAKER_STATE:-empty}" ;;
  esac
}

patch_breaker() {
  local expected_state="$1" next_state="$2" extra_operations="$3" expected_incident="${4:-}"
  local patch incident_test=""
  read_breaker_snapshot
  [[ "$BREAKER_STATE" == "$expected_state" ]] || fail "expected breaker state $expected_state; current state is $BREAKER_STATE"
  if [[ -n "$expected_incident" ]]; then
    [[ "$BREAKER_INCIDENT_ID" == "$expected_incident" ]] || fail "breaker incident_id changed before transition"
    incident_test=",{\"op\":\"test\",\"path\":\"/data/incident_id\",\"value\":\"${expected_incident}\"}"
  fi
  patch="[{\"op\":\"test\",\"path\":\"/metadata/resourceVersion\",\"value\":\"${BREAKER_RESOURCE_VERSION}\"},{\"op\":\"test\",\"path\":\"/data/state\",\"value\":\"${expected_state}\"}${incident_test},{\"op\":\"replace\",\"path\":\"/data/state\",\"value\":\"${next_state}\"}${extra_operations}]"
  if ! "${KUBECTL[@]}" -n "$NAMESPACE" patch configmap "$CIRCUIT_BREAKER_NAME" --type json -p "$patch" >/dev/null; then
    fail "optimistic transition ${expected_state}->${next_state} conflicted or was rejected; re-read state and retry only after a new operator decision"
  fi
  read_breaker_snapshot
  [[ "$BREAKER_STATE" == "$next_state" ]] || fail "post-patch state verification failed; expected $next_state, got $BREAKER_STATE"
}

require_current_incident() {
  read_breaker_snapshot
  [[ "$BREAKER_INCIDENT_ID" == "$INCIDENT_ID" ]] || fail "breaker incident_id does not match the requested incident"
}

verify_recovery_approval() {
  local required_action="$1" evidence_id="$2" approval_url="$3"
  local -a verifier_args
  local result
  [[ -x "$APPROVAL_VERIFIER" ]] || fail "signed approval verifier is missing or not executable"
  [[ -n "$approval_url" ]] || fail "a signed recovery approval URL is required"
  [[ -n "${RECOVERY_APPROVAL_PUBLIC_KEY_FILE:-}" ]] || fail "RECOVERY_APPROVAL_PUBLIC_KEY_FILE is required"
  RECOVERY_APPROVAL_KEY_ID="${RECOVERY_APPROVAL_KEY_ID:?RECOVERY_APPROVAL_KEY_ID must identify the approved signing key}"
  require_identifier RECOVERY_APPROVAL_KEY_ID "$RECOVERY_APPROVAL_KEY_ID"
  verifier_args=(
    --url "$approval_url"
    --public-key "$RECOVERY_APPROVAL_PUBLIC_KEY_FILE"
    --expected-key-id "$RECOVERY_APPROVAL_KEY_ID"
    --incident-id "$INCIDENT_ID"
    --recovery-evidence-id "$evidence_id"
    --environment "$TARGET_ENV"
    --namespace "$NAMESPACE"
    --breaker-name "$CIRCUIT_BREAKER_NAME"
    --required-action "$required_action"
  )
  if [[ "$TARGET_ENV" == "test" && "${LOCAL_RESILIENCE_TEST:-}" == "true" && "$approval_url" == file://* ]]; then
    verifier_args+=(--allow-local-file)
  else
    [[ -n "${RECOVERY_APPROVAL_CA_FILE:-}" ]] || fail "RECOVERY_APPROVAL_CA_FILE is required for HTTPS approval lookup"
    verifier_args+=(--ca-file "$RECOVERY_APPROVAL_CA_FILE")
  fi
  result="$(python3 "$APPROVAL_VERIFIER" "${verifier_args[@]}")" || fail "signed recovery approval verification failed"
  IFS=$'\t' read -r VERIFIED_APPROVAL_ID VERIFIED_APPROVAL_KEY_ID VERIFIED_APPROVAL_DIGEST VERIFIED_APPROVAL_AT <<< "$result"
  require_identifier VERIFIED_APPROVAL_ID "$VERIFIED_APPROVAL_ID"
  require_identifier VERIFIED_APPROVAL_KEY_ID "$VERIFIED_APPROVAL_KEY_ID"
  [[ "$VERIFIED_APPROVAL_DIGEST" =~ ^[a-f0-9]{64}$ ]] || fail "approval verifier returned an invalid payload digest"
  [[ "$VERIFIED_APPROVAL_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || fail "approval verifier returned an invalid timestamp"
}

approval_patch_operations() {
  local evidence_id="$1" now="$2"
  printf ',{"op":"replace","path":"/data/recovery_evidence_id","value":"%s"},{"op":"replace","path":"/data/approval_id","value":"%s"},{"op":"replace","path":"/data/approval_key_id","value":"%s"},{"op":"replace","path":"/data/approval_verified_at","value":"%s"},{"op":"replace","path":"/data/approval_payload_sha256","value":"%s"}' \
    "$evidence_id" "$VERIFIED_APPROVAL_ID" "$VERIFIED_APPROVAL_KEY_ID" "$VERIFIED_APPROVAL_AT" "$VERIFIED_APPROVAL_DIGEST"
}

clear_known_faults() {
  local cleanup_failed=0
  "${KUBECTL[@]}" -n "$NAMESPACE" delete "testrun/${TESTRUN_NAME}" --ignore-not-found --wait=false || cleanup_failed=1
  "${KUBECTL[@]}" -n "$NAMESPACE" delete -f "$POD_CHAOS_MANIFEST" --ignore-not-found || cleanup_failed=1
  if [[ -n "${PROVIDER_SIMULATOR_UPSTREAM:-}" ]]; then
    CONFIRM_NON_PRODUCTION_GATEWAY_FAULTS=run \
      RESILIENCE_TEST_CONTEXT="$EXPECTED_CONTEXT" \
      TARGET_ENV="$TARGET_ENV" \
      RESILIENCE_TEST_NAMESPACE="$NAMESPACE" \
      PROVIDER_SIMULATOR_UPSTREAM="$PROVIDER_SIMULATOR_UPSTREAM" \
      "$TOXIPROXY_RUNNER" clear || cleanup_failed=1
  fi
  [[ "$cleanup_failed" == "0" ]] || fail "breaker is open but TestRun, PodChaos, or Toxiproxy cleanup failed; preserve evidence and remediate manually"
}

require_identifier INCIDENT_ID "$INCIDENT_ID"
require_context_and_namespace

case "$ACTION" in
  open)
    CIRCUIT_REASON="${CIRCUIT_REASON:?CIRCUIT_REASON must be one of invariant-probe-failure, alerted-financial-anomaly, unexpected-egress, assignment-anomaly, provider-queue-anomaly, cleanup-failure, or operator-stop}"
    [[ "${CONFIRM_CIRCUIT_BREAKER_ACTION:-}" == "open:${INCIDENT_ID}" ]] || fail "set CONFIRM_CIRCUIT_BREAKER_ACTION=open:${INCIDENT_ID} to open the circuit breaker"
    case "$CIRCUIT_REASON" in
      invariant-probe-failure|alerted-financial-anomaly|unexpected-egress|assignment-anomaly|provider-queue-anomaly|cleanup-failure|operator-stop) ;;
      *) fail "unsupported circuit-breaker reason: $CIRCUIT_REASON" ;;
    esac
    read_breaker_snapshot
    if [[ "$BREAKER_STATE" == "open" ]]; then
      printf 'circuit breaker is already open; no state mutation was performed.\n'
      exit 0
    fi
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    patch_breaker "$BREAKER_STATE" "open" ",{\"op\":\"add\",\"path\":\"/data/incident_id\",\"value\":\"${INCIDENT_ID}\"},{\"op\":\"add\",\"path\":\"/data/opened_at\",\"value\":\"${now}\"},{\"op\":\"add\",\"path\":\"/data/opened_by\",\"value\":\"staging-resilience-operator\"},{\"op\":\"add\",\"path\":\"/data/reason\",\"value\":\"${CIRCUIT_REASON}\"},{\"op\":\"add\",\"path\":\"/data/recovery_evidence_id\",\"value\":\"\"},{\"op\":\"add\",\"path\":\"/data/half_opened_at\",\"value\":\"\"},{\"op\":\"add\",\"path\":\"/data/half_opened_by\",\"value\":\"\"},{\"op\":\"add\",\"path\":\"/data/half_open_evidence_id\",\"value\":\"\"},{\"op\":\"add\",\"path\":\"/data/approval_id\",\"value\":\"\"},{\"op\":\"add\",\"path\":\"/data/approval_key_id\",\"value\":\"\"},{\"op\":\"add\",\"path\":\"/data/approval_verified_at\",\"value\":\"\"},{\"op\":\"add\",\"path\":\"/data/approval_payload_sha256\",\"value\":\"\"},{\"op\":\"add\",\"path\":\"/data/closed_at\",\"value\":\"\"},{\"op\":\"add\",\"path\":\"/data/closed_by\",\"value\":\"\"}"
    clear_known_faults
    printf 'circuit breaker is open; known test faults were cleared and cleanup was verified. Preserve artifacts and begin incident handling.\n'
    ;;
  half-open)
    HALF_OPEN_EVIDENCE_ID="${HALF_OPEN_EVIDENCE_ID:?HALF_OPEN_EVIDENCE_ID must reference reviewed pre-validation evidence}"
    HALF_OPEN_APPROVAL_URL="${HALF_OPEN_APPROVAL_URL:?HALF_OPEN_APPROVAL_URL must reference a signed operator approval}"
    [[ "${CONFIRM_CIRCUIT_BREAKER_ACTION:-}" == "half-open:${INCIDENT_ID}" ]] || fail "set CONFIRM_CIRCUIT_BREAKER_ACTION=half-open:${INCIDENT_ID} after explicit recovery approval"
    require_identifier HALF_OPEN_EVIDENCE_ID "$HALF_OPEN_EVIDENCE_ID"
    require_current_incident
    verify_recovery_approval half_open "$HALF_OPEN_EVIDENCE_ID" "$HALF_OPEN_APPROVAL_URL"
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    patch_breaker "open" "half_open" ",{\"op\":\"add\",\"path\":\"/data/half_opened_at\",\"value\":\"${now}\"},{\"op\":\"add\",\"path\":\"/data/half_opened_by\",\"value\":\"staging-resilience-operator\"},{\"op\":\"add\",\"path\":\"/data/half_open_evidence_id\",\"value\":\"${HALF_OPEN_EVIDENCE_ID}\"}$(approval_patch_operations "$HALF_OPEN_EVIDENCE_ID" "$now")" "$INCIDENT_ID"
    printf 'circuit breaker is half_open. Run exactly one approved bounded validation; any critical alert re-opens the breaker.\n'
    ;;
  close)
    RECOVERY_EVIDENCE_ID="${RECOVERY_EVIDENCE_ID:?RECOVERY_EVIDENCE_ID must reference reviewed recovery evidence}"
    CLOSE_APPROVAL_URL="${CLOSE_APPROVAL_URL:?CLOSE_APPROVAL_URL must reference a signed close approval}"
    [[ "${CONFIRM_CIRCUIT_BREAKER_ACTION:-}" == "close:${INCIDENT_ID}" ]] || fail "set CONFIRM_CIRCUIT_BREAKER_ACTION=close:${INCIDENT_ID} after explicit recovery approval"
    require_identifier RECOVERY_EVIDENCE_ID "$RECOVERY_EVIDENCE_ID"
    require_current_incident
    verify_recovery_approval close "$RECOVERY_EVIDENCE_ID" "$CLOSE_APPROVAL_URL"
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    patch_breaker "half_open" "closed" ",{\"op\":\"add\",\"path\":\"/data/recovery_evidence_id\",\"value\":\"${RECOVERY_EVIDENCE_ID}\"},{\"op\":\"add\",\"path\":\"/data/closed_at\",\"value\":\"${now}\"},{\"op\":\"add\",\"path\":\"/data/closed_by\",\"value\":\"staging-resilience-operator\"},{\"op\":\"add\",\"path\":\"/data/reason\",\"value\":\"recovery-approved\"}$(approval_patch_operations "$RECOVERY_EVIDENCE_ID" "$now")" "$INCIDENT_ID"
    printf 'circuit breaker is closed following signed recovery approval. This does not authorize a new scenario without its own change approval.\n'
    ;;
  *)
    fail "usage: $0 {open|half-open|close}"
    ;;
esac
