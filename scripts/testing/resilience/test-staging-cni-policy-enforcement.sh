#!/usr/bin/env bash
set -euo pipefail

CONTEXT="${STAGING_CNI_TEST_CONTEXT:-}"
CNI="${STAGING_CNI:-}"
CONFIRMATION="${CONFIRM_STAGING_CNI_POLICY_TEST:-}"
NETTEST_IMAGE="${STAGING_NETTEST_IMAGE:-}"
ARTIFACT_DIR="${ARTIFACT_DIR:-$(pwd)/validation/staging_cni_policy_$(date -u +%Y%m%dT%H%M%SZ)}"
CALICO_EVIDENCE_COMMAND="${CALICO_EVIDENCE_COMMAND:-}"
MATRIX_EGRESS_HOST="${MATRIX_EGRESS_HOST:-}"
WAZUH_EGRESS_HOST="${WAZUH_EGRESS_HOST:-}"
TARGET_NAMESPACE="resilience-test"
PROBE_NAMESPACE="monitoring"
RUN_ID="cni-$(date -u +%Y%m%dT%H%M%SZ)"

fail() {
  printf 'staging CNI policy test refused: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  kubectl -n "$PROBE_NAMESPACE" delete pod \
    "${RUN_ID}-allowed" "${RUN_ID}-denied" \
    --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl -n "$TARGET_NAMESPACE" delete pod \
    "${RUN_ID}-matrix-egress" "${RUN_ID}-wazuh-egress" \
    --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

[[ -n "$CONTEXT" ]] || fail "STAGING_CNI_TEST_CONTEXT is required"
[[ "$CNI" == "cilium" || "$CNI" == "calico" ]] || fail "STAGING_CNI must be cilium or calico"
[[ "$CONFIRMATION" == "${CNI}:${CONTEXT}:approved" ]] || fail "CONFIRM_STAGING_CNI_POLICY_TEST must equal ${CNI}:${CONTEXT}:approved"
[[ "$NETTEST_IMAGE" == *@sha256:* ]] || fail "STAGING_NETTEST_IMAGE must be an approved immutable image digest with sh and nc"
[[ -n "$MATRIX_EGRESS_HOST" && -n "$WAZUH_EGRESS_HOST" ]] || fail "MATRIX_EGRESS_HOST and WAZUH_EGRESS_HOST are required"
[[ "$(kubectl config current-context)" == "$CONTEXT" ]] || fail "active context does not match STAGING_CNI_TEST_CONTEXT"
[[ "$(kubectl get namespace "$TARGET_NAMESPACE" -o jsonpath='{.metadata.labels.resilience\.delivery-platform\.io/environment}' 2>/dev/null || true)" == "non-production" ]] || fail "resilience-test must be labelled non-production"
[[ "$(kubectl get namespace "$PROBE_NAMESPACE" -o jsonpath='{.metadata.labels.resilience\.delivery-platform\.io/environment}' 2>/dev/null || true)" == "non-production" ]] || fail "monitoring must be labelled non-production"

mkdir -p "$ARTIFACT_DIR"
printf '%s\n' "run_id=$RUN_ID" > "$ARTIFACT_DIR/metadata.txt"
printf '%s\n' "cni=$CNI" >> "$ARTIFACT_DIR/metadata.txt"
printf '%s\n' "context=$CONTEXT" >> "$ARTIFACT_DIR/metadata.txt"

case "$CNI" in
  cilium)
    command -v cilium >/dev/null || fail "cilium CLI is required for Cilium evidence"
    command -v hubble >/dev/null || fail "hubble CLI is required for Cilium flow evidence"
    cilium status --wait > "$ARTIFACT_DIR/cilium-status.log" 2>&1
    hubble status > "$ARTIFACT_DIR/hubble-status.log" 2>&1
    ;;
  calico)
    kubectl -n calico-system get daemonset calico-node > "$ARTIFACT_DIR/calico-daemonset.txt" 2>&1 || fail "calico-node daemonset was not found"
    [[ -n "$CALICO_EVIDENCE_COMMAND" ]] || fail "CALICO_EVIDENCE_COMMAND must collect approved Calico flow/policy evidence"
    ;;
esac

for service in matrix-escalation-bridge wazuh-escalation-bridge; do
  kubectl -n "$TARGET_NAMESPACE" get service "$service" > "$ARTIFACT_DIR/${service}-service.yaml" || fail "required bridge service missing: $service"
  kubectl -n "$TARGET_NAMESPACE" get endpointslice -l "kubernetes.io/service-name=${service}" -o yaml > "$ARTIFACT_DIR/${service}-endpointslices.yaml" || fail "required bridge endpoints missing: $service"
done

cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: ${RUN_ID}-allowed
  namespace: ${PROBE_NAMESPACE}
  labels:
    app.kubernetes.io/name: alertmanager
    resilience.delivery-platform.io/test-run: ${RUN_ID}
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    runAsGroup: 65532
    seccompProfile: {type: RuntimeDefault}
  containers:
    - name: nettest
      image: ${NETTEST_IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["sh", "-ec", "sleep 600"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: {drop: ["ALL"]}
---
apiVersion: v1
kind: Pod
metadata:
  name: ${RUN_ID}-denied
  namespace: ${PROBE_NAMESPACE}
  labels:
    app.kubernetes.io/name: cni-untrusted-probe
    resilience.delivery-platform.io/test-run: ${RUN_ID}
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    runAsGroup: 65532
    seccompProfile: {type: RuntimeDefault}
  containers:
    - name: nettest
      image: ${NETTEST_IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["sh", "-ec", "sleep 600"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: {drop: ["ALL"]}
---
apiVersion: v1
kind: Pod
metadata:
  name: ${RUN_ID}-matrix-egress
  namespace: ${TARGET_NAMESPACE}
  labels:
    app.kubernetes.io/name: matrix-escalation-bridge
    resilience.delivery-platform.io/test-run: ${RUN_ID}
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    runAsGroup: 65532
    seccompProfile: {type: RuntimeDefault}
  containers:
    - name: nettest
      image: ${NETTEST_IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["sh", "-ec", "sleep 600"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: {drop: ["ALL"]}
---
apiVersion: v1
kind: Pod
metadata:
  name: ${RUN_ID}-wazuh-egress
  namespace: ${TARGET_NAMESPACE}
  labels:
    app.kubernetes.io/name: wazuh-escalation-bridge
    resilience.delivery-platform.io/test-run: ${RUN_ID}
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    runAsGroup: 65532
    seccompProfile: {type: RuntimeDefault}
  containers:
    - name: nettest
      image: ${NETTEST_IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["sh", "-ec", "sleep 600"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: {drop: ["ALL"]}
EOF

kubectl -n "$PROBE_NAMESPACE" wait --for=condition=Ready --timeout=180s pod "${RUN_ID}-allowed" "${RUN_ID}-denied"
kubectl -n "$TARGET_NAMESPACE" wait --for=condition=Ready --timeout=180s pod "${RUN_ID}-matrix-egress" "${RUN_ID}-wazuh-egress"

probe_allowed() {
  local namespace="$1" pod="$2" host="$3" port="$4" name="$5"
  kubectl -n "$namespace" exec "$pod" -- sh -ec "nc -z -w 8 ${host} ${port}" > "$ARTIFACT_DIR/${name}.log" 2>&1 || fail "expected allowed connection failed: $name"
}

probe_denied() {
  local namespace="$1" pod="$2" host="$3" port="$4" name="$5"
  if kubectl -n "$namespace" exec "$pod" -- sh -ec "nc -z -w 8 ${host} ${port}" > "$ARTIFACT_DIR/${name}.log" 2>&1; then
    fail "expected denied connection succeeded: $name"
  fi
}

# Alertmanager-labelled client is allowed to reach either internal bridge listener.
probe_allowed "$PROBE_NAMESPACE" "${RUN_ID}-allowed" "matrix-escalation-bridge.${TARGET_NAMESPACE}.svc" 8443 allowed_alertmanager_to_matrix
probe_allowed "$PROBE_NAMESPACE" "${RUN_ID}-allowed" "wazuh-escalation-bridge.${TARGET_NAMESPACE}.svc" 8443 allowed_alertmanager_to_wazuh
# An unlabelled client in the same namespace must still be denied by the bridge ingress selector.
probe_denied "$PROBE_NAMESPACE" "${RUN_ID}-denied" "matrix-escalation-bridge.${TARGET_NAMESPACE}.svc" 8443 denied_untrusted_to_matrix
probe_denied "$PROBE_NAMESPACE" "${RUN_ID}-denied" "wazuh-escalation-bridge.${TARGET_NAMESPACE}.svc" 8443 denied_untrusted_to_wazuh
# Egress identity tests: matrix traffic may reach Matrix only; Wazuh traffic may reach Wazuh only.
probe_allowed "$TARGET_NAMESPACE" "${RUN_ID}-matrix-egress" "$MATRIX_EGRESS_HOST" 8448 allowed_matrix_to_matrix_service
probe_denied "$TARGET_NAMESPACE" "${RUN_ID}-matrix-egress" "$WAZUH_EGRESS_HOST" 55000 denied_matrix_to_wazuh_service
probe_allowed "$TARGET_NAMESPACE" "${RUN_ID}-wazuh-egress" "$WAZUH_EGRESS_HOST" 55000 allowed_wazuh_to_wazuh_service
probe_denied "$TARGET_NAMESPACE" "${RUN_ID}-wazuh-egress" "$MATRIX_EGRESS_HOST" 8448 denied_wazuh_to_matrix_service

case "$CNI" in
  cilium)
    hubble observe --namespace "$TARGET_NAMESPACE" --last 200 --output json > "$ARTIFACT_DIR/hubble-flows.json" 2>&1
    grep -Eq 'DROPPED|Policy denied' "$ARTIFACT_DIR/hubble-flows.json" || fail "Cilium flow evidence did not contain a dropped policy flow"
    ;;
  calico)
    bash -lc "$CALICO_EVIDENCE_COMMAND" > "$ARTIFACT_DIR/calico-policy-evidence.log" 2>&1
    grep -Eqi 'DENIED|DROPPED|calico-packet|policy' "$ARTIFACT_DIR/calico-policy-evidence.log" || fail "Calico evidence command did not return policy evidence"
    ;;
esac

kubectl -n "$TARGET_NAMESPACE" get networkpolicy -o yaml > "$ARTIFACT_DIR/applied-networkpolicies.yaml"
printf '%s\n' 'CNI_POLICY_ENFORCEMENT=PASS' | tee "$ARTIFACT_DIR/summary.txt"
