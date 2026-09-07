#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUN_ID="${RUN_ID:-circuit-drill-$(date -u +%Y%m%dT%H%M%SZ)}"
ARTIFACT_DIR="${ARTIFACT_DIR:-$ROOT/validation/resilience_incident_drills/$RUN_ID}"
FAKE_KUBECTL_SOURCE="$ROOT/scripts/testing/resilience/fake-kubectl-circuit-breaker.sh"
FAKE_CURL_SOURCE="$ROOT/scripts/testing/resilience/fake-curl-circuit-breaker.sh"
CIRCUIT_MANAGER="$ROOT/scripts/testing/resilience/manage-staging-resilience-circuit-breaker.sh"
CHAOS_CONTROLLER="$ROOT/scripts/testing/resilience/run-staging-chaos-validation.sh"
STATE_DIR="$(mktemp -d)"
BIN_DIR="$STATE_DIR/bin"
PRIVATE_KEY="$STATE_DIR/recovery-private.pem"
PUBLIC_KEY="$STATE_DIR/recovery-public.pem"

cleanup() {
  rm -rf "$STATE_DIR"
}
trap cleanup EXIT

for required_file in "$FAKE_KUBECTL_SOURCE" "$FAKE_CURL_SOURCE" "$CIRCUIT_MANAGER" "$CHAOS_CONTROLLER"; do
  test -x "$required_file" || { printf 'missing executable drill dependency: %s\n' "$required_file" >&2; exit 1; }
done

mkdir -p "$BIN_DIR" "$ARTIFACT_DIR"
cp "$FAKE_KUBECTL_SOURCE" "$BIN_DIR/kubectl"
cp "$FAKE_CURL_SOURCE" "$BIN_DIR/curl"
chmod 0755 "$BIN_DIR/kubectl" "$BIN_DIR/curl"
printf '%s' 'closed' >"$STATE_DIR/circuit-state"
printf '%s' '1' >"$STATE_DIR/circuit-resource-version"
: >"$STATE_DIR/circuit-incident-id"
openssl genpkey -algorithm ED25519 -out "$PRIVATE_KEY" >/dev/null 2>&1
openssl pkey -in "$PRIVATE_KEY" -pubout -out "$PUBLIC_KEY" >/dev/null 2>&1

create_approval() {
  local action="$1"
  local evidence_id="$2"
  local approval_id="$3"
  local payload="$STATE_DIR/${action}-payload.json"
  local signature="$STATE_DIR/${action}-signature.bin"
  local envelope="$STATE_DIR/${action}-approval.json"
  python3 - "$action" "$evidence_id" "$approval_id" "$payload" <<'PY'
import datetime as dt
import json
import sys

action, evidence_id, approval_id, output = sys.argv[1:]
now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
payload = {
    "action": action,
    "approval_id": approval_id,
    "breaker_name": "resilience-validation-circuit-breaker",
    "environment": "test",
    "expires_at": (now + dt.timedelta(minutes=15)).isoformat().replace("+00:00", "Z"),
    "incident_id": "INC-SIM-20260903-001",
    "issued_at": now.isoformat().replace("+00:00", "Z"),
    "namespace": "resilience-test",
    "purpose": "resilience-circuit-breaker-recovery",
    "recovery_evidence_id": evidence_id,
}
with open(output, "w", encoding="utf-8") as handle:
    handle.write(json.dumps(payload, sort_keys=True, separators=(",", ":")))
PY
  openssl pkeyutl -sign -inkey "$PRIVATE_KEY" -rawin -in "$payload" -out "$signature"
  python3 - "$payload" "$signature" "$envelope" <<'PY'
import base64
import json
import sys

payload, signature, output = sys.argv[1:]
envelope = {
    "key_id": "local-drill-ed25519-1",
    "payload_b64": base64.b64encode(open(payload, "rb").read()).decode(),
    "signature_algorithm": "ed25519",
    "signature_b64": base64.b64encode(open(signature, "rb").read()).decode(),
}
with open(output, "w", encoding="utf-8") as handle:
    json.dump(envelope, handle, separators=(",", ":"))
PY
  printf 'file://%s' "$envelope"
}

base_env=(
  PATH="$BIN_DIR:$PATH"
  FAKE_KUBECTL_STATE_DIR="$STATE_DIR"
  RESILIENCE_TEST_CONTEXT=delivery-staging-resilience-simulated
  RESILIENCE_TEST_NAMESPACE=resilience-test
  TARGET_ENV=test
  LOCAL_RESILIENCE_TEST=true
  INCIDENT_ID=INC-SIM-20260903-001
  RECOVERY_APPROVAL_PUBLIC_KEY_FILE="$PUBLIC_KEY"
  RECOVERY_APPROVAL_KEY_ID=local-drill-ed25519-1
  PROVIDER_SIMULATOR_UPSTREAM=provider-simulator.resilience-test.svc.cluster.local:8080
)

