#!/usr/bin/env bash
set -euo pipefail

EXPECTED_CONTEXT="kind-deliveryplatform-ci"
CONFIRMATION="${CONFIRM_LOCAL_KIND_MOCK_MONITORING:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MANIFEST="$ROOT/deploy/kubernetes/resilience-test/local-kind-mock-monitoring.yaml"

if [[ "$(kubectl config current-context)" != "$EXPECTED_CONTEXT" ]]; then
  echo "refusing: current context must be $EXPECTED_CONTEXT" >&2
  exit 2
fi
if [[ "$CONFIRMATION" != "true" ]]; then
  echo "refusing: set CONFIRM_LOCAL_KIND_MOCK_MONITORING=true" >&2
  exit 2
fi
if [[ ! -f "$MANIFEST" ]]; then
  echo "missing local mock monitoring manifest" >&2
  exit 2
fi

kubectl apply -f "$MANIFEST"
kubectl wait --for=condition=Established crd/servicemonitors.monitoring.coreos.com --timeout=60s
kubectl wait --for=condition=Established crd/prometheusrules.monitoring.coreos.com --timeout=60s
kubectl wait --for=condition=Established crd/alertmanagerconfigs.monitoring.coreos.com --timeout=60s
kubectl -n monitoring rollout status deployment/mock-monitoring-controller --timeout=90s
printf '%s\n' 'LOCAL_KIND_MOCK_MONITORING_READY=true'
