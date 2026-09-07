#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CONTEXT="${STAGING_MONITORING_CONTEXT:-}"
CONFIRMATION="${CONFIRM_STAGING_MONITORING_PROVISION:-}"
BUNDLE="${PROMETHEUS_OPERATOR_BUNDLE:-$ROOT/deploy/kubernetes/staging-monitoring/vendor/prometheus-operator-v0.93.1-bundle.yaml}"
DEFAULT_BUNDLE_SHA256="$(awk '{print $1}' "$ROOT/deploy/kubernetes/staging-monitoring/vendor/prometheus-operator-v0.93.1-bundle.sha256")"
BUNDLE_SHA256="${PROMETHEUS_OPERATOR_BUNDLE_SHA256:-$DEFAULT_BUNDLE_SHA256}"
CLUSTER_ID="${STAGING_CLUSTER_ID:-}"
STORAGE_CLASS="${STAGING_MONITORING_STORAGE_CLASS:-}"
RUNBOOK_HOST="${STAGING_RUNBOOK_HOST:-}"
PROMETHEUS_IMAGE="${PROMETHEUS_IMAGE:-}"
ALERTMANAGER_IMAGE="${ALERTMANAGER_IMAGE:-}"
KUBE_STATE_METRICS_IMAGE="${KUBE_STATE_METRICS_IMAGE:-}"
RECEIVER_IMAGE="${RESILIENCE_RECEIVER_IMAGE:-}"
SECRET_STORE="${STAGING_CLUSTER_SECRET_STORE:-platform-staging-secrets}"
RECEIVER_CA_FILE="${RECEIVER_CA_FILE:-}"
MATRIX_BRIDGE_CA_FILE="${MATRIX_BRIDGE_CA_FILE:-}"
WAZUH_BRIDGE_CA_FILE="${WAZUH_BRIDGE_CA_FILE:-}"
RENDER_DIR="$(mktemp -d)"
trap 'rm -rf "$RENDER_DIR"' EXIT

fail() {
  printf 'staging monitoring provisioning refused: %s\n' "$*" >&2
  exit 1
}

[[ -n "$CONTEXT" ]] || fail "STAGING_MONITORING_CONTEXT is required"
[[ "$CONFIRMATION" == "${CONTEXT}:approved" ]] || fail "CONFIRM_STAGING_MONITORING_PROVISION must equal ${CONTEXT}:approved"
[[ -n "$BUNDLE" && -f "$BUNDLE" ]] || fail "PROMETHEUS_OPERATOR_BUNDLE must name a reviewed local bundle file"
[[ -n "$BUNDLE_SHA256" ]] || fail "PROMETHEUS_OPERATOR_BUNDLE_SHA256 is required"
[[ -n "$CLUSTER_ID" && -n "$STORAGE_CLASS" && -n "$RUNBOOK_HOST" ]] || fail "STAGING_CLUSTER_ID, STAGING_MONITORING_STORAGE_CLASS, and STAGING_RUNBOOK_HOST are required"
[[ "$RUNBOOK_HOST" != *"://"* && "$RUNBOOK_HOST" != *"/"* ]] || fail "STAGING_RUNBOOK_HOST must be a hostname without scheme or path"
for ca_file in "$RECEIVER_CA_FILE" "$MATRIX_BRIDGE_CA_FILE" "$WAZUH_BRIDGE_CA_FILE"; do
  [[ -n "$ca_file" && -r "$ca_file" ]] || fail "RECEIVER_CA_FILE, MATRIX_BRIDGE_CA_FILE, and WAZUH_BRIDGE_CA_FILE must name readable approved CA files"
done
for value in "$PROMETHEUS_IMAGE" "$ALERTMANAGER_IMAGE" "$KUBE_STATE_METRICS_IMAGE" "$RECEIVER_IMAGE"; do
  [[ "$value" == *@sha256:* ]] || fail "all component images must be immutable digest references"
done
[[ "$(kubectl config current-context)" == "$CONTEXT" ]] || fail "active context does not match STAGING_MONITORING_CONTEXT"
[[ "$(sha256sum "$BUNDLE" | awk '{print $1}')" == "$BUNDLE_SHA256" ]] || fail "operator bundle SHA-256 mismatch"
kubectl apply -f "$ROOT/deploy/kubernetes/staging-monitoring/namespace.yaml"
[[ "$(kubectl get namespace resilience-test -o jsonpath='{.metadata.labels.resilience\\.delivery-platform\\.io/environment}')" == "non-production" ]] || fail "resilience-test must be labelled non-production"
[[ "$(kubectl get namespace monitoring -o jsonpath='{.metadata.labels.resilience\\.delivery-platform\\.io/environment}')" == "non-production" ]] || fail "monitoring must be labelled non-production"

for crd in externalsecrets.external-secrets.io clustersecretstores.external-secrets.io; do
  kubectl get crd "$crd" >/dev/null 2>&1 || fail "required External Secrets CRD missing: $crd"
done
kubectl get clustersecretstore "$SECRET_STORE" >/dev/null 2>&1 || fail "required ClusterSecretStore missing: $SECRET_STORE"