env "${base_env[@]}" \
  CIRCUIT_REASON=assignment-anomaly \
  CONFIRM_CIRCUIT_BREAKER_ACTION=open:INC-SIM-20260903-001 \
  "$CIRCUIT_MANAGER" open >"$ARTIFACT_DIR/open.txt" 2>&1

test "$(cat "$STATE_DIR/circuit-state")" = "open"
grep -qx 'testrun-delete-requested' "$STATE_DIR/actions.log"
grep -qx 'podchaos-delete-requested' "$STATE_DIR/actions.log"
grep -Fq '/proxies/payment-provider/toxics' "$STATE_DIR/curl-commands.log"

set +e
env "${base_env[@]}" \
  SCENARIO=baseline \
  CHANGE_ID=CHG-SIM-20260903-001 \
  RUN_ID=chaos-sim-20260903-001 \
  CONFIRM_APPROVED_STAGING_CHAOS=baseline:CHG-SIM-20260903-001 \
  "$CHAOS_CONTROLLER" >"$ARTIFACT_DIR/new-run-blocked.txt" 2>&1
blocked_rc=$?
set -e

test "$blocked_rc" -ne 0
grep -Fq 'resilience circuit breaker is not closed' "$ARTIFACT_DIR/new-run-blocked.txt"

half_open_approval="$(create_approval half_open EV-SIM-HALF-OPEN-001 APPROVAL-SIM-HALF-OPEN-001)"
env "${base_env[@]}" \
  HALF_OPEN_EVIDENCE_ID=EV-SIM-HALF-OPEN-001 \
  HALF_OPEN_APPROVAL_URL="$half_open_approval" \
  CONFIRM_CIRCUIT_BREAKER_ACTION=half-open:INC-SIM-20260903-001 \
  "$CIRCUIT_MANAGER" half-open >"$ARTIFACT_DIR/half-open.txt" 2>&1

test "$(cat "$STATE_DIR/circuit-state")" = "half_open"

close_approval="$(create_approval close EV-SIM-CLOSE-001 APPROVAL-SIM-CLOSE-001)"
env "${base_env[@]}" \
  RECOVERY_EVIDENCE_ID=EV-SIM-CLOSE-001 \
  CLOSE_APPROVAL_URL="$close_approval" \
  CONFIRM_CIRCUIT_BREAKER_ACTION=close:INC-SIM-20260903-001 \
  "$CIRCUIT_MANAGER" close >"$ARTIFACT_DIR/close.txt" 2>&1

test "$(cat "$STATE_DIR/circuit-state")" = "closed"
cp "$STATE_DIR/commands.log" "$ARTIFACT_DIR/simulated_control_plane_commands.log"
cp "$STATE_DIR/circuit-patches.log" "$ARTIFACT_DIR/simulated_circuit_patches.log"
cp "$STATE_DIR/actions.log" "$ARTIFACT_DIR/simulated_cleanup_actions.log"
cp "$STATE_DIR/curl-commands.log" "$ARTIFACT_DIR/simulated_proxy_cleanup_calls.log"

cat >"$ARTIFACT_DIR/summary.md" <<'EOF'
# Simulated Circuit-Breaker Incident Drill

**Run ID:** Recorded in the containing resilience incident-drill artifact directory.  
**Execution type:** Local non-network simulation using checked-in fake `kubectl`/`curl` fixtures and an ephemeral Ed25519 key.  
**Simulated anomaly:** `assignment-anomaly`  
**Result:** PASS — this proves local control-flow guardrails only; it is not a staging chaos result or recovery approval.

| Drill step | Observed result |
|---|---|
| Open circuit | The guarded command recorded the fixed incident reason and transitioned the simulated ConfigMap from `closed` to `open` using a resource-version JSON Patch test. |
| Immediate stop | The simulated control plane recorded TestRun deletion and PodChaos deletion requests. |
| Gateway cleanup | The simulated proxy client recorded the Toxiproxy toxic-clear call. |
| Future-run prevention | A simulated approved baseline controller invocation was refused because the circuit state was `open`. |
| Signed half-open | A synthetic Ed25519 approval bound to the incident, evidence, namespace, breaker, and `half_open` action transitioned only the temporary state to `half_open`. |
| Signed closure | A distinct synthetic Ed25519 approval bound to the `close` action and separate evidence transitioned only the temporary state to `closed`. |
| Network isolation | Every Kubernetes and proxy command resolved to local fake executables. No cluster, DNS, HTTP endpoint, payment provider, or production system was contacted. |

> The synthetic approvals and recovery evidence in this drill have no operational authority. A real circuit transition requires a dedicated operator identity, reviewed staging evidence, an HTTPS approval service, and human approval under the rollback runbook.
EOF

printf 'CIRCUIT_BREAKER_INCIDENT_DRILL=PASS artifacts=%s\n' "$ARTIFACT_DIR"
