#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ARTIFACT_DIR="${ARTIFACT_DIR:-$ROOT/validation/staging_monitoring_render_$(date -u +%Y%m%dT%H%M%SZ)}"
RENDER_DIR="$(mktemp -d)"
trap 'rm -rf "$RENDER_DIR"' EXIT

PROMETHEUS_IMAGE="${PROMETHEUS_IMAGE:-registry.invalid/deliveryplatform/prometheus@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
ALERTMANAGER_IMAGE="${ALERTMANAGER_IMAGE:-registry.invalid/deliveryplatform/alertmanager@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}"
KUBE_STATE_METRICS_IMAGE="${KUBE_STATE_METRICS_IMAGE:-registry.invalid/deliveryplatform/kube-state-metrics@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc}"
RECEIVER_IMAGE="${RESILIENCE_RECEIVER_IMAGE:-registry.invalid/deliveryplatform/resilience-circuit-breaker-alert-receiver@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd}"
STORAGE_CLASS="${STAGING_MONITORING_STORAGE_CLASS:-staging-render-only}"
CLUSTER_ID="${STAGING_CLUSTER_ID:-staging-render-only}"
RUNBOOK_HOST="${STAGING_RUNBOOK_HOST:-runbooks.staging-render-only.invalid}"

fail() {
  printf 'staging render validation failed: %s\n' "$*" >&2
  exit 1
}

for image in "$PROMETHEUS_IMAGE" "$ALERTMANAGER_IMAGE" "$KUBE_STATE_METRICS_IMAGE" "$RECEIVER_IMAGE"; do
  [[ "$image" == *@sha256:* ]] || fail "all synthetic image values must be immutable digest references"
done

mkdir -p "$ARTIFACT_DIR"
kubectl kustomize "$ROOT/deploy/kubernetes/staging-monitoring" > "$RENDER_DIR/staging-monitoring-base-source.yaml"
kubectl kustomize "$ROOT/deploy/kubernetes/monitoring" > "$RENDER_DIR/resilience-monitoring.yaml"

substitute() {
  sed \
    -e "s|REPLACE_WITH_APPROVED_PROMETHEUS_IMAGE_DIGEST|$PROMETHEUS_IMAGE|g" \
    -e "s|REPLACE_WITH_APPROVED_ALERTMANAGER_IMAGE_DIGEST|$ALERTMANAGER_IMAGE|g" \
    -e "s|REPLACE_WITH_APPROVED_KUBE_STATE_METRICS_IMAGE_DIGEST|$KUBE_STATE_METRICS_IMAGE|g" \
    -e "s|REPLACE_WITH_IMMUTABLE_RECEIVER_DIGEST|$RECEIVER_IMAGE|g" \
    -e "s|REPLACE_WITH_STAGING_MONITORING_STORAGE_CLASS|$STORAGE_CLASS|g" \
    -e "s|REPLACE_WITH_STAGING_CLUSTER_ID|$CLUSTER_ID|g" \
    -e "s|REPLACE_WITH_RUNBOOK_HOST|$RUNBOOK_HOST|g" \
    "$1" > "$2"
  ! grep -q 'REPLACE_WITH_' "$2" || fail "unresolved placeholder in $(basename "$1")"
}

substitute "$RENDER_DIR/staging-monitoring-base-source.yaml" "$RENDER_DIR/staging-monitoring-resolved.yaml"
substitute "$RENDER_DIR/resilience-monitoring.yaml" "$RENDER_DIR/resilience-monitoring-resolved.yaml"
substitute "$ROOT/deploy/kubernetes/resilience-test/circuit-breaker-alert-receiver.yaml" "$RENDER_DIR/circuit-breaker-alert-receiver.yaml"
substitute "$ROOT/deploy/kubernetes/resilience-test/circuit-breaker-transition-policy.yaml" "$RENDER_DIR/circuit-breaker-transition-policy.yaml"

cat \
  "$RENDER_DIR/staging-monitoring-resolved.yaml" \
  "$RENDER_DIR/resilience-monitoring-resolved.yaml" \
  "$RENDER_DIR/circuit-breaker-alert-receiver.yaml" \
  "$RENDER_DIR/circuit-breaker-transition-policy.yaml" \
  > "$ARTIFACT_DIR/rendered-staging-resilience.yaml"

! grep -q 'REPLACE_WITH_' "$ARTIFACT_DIR/rendered-staging-resilience.yaml" || fail "combined render contains unresolved placeholder"
grep -q '^kind: Prometheus$' "$ARTIFACT_DIR/rendered-staging-resilience.yaml" || fail "Prometheus resource missing"
grep -q '^kind: Alertmanager$' "$ARTIFACT_DIR/rendered-staging-resilience.yaml" || fail "Alertmanager resource missing"
grep -q '^kind: ServiceMonitor$' "$ARTIFACT_DIR/rendered-staging-resilience.yaml" || fail "ServiceMonitor resource missing"
grep -q '^kind: PrometheusRule$' "$ARTIFACT_DIR/rendered-staging-resilience.yaml" || fail "PrometheusRule resource missing"
grep -q '^kind: AlertmanagerConfig$' "$ARTIFACT_DIR/rendered-staging-resilience.yaml" || fail "AlertmanagerConfig resource missing"
grep -q '^kind: ExternalSecret$' "$ARTIFACT_DIR/rendered-staging-resilience.yaml" || fail "ExternalSecret contract missing"
grep -q '^kind: ValidatingAdmissionPolicy$' "$ARTIFACT_DIR/rendered-staging-resilience.yaml" || fail "breaker transition admission policy missing"
grep -q 'resilience-circuit-breaker-operator' "$ARTIFACT_DIR/rendered-staging-resilience.yaml" || fail "dedicated breaker operator RBAC missing"

sha256sum "$ARTIFACT_DIR/rendered-staging-resilience.yaml" > "$ARTIFACT_DIR/rendered-staging-resilience.sha256"
{
  printf 'KUSTOMIZE_STAGING_MONITORING_RENDER=PASS\n'
  printf 'cluster_id=%s\n' "$CLUSTER_ID"
  printf 'storage_class=%s\n' "$STORAGE_CLASS"
  printf 'runbook_host=%s\n' "$RUNBOOK_HOST"
  printf 'rendered_file=%s\n' "$ARTIFACT_DIR/rendered-staging-resilience.yaml"
} | tee "$ARTIFACT_DIR/summary.txt"