printf '%s\n' 'Applying reviewed Prometheus Operator CRDs and controller bundle...'
mkdir -p "$RENDER_DIR/operator"
cp "$BUNDLE" "$RENDER_DIR/operator/bundle.yaml"
cat > "$RENDER_DIR/operator/kustomization.yaml" <<'EOF'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: monitoring
resources:
  - bundle.yaml
EOF
kubectl apply --server-side --field-manager=deliveryplatform-staging-monitoring -k "$RENDER_DIR/operator"
kubectl wait --for=condition=Established --timeout=180s \
  crd/prometheuses.monitoring.coreos.com \
  crd/alertmanagers.monitoring.coreos.com \
  crd/servicemonitors.monitoring.coreos.com \
  crd/prometheusrules.monitoring.coreos.com \
  crd/alertmanagerconfigs.monitoring.coreos.com
kubectl -n monitoring wait --for=condition=Available --timeout=300s deployment \
  -l app.kubernetes.io/name=prometheus-operator
kubectl api-resources --api-group=admissionregistration.k8s.io -o name | grep -qx 'validatingadmissionpolicies' || fail "cluster must support admissionregistration.k8s.io ValidatingAdmissionPolicy before breaker recovery is enabled"
kubectl api-resources --api-group=admissionregistration.k8s.io -o name | grep -qx 'validatingadmissionpolicybindings' || fail "cluster must support ValidatingAdmissionPolicyBinding before breaker recovery is enabled"

kubectl kustomize "$ROOT/deploy/kubernetes/monitoring" > "$RENDER_DIR/monitoring-source.yaml"

for file in \
  "$ROOT/deploy/kubernetes/staging-monitoring/prometheus-alertmanager.yaml" \
  "$ROOT/deploy/kubernetes/staging-monitoring/kube-state-metrics.yaml" \
  "$ROOT/deploy/kubernetes/resilience-test/circuit-breaker-alert-receiver.yaml" \
  "$ROOT/deploy/kubernetes/resilience-test/circuit-breaker-transition-policy.yaml" \
  "$RENDER_DIR/monitoring-source.yaml"; do
  out="$RENDER_DIR/$(basename "$file")"
  sed \
    -e "s|REPLACE_WITH_APPROVED_PROMETHEUS_IMAGE_DIGEST|$PROMETHEUS_IMAGE|g" \
    -e "s|REPLACE_WITH_APPROVED_ALERTMANAGER_IMAGE_DIGEST|$ALERTMANAGER_IMAGE|g" \
    -e "s|REPLACE_WITH_APPROVED_KUBE_STATE_METRICS_IMAGE_DIGEST|$KUBE_STATE_METRICS_IMAGE|g" \
    -e "s|REPLACE_WITH_IMMUTABLE_RECEIVER_DIGEST|$RECEIVER_IMAGE|g" \
    -e "s|REPLACE_WITH_STAGING_MONITORING_STORAGE_CLASS|$STORAGE_CLASS|g" \
    -e "s|REPLACE_WITH_STAGING_CLUSTER_ID|$CLUSTER_ID|g" \
    -e "s|REPLACE_WITH_RUNBOOK_HOST|$RUNBOOK_HOST|g" \
    "$file" > "$out"
  ! grep -q 'REPLACE_WITH_' "$out" || fail "unresolved placeholder in $file"
done

kubectl apply -k "$ROOT/deploy/kubernetes/staging-monitoring"
for config in \
  "monitoring resilience-circuit-breaker-alert-receiver-ca $RECEIVER_CA_FILE" \
  "monitoring matrix-escalation-bridge-ca $MATRIX_BRIDGE_CA_FILE" \
  "monitoring wazuh-escalation-bridge-ca $WAZUH_BRIDGE_CA_FILE"; do
  read -r namespace name ca_file <<< "$config"
  kubectl -n "$namespace" create configmap "$name" --from-file=ca.crt="$ca_file" --dry-run=client -o yaml | kubectl apply -f -
done
kubectl apply -f "$RENDER_DIR/prometheus-alertmanager.yaml"
kubectl apply -f "$RENDER_DIR/kube-state-metrics.yaml"
kubectl apply -f "$RENDER_DIR/monitoring-source.yaml"
kubectl apply -f "$RENDER_DIR/circuit-breaker-alert-receiver.yaml"
kubectl apply -f "$RENDER_DIR/circuit-breaker-transition-policy.yaml"

kubectl -n monitoring wait --for=condition=Ready --timeout=300s externalsecret \
  matrix-escalation-bridge-auth wazuh-escalation-bridge-auth
kubectl -n resilience-test wait --for=condition=Ready --timeout=300s externalsecret \
  resilience-circuit-breaker-alert-receiver resilience-circuit-breaker-alert-receiver-tls
kubectl -n monitoring wait --for=condition=Available --timeout=600s statefulset/prometheus-platform statefulset/alertmanager-platform
kubectl -n monitoring rollout status deployment/kube-state-metrics --timeout=300s
kubectl -n resilience-test rollout status deployment/resilience-circuit-breaker-alert-receiver --timeout=300s

printf '%s\n' 'STAGING_MONITORING_PROVISION=PASS'
