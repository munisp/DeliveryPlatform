# Local Kind API Audit and Operator Conflict Review

**Purpose:** Prove Kubernetes API audit output for RBAC and admission-policy denials in a strictly local, disposable kind cluster, then inspect the recovery operator's optimistic-concurrency handling.  
**Safety classification:** Local-only integration validation. The procedure must never use a staging, production, payment-provider, Matrix, or Wazuh context.

## 1. Local prerequisites

Install `kind`, `kubectl`, `docker`, and `jq` on the local workstation. The only permitted context is the generated context `kind-resilience-audit-local`. Confirm the local Docker daemon is reachable and does not point at a remote daemon.

```bash
export CLUSTER_NAME=resilience-audit-local
export CONTEXT=kind-${CLUSTER_NAME}
export ARTIFACT_DIR="$PWD/validation/local_kind_api_audit_$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$ARTIFACT_DIR"
docker info --format '{{.ServerVersion}}'
kind version
kubectl version --client
```

Do not proceed if `kubectl config current-context` is any existing staging/production context. The commands below explicitly use `--context "$CONTEXT"` and must not rely on the ambient context.

## 2. Audit policy and kind cluster configuration

Create `audit-policy.yaml` locally. It is deliberately narrow: it records metadata for ConfigMap GET/PATCH requests in `resilience-test` and all responses with status `>= 400`. The audit log must never use `RequestResponse` for this test because that can record bearer tokens or request bodies.

```yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  - level: Metadata
    namespaces: ["resilience-test"]
    resources:
      - group: ""
        resources: ["configmaps"]
    verbs: ["get", "patch", "update"]
  - level: Metadata
    omitStages: ["RequestReceived"]
```

Create `kind-audit-config.yaml`. The host path is an ephemeral artifact directory. The control-plane extra mounts and API-server arguments activate the policy.

```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraMounts:
      - hostPath: REPLACE_WITH_AUDIT_DIR
        containerPath: /var/log/kubernetes-audit
    kubeadmConfigPatches:
      - |
        kind: ClusterConfiguration
        apiServer:
          extraArgs:
            audit-policy-file: /etc/kubernetes/audit-policy.yaml
            audit-log-path: /var/log/kubernetes-audit/audit.log
            audit-log-maxage: "1"
            audit-log-maxbackup: "1"
            audit-log-maxsize: "100"
    extraMounts:
      - hostPath: REPLACE_WITH_AUDIT_POLICY_FILE
        containerPath: /etc/kubernetes/audit-policy.yaml
        readOnly: true
      - hostPath: REPLACE_WITH_AUDIT_DIR
        containerPath: /var/log/kubernetes-audit
```

Because a YAML mapping cannot contain duplicate `extraMounts` keys, generate the final file with one combined list. The following shell commands avoid hand-editing paths:

```bash
cat > "$ARTIFACT_DIR/audit-policy.yaml" <<'YAML'
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  - level: Metadata
    namespaces: ["resilience-test"]
    resources:
      - group: ""
        resources: ["configmaps"]
    verbs: ["get", "patch", "update"]
YAML
cat > "$ARTIFACT_DIR/kind-audit-config.yaml" <<YAML
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraMounts:
      - hostPath: ${ARTIFACT_DIR}
        containerPath: /var/log/kubernetes-audit
      - hostPath: ${ARTIFACT_DIR}/audit-policy.yaml
        containerPath: /etc/kubernetes/audit-policy.yaml
        readOnly: true
    kubeadmConfigPatches:
      - |
        kind: ClusterConfiguration
        apiServer:
          extraArgs:
            audit-policy-file: /etc/kubernetes/audit-policy.yaml
            audit-log-path: /var/log/kubernetes-audit/audit.log
            audit-log-maxage: "1"
            audit-log-maxbackup: "1"
            audit-log-maxsize: "100"
YAML
kind create cluster --name "$CLUSTER_NAME" --config "$ARTIFACT_DIR/kind-audit-config.yaml"
kubectl --context "$CONTEXT" cluster-info
```

## 3. Apply the isolated transition policy and identities

The local test requires Kubernetes support for `ValidatingAdmissionPolicy` (Kubernetes 1.30 or later is recommended). Check the API before applying the policy.

