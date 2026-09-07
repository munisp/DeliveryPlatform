#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KUBECONFIG_PATH="${KUBECONFIG:-${HOME}/.kube/config}"
CONTEXT="${KIND_CONTEXT:-kind-deliveryplatform-ci}"
EVIDENCE_DIR="${KIND_CICD_EVIDENCE_DIR:-${ROOT}/validation/kind_cicd_dry_run_20260903}"

export KUBECONFIG="$KUBECONFIG_PATH"
mkdir -p "$EVIDENCE_DIR"

require_context() {
  kubectl config get-contexts -o name | grep -qx "$CONTEXT"
  kubectl config use-context "$CONTEXT" >/dev/null
}

assert_can() {
  local verb="$1"
  local resource="$2"
  if ! kubectl auth can-i "$verb" "$resource" -n switchos --as=system:serviceaccount:switchos:ci-deployer | grep -qx yes; then
    echo "ci-deployer must be allowed to ${verb} ${resource}" >&2
    exit 1
  fi
}

assert_cannot() {
  local verb="$1"
  local resource="$2"
  if kubectl auth can-i "$verb" "$resource" -n switchos --as=system:serviceaccount:switchos:ci-deployer | grep -qx yes; then
    echo "ci-deployer must not be allowed to ${verb} ${resource}" >&2
    exit 1
  fi
}

cd "$ROOT"
require_context

# Test only: no production material is committed or applied. The overlay translates
# provider-neutral paths to legal Kubernetes Secret names to exercise ESO locally.
kubectl apply --server-side --field-manager=deliveryplatform-kind-dry-run \
  -f deploy/kubernetes/kind-dry-run/switchos-namespace.yaml
kubectl apply --server-side --field-manager=deliveryplatform-kind-dry-run \
  -f deploy/kubernetes/kind-dry-run/secret-sync-test.yaml
kubectl wait --for=condition=Ready clustersecretstore/deliveryplatform-secrets --timeout=120s
kubectl apply --server-side --field-manager=deliveryplatform-kind-dry-run \
  -k deploy/kubernetes/security
kubectl apply --server-side --field-manager=deliveryplatform-kind-dry-run \
  -f deploy/kubernetes/kind-dry-run/external-secrets-kubernetes-provider-overlay.yaml
kubectl wait --for=condition=Ready externalsecret --all -n switchos --timeout=180s

assert_can get deployments
assert_can patch deployments
assert_can create jobs
assert_can patch externalsecrets.external-secrets.io
assert_cannot get secrets
assert_cannot list secrets

# This checks admission, schema validation, Pod Security Admission, and references
# for the entire rendered set without starting placeholder image tags or migrations.
kubectl apply --server-side --force-conflicts --dry-run=server -k deploy/kubernetes \
  | tee "$EVIDENCE_DIR/server_side_apply.txt"

for secret in switchos-runtime-secrets central-app-secrets go-services-secrets python-services-secrets; do
  owner_kind="$(kubectl get secret "$secret" -n switchos -o jsonpath='{.metadata.ownerReferences[0].kind}')"
  owner_name="$(kubectl get secret "$secret" -n switchos -o jsonpath='{.metadata.ownerReferences[0].name}')"
  test "$owner_kind" = "ExternalSecret"
  test "$owner_name" = "$secret"
done

kubectl get clustersecretstore,externalsecret,secret -n switchos -o wide > "$EVIDENCE_DIR/secret_sync_status.txt"
kubectl auth can-i get deployments -n switchos --as=system:serviceaccount:switchos:ci-deployer > "$EVIDENCE_DIR/ci_deployer_get_deployments.txt"
# "no" is the required and expected result; preserve it as evidence without
# allowing kubectl's nonzero exit status to terminate the successful dry run.
kubectl auth can-i get secrets -n switchos --as=system:serviceaccount:switchos:ci-deployer > "$EVIDENCE_DIR/ci_deployer_get_secrets.txt" || true
printf '%s\n' "PASS: kind CI/CD dry run completed with server-side manifest admission, real External Secrets synchronization, and least-privilege CI RBAC" \
  | tee "$EVIDENCE_DIR/summary.txt"
