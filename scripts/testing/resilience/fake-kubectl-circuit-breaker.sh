#!/usr/bin/env bash
set -euo pipefail

: "${FAKE_KUBECTL_STATE_DIR:?FAKE_KUBECTL_STATE_DIR is required}"
mkdir -p "$FAKE_KUBECTL_STATE_DIR"
printf '%q ' "$@" >>"$FAKE_KUBECTL_STATE_DIR/commands.log"
printf '\n' >>"$FAKE_KUBECTL_STATE_DIR/commands.log"

state_file="$FAKE_KUBECTL_STATE_DIR/circuit-state"
resource_version_file="$FAKE_KUBECTL_STATE_DIR/circuit-resource-version"
incident_file="$FAKE_KUBECTL_STATE_DIR/circuit-incident-id"
test -f "$state_file" || printf '%s' 'closed' >"$state_file"
test -f "$resource_version_file" || printf '%s' '1' >"$resource_version_file"
test -f "$incident_file" || : >"$incident_file"

if [[ "${1:-}" == "config" && "${2:-}" == "current-context" ]]; then
  printf '%s\n' 'delivery-staging-resilience-simulated'
  exit 0
fi

args=" $* "
if [[ "$args" == *" get namespace resilience-test "* ]]; then
  printf '%s' 'non-production'
  exit 0
fi

if [[ "$args" == *" get configmap resilience-validation-circuit-breaker "* ]]; then
  if [[ "$args" == *".metadata.resourceVersion"* ]]; then
    printf '%s\t%s\t%s' "$(cat "$resource_version_file")" "$(cat "$state_file")" "$(cat "$incident_file")"
  else
    cat "$state_file"
  fi
  exit 0
fi

if [[ "$args" == *" patch configmap resilience-validation-circuit-breaker "* ]]; then
  payload=""
  previous=""
  for argument in "$@"; do
    if [[ "$previous" == "-p" ]]; then
      payload="$argument"
      break
    fi
    previous="$argument"
  done
  [[ -n "$payload" ]] || { printf 'missing simulated JSON patch payload\n' >&2; exit 1; }
  python3 - "$payload" "$state_file" "$resource_version_file" "$incident_file" <<'PY'
import json
import sys
from pathlib import Path

patch = json.loads(sys.argv[1])
state_path, resource_path, incident_path = map(Path, sys.argv[2:])
state = state_path.read_text()
resource_version = resource_path.read_text()
incident = incident_path.read_text()
values = {
    "/metadata/resourceVersion": resource_version,
    "/data/state": state,
    "/data/incident_id": incident,
}
for operation in patch:
    if operation.get("op") == "test" and values.get(operation.get("path")) != operation.get("value"):
        raise SystemExit(1)
next_state = state
next_incident = incident
for operation in patch:
    if operation.get("op") in {"add", "replace"}:
        if operation.get("path") == "/data/state":
            next_state = operation["value"]
        if operation.get("path") == "/data/incident_id":
            next_incident = operation["value"]
if next_state not in {"closed", "open", "half_open"}:
    raise SystemExit(1)
state_path.write_text(next_state)
incident_path.write_text(next_incident)
resource_path.write_text(str(int(resource_version) + 1))
PY
  printf '%s\n' "$payload" >>"$FAKE_KUBECTL_STATE_DIR/circuit-patches.log"
  exit 0
fi

if [[ "$args" == *" delete testrun/ride-payment-ingress "* ]]; then
  printf '%s\n' 'testrun-delete-requested' >>"$FAKE_KUBECTL_STATE_DIR/actions.log"
  exit 0
fi

if [[ "$args" == *" delete -f "*"matching-worker-pod-kill.yaml"* ]]; then
  printf '%s\n' 'podchaos-delete-requested' >>"$FAKE_KUBECTL_STATE_DIR/actions.log"
  exit 0
fi

printf 'unsupported fake kubectl command: %s\n' "$*" >&2
exit 1