```bash
kubectl --context "$CONTEXT" api-resources --api-group=admissionregistration.k8s.io \
  | grep -q '^validatingadmissionpolicies' || {
    echo 'ValidatingAdmissionPolicy API unavailable; stop and select a supported kind node image.' >&2
    exit 1
  }

kubectl --context "$CONTEXT" create namespace resilience-test
kubectl --context "$CONTEXT" label namespace resilience-test \
  resilience.delivery-platform.io/environment=non-production \
  kubernetes.io/metadata.name=resilience-test --overwrite
kubectl --context "$CONTEXT" -n resilience-test create configmap resilience-validation-circuit-breaker \
  --from-literal=state=closed --from-literal=incident_id=''
kubectl --context "$CONTEXT" apply \
  -f deploy/kubernetes/resilience-test/circuit-breaker-transition-policy.yaml
```

Create an identity with deliberately no ConfigMap permissions. The test uses API-server impersonation to avoid creating or distributing a token.

```bash
kubectl --context "$CONTEXT" -n resilience-test create serviceaccount resilience-untrusted-probe
kubectl --context "$CONTEXT" -n resilience-test auth can-i patch configmaps/resilience-validation-circuit-breaker \
  --as=system:serviceaccount:resilience-test:resilience-untrusted-probe
# Expected: no
```

## 4. Untrusted RBAC denial test

The request must be refused by RBAC and must not mutate the breaker.

```bash
cat > "$ARTIFACT_DIR/untrusted-patch.json" <<'JSON'
[
  {"op":"test","path":"/data/state","value":"closed"},
  {"op":"replace","path":"/data/state","value":"open"}
]
JSON

set +e
kubectl --context "$CONTEXT" -n resilience-test patch configmap resilience-validation-circuit-breaker \
  --type=json --patch-file="$ARTIFACT_DIR/untrusted-patch.json" \
  --as=system:serviceaccount:resilience-test:resilience-untrusted-probe \
  2>&1 | tee "$ARTIFACT_DIR/untrusted-rbac-deny.txt"
status=${PIPESTATUS[0]}
set -e
[ "$status" -ne 0 ] || { echo 'untrusted patch unexpectedly succeeded' >&2; exit 1; }
kubectl --context "$CONTEXT" -n resilience-test get configmap resilience-validation-circuit-breaker \
  -o jsonpath='{.data.state}{"\n"}' | grep -Fx closed
```

The expected API response is `Forbidden` with an RBAC authorization message. Because RBAC rejects the request before admission validation, this case proves identity privilege denial, not the policy rule.

## 5. Receiver-identity admission denial test

To prove the policy separately, create an integration-only Role that lets a test receiver identity patch the named ConfigMap. It must still be denied when it tries to set `half_open` or `closed`.

```bash
cat > "$ARTIFACT_DIR/receiver-test-rbac.yaml" <<'YAML'
apiVersion: v1
kind: ServiceAccount
metadata:
  name: resilience-circuit-breaker-alert-receiver
  namespace: resilience-test
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: receiver-test-patch
  namespace: resilience-test
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    resourceNames: ["resilience-validation-circuit-breaker"]
    verbs: ["get", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: receiver-test-patch
  namespace: resilience-test
subjects:
  - kind: ServiceAccount
    name: resilience-circuit-breaker-alert-receiver
    namespace: resilience-test
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: receiver-test-patch
YAML
kubectl --context "$CONTEXT" apply -f "$ARTIFACT_DIR/receiver-test-rbac.yaml"
```

Use the receiver identity to attempt `closed → half_open`.

```bash
cat > "$ARTIFACT_DIR/receiver-half-open-patch.json" <<'JSON'
[
  {"op":"test","path":"/data/state","value":"closed"},
  {"op":"replace","path":"/data/state","value":"half_open"}
]
JSON
set +e
kubectl --context "$CONTEXT" -n resilience-test patch configmap resilience-validation-circuit-breaker \
  --type=json --patch-file="$ARTIFACT_DIR/receiver-half-open-patch.json" \
  --as=system:serviceaccount:resilience-test:resilience-circuit-breaker-alert-receiver \
  2>&1 | tee "$ARTIFACT_DIR/receiver-admission-deny.txt"
status=${PIPESTATUS[0]}
set -e
[ "$status" -ne 0 ] || { echo 'receiver half-open patch unexpectedly succeeded' >&2; exit 1; }
grep -F 'only the dedicated resilience operator may transition' "$ARTIFACT_DIR/receiver-admission-deny.txt"
```

The expected error proves the second CEL expression was evaluated, rather than only RBAC. The ConfigMap must remain `closed`.

## 6. Audit extraction

After requests finish, identify the local control-plane container and copy the mounted log if necessary. Audit event metadata includes user identity, verb, resource, namespace, response code, request URI, and audit stage; it intentionally excludes token and patch body data.

```bash
CONTROL_PLANE="${CLUSTER_NAME}-control-plane"
docker exec "$CONTROL_PLANE" sh -c 'test -s /var/log/kubernetes-audit/audit.log'
cp "$ARTIFACT_DIR/audit.log" "$ARTIFACT_DIR/api-audit-events.ndjson"

jq -c 'select(.objectRef.namespace == "resilience-test" and .objectRef.name == "resilience-validation-circuit-breaker") |
  {auditID, stage, verb, user: .user.username, uri: .requestURI, code: .responseStatus.code, reason: .responseStatus.reason}' \
  "$ARTIFACT_DIR/api-audit-events.ndjson" | tee "$ARTIFACT_DIR/breaker-audit-summary.ndjson"

grep -F 'system:serviceaccount:resilience-test:resilience-untrusted-probe' "$ARTIFACT_DIR/breaker-audit-summary.ndjson"
grep -F 'system:serviceaccount:resilience-test:resilience-circuit-breaker-alert-receiver' "$ARTIFACT_DIR/breaker-audit-summary.ndjson"
```

The audit log should show the untrusted identity with a non-2xx response for the RBAC denial and the receiver identity with a non-2xx response for the admission-policy denial. Retain the error text from client output alongside the audit metadata because standard Kubernetes audit metadata may not include the CEL message itself.

## 7. Teardown

Archive the restricted evidence directory according to the audit-evidence policy, then remove only the local cluster.

```bash
kind delete cluster --name "$CLUSTER_NAME"
docker ps --format '{{.Names}}' | grep -Fx "$CONTROL_PLANE" && exit 1 || true
```

## Optimistic-concurrency error-handling audit

The operator script uses `set -euo pipefail` and an explicit `fail` function, so missing required inputs, unreadable resources, validation errors, patch rejection, and post-mutation mismatch exit non-zero. It uses no retry loop.

The operator reads `resourceVersion`, state, and incident ID in one `kubectl get` snapshot. `patch_breaker` then produces the following JSON Patch order:

```json
[
  {
    "op": "test",
    "path": "/metadata/resourceVersion",
    "value": "<observed-resource-version>"
  },
  { "op": "test", "path": "/data/state", "value": "<required-old-state>" },
  { "op": "test", "path": "/data/incident_id", "value": "<active-incident>" },
  { "op": "replace", "path": "/data/state", "value": "<requested-next-state>" }
]
```

The incident test is present for recovery transitions. A stale resource version, a changed state, or a new incident causes `kubectl patch` to fail. The script reports a conflict/rejection and requires a re-read plus new operator decision; it does not apply a merge/replace fallback. Following a successful patch it reads the ConfigMap again and requires the expected resulting state.

| Path                                            | Result                                |
| ----------------------------------------------- | ------------------------------------- |
| Missing/invalid snapshot                        | Fails before PATCH.                   |
| Wrong expected state or incident                | Fails before PATCH.                   |
| JSON Patch `test` failure / API 409             | Fails closed; no automated retry.     |
| Admission/RBAC denial                           | Fails closed; no state replacement.   |
| Successful PATCH with unexpected observed state | Fails during post-patch verification. |
| `open` already open                             | Idempotently exits without mutation.  |

## References

[1] [Kubernetes Auditing](https://kubernetes.io/docs/tasks/debug/debug-cluster/audit/)

[2] [kind Configuration](https://kind.sigs.k8s.io/docs/user/configuration/)

[3] [Kubernetes Validating Admission Policy](https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/)

[4] [Kubernetes API Concepts: JSON Patch and Resource Versions](https://kubernetes.io/docs/reference/using-api/api-concepts/)
