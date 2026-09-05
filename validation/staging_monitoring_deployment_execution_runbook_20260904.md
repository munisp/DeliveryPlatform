# Protected-Staging Monitoring Deployment Execution Runbook

**Owner:** SRE and Security Engineering  
**Scope:** Prometheus Operator, Prometheus, Alertmanager, kube-state-metrics, receiver scrape/rule/route reconciliation, and the self-hosted Matrix/Wazuh escalation path.  
**Environment:** Approved protected staging only. This runbook must not be used against a production context.

> **Stop condition:** The deployment must stop immediately if the active context differs from the approved change record, any image is not digest-pinned, the vendor-bundle checksum differs, an ExternalSecret is not ready, a TLS token/certificate contract is missing, or an unresolved `REPLACE_WITH_` placeholder is found. The supplied scripts fail closed for these conditions.

## 1. Change Record and Preconditions

The change approver must record the staging cluster context, change ID, maintenance window, rollback owner, target component digests, bundle SHA-256, PKI issuer, ExternalSecret store name, Matrix/Wazuh test endpoint owners, and CNI implementation. Confirm that the target is not production and that the `monitoring` and `resilience-test` namespaces carry `resilience.delivery-platform.io/environment=non-production`.

| Prerequisite                                     | Automated check                                                                                      | Required evidence                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Kubernetes and Prometheus Operator compatibility | `kubectl version` and operator bundle preflight                                                      | Cluster version satisfies the selected Operator release requirements    |
| Reviewed operator bundle                         | `sha256sum -c deploy/kubernetes/staging-monitoring/vendor/prometheus-operator-v0.93.1-bundle.sha256` | Matching checksum and change-record approval                            |
| External Secrets infrastructure                  | Provisioner checks CRDs and `ClusterSecretStore/platform-staging-secrets`                            | Staging-only identity/path-policy review                                |
| Digest-pinned workload images                    | Provisioner requires `@sha256:` for four workload images                                             | SBOM, signature/attestation, scan result, and immutable digest approval |
| Storage and PKI                                  | Provisioner requires storage class and three readable CA PEM files                                   | Storage-class suitability and certificate-chain validation              |
| Matrix/Wazuh bridges                             | Services, TLS listeners, and expected labels exist                                                   | Test-only endpoint ownership and readiness confirmation                 |
| Enforcing CNI                                    | Separate CNI script detects Cilium or Calico evidence prerequisites                                  | SRE attestation and planned allow/deny test window                      |

## 2. Non-Mutating Render Check

Run this first. It renders all Kustomize resources with synthetic digest-pinned images, a synthetic staging identity, and a synthetic runbook host. It does **not** contact a cluster or apply resources.

```bash
cd /path/to/DeliveryPlatform
ARTIFACT_DIR=validation/staging_monitoring_render_$(date -u +%Y%m%dT%H%M%SZ) \
  scripts/testing/resilience/validate-staging-monitoring-render.sh
```

Expected result:

```text
KUSTOMIZE_STAGING_MONITORING_RENDER=PASS
```

Archive the rendered YAML, its SHA-256 file, and `summary.txt`. If this check fails, correct the manifest or supply a valid input; do not bypass the unresolved-placeholder check.

## 3. Populate Approved Staging Inputs

Obtain values through the established secret-management and image-promotion processes. Do not put token values, TLS private keys, or CA PEM contents in shell history, Git, CI logs, or ticket comments.

```bash
export STAGING_MONITORING_CONTEXT='approved-staging-context'
export CONFIRM_STAGING_MONITORING_PROVISION="${STAGING_MONITORING_CONTEXT}:approved"
export STAGING_CLUSTER_ID='approved-staging-cluster-id'
export STAGING_MONITORING_STORAGE_CLASS='approved-monitoring-storage-class'
export STAGING_RUNBOOK_HOST='runbooks.staging.internal'
export STAGING_CLUSTER_SECRET_STORE='platform-staging-secrets'

export PROMETHEUS_IMAGE='registry.example/prometheus@sha256:REPLACE'
export ALERTMANAGER_IMAGE='registry.example/alertmanager@sha256:REPLACE'
export KUBE_STATE_METRICS_IMAGE='registry.example/kube-state-metrics@sha256:REPLACE'
export RESILIENCE_RECEIVER_IMAGE='registry.example/resilience-circuit-breaker-alert-receiver@sha256:REPLACE'

export RECEIVER_CA_FILE='/secure/runtime/receiver-ca.crt'
export MATRIX_BRIDGE_CA_FILE='/secure/runtime/matrix-bridge-ca.crt'
export WAZUH_BRIDGE_CA_FILE='/secure/runtime/wazuh-bridge-ca.crt'
```

The bearer token and receiver TLS private key are supplied by the four `ExternalSecret` resources. Verify their remote entries exist without printing values. The receiver token must meet the application’s configured minimum length. All remote references are staging scoped under `deliveryplatform/staging/resilience/`.

## 4. Apply Through the Guarded Provisioner

```bash
scripts/testing/resilience/provision-staging-monitoring.sh
```

The provisioner performs these operations in order:

1. Verifies exact context and confirmation string.
2. Verifies the vendored Operator bundle SHA-256.
3. Creates/labels only the two non-production namespaces.
4. Confirms External Secrets CRDs and the staging ClusterSecretStore.
5. Installs the checked operator bundle, waits for required CRDs and controller readiness.
6. Renders images, storage class, cluster ID, runbook host, and receiver image into a temporary directory, rejecting unresolved placeholders.
7. Applies the monitoring infrastructure, public CA ConfigMaps, existing resilience rules/routes, and receiver workload.
8. Waits for ExternalSecrets and the monitored workloads to become ready.

Expected terminal result:

```text
STAGING_MONITORING_PROVISION=PASS
```

## 5. Reconciliation Verification

These checks prove that controllers accepted the resource model; they do not by themselves prove live notification delivery.

```bash
kubectl -n monitoring get prometheus platform alertmanager platform
kubectl -n monitoring get servicemonitor,prometheusrule,alertmanagerconfig
kubectl -n monitoring get externalsecret
kubectl -n resilience-test get deployment,pod,service,servicemonitor,externalsecret
kubectl -n monitoring get pods -l app.kubernetes.io/name=kube-state-metrics
```

Port-forward an authorized Prometheus instance only in the protected test window. Confirm the receiver target is active and the recording rule is loaded.

```bash
PROM_POD="$(kubectl -n monitoring get pods -l app.kubernetes.io/name=prometheus,operator.prometheus.io/name=platform -o jsonpath='{.items[0].metadata.name}')"
kubectl -n monitoring port-forward "pod/${PROM_POD}" 9090:9090

curl -fsS 'http://127.0.0.1:9090/api/v1/targets?state=active'
curl -fsS 'http://127.0.0.1:9090/api/v1/rules'
curl -fsS --get 'http://127.0.0.1:9090/api/v1/query' \
  --data-urlencode 'query=resilience:circuit_breaker_patch_failures_10m'
```

Confirm that the receiver metrics target is active, the `resilience:circuit_breaker_patch_failures_10m` recording rule is present, and alert annotations contain the approved `https://runbooks.staging.internal/...` host.

Port-forward the authorized Alertmanager instance and inspect its active configuration through the authenticated operational channel. Verify that the `ResilienceCircuitBreakerPatchFailureEscalation` route fans out only to the Matrix/Wazuh bridges and that `send_resolved: false` remains set.

## 6. Bounded Functional Exercise

Run only after controller reconciliation is proven and the steering change approval authorizes a test alert. Use the existing protected staging-chaos workflow and invariant probe. Capture the following minimum evidence:

| Test                                    | Expected result                                                                                                                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Three receiver ConfigMap patch failures | Failure counter rises; recording rule evaluates; critical escalation alert becomes firing; breaker stays closed if it cannot be patched |
| Receiver API recovery                   | An allowlisted critical invariant alert opens the breaker exactly once                                                                  |
| Matrix/Wazuh delivery                   | Both bridges receive redacted firing metadata over TLS; neither has Kubernetes mutation authority                                       |
| Receiver retry                          | Alertmanager retries a failed receiver delivery; no auto-close or auto-half-open path exists                                            |

## 7. CNI Enforcement Evidence

Use the Cilium/Calico script only after the bridge services and policy labels match the deployment:

```bash
export STAGING_CNI_TEST_CONTEXT="$STAGING_MONITORING_CONTEXT"
export STAGING_CNI='cilium' # or calico
export CONFIRM_STAGING_CNI_POLICY_TEST="${STAGING_CNI}:${STAGING_CNI_TEST_CONTEXT}:approved"
export STAGING_NETTEST_IMAGE='registry.example/nettest@sha256:REPLACE'
export MATRIX_EGRESS_HOST='matrix.matrix.svc'
export WAZUH_EGRESS_HOST='wazuh.wazuh.svc'
export CALICO_EVIDENCE_COMMAND='kubectl -n calico-system logs daemonset/calico-node --since=10m'

ARTIFACT_DIR=validation/staging_cni_policy_$(date -u +%Y%m%dT%H%M%SZ) \
  scripts/testing/resilience/test-staging-cni-policy-enforcement.sh
```

For Cilium, require `cilium status --wait`, `hubble status`, and a captured dropped-flow record. For Calico, require an approved read-only evidence command that captures policy verdicts. Archive allowed and denied probe logs, CNI flow evidence, applied NetworkPolicies, namespace labels, and the script summary.

## 8. Rollback and Stop Conditions

Do not delete the operator CRDs as a routine application rollback. CRDs may be shared by other monitored workloads. If a resilience-specific deployment fails, open the circuit breaker, preserve artifacts, and delete only the change-approved namespaced resources after confirming they are not shared:

```bash
kubectl -n resilience-test rollout undo deployment/resilience-circuit-breaker-alert-receiver
kubectl -n monitoring delete --ignore-not-found alertmanagerconfig resilience-matrix-wazuh-escalation
kubectl -n monitoring delete --ignore-not-found prometheusrule deliveryplatform-resilience-invariant-probe
```

Use the organization’s normal incident and change process for Operator/controller rollback. Never remove test evidence, silently close the circuit breaker, or replace an immutable image reference with a tag to recover availability.

## References

[1]: https://prometheus-operator.dev/docs/getting-started/installation/ "Prometheus Operator installation"
[2]: https://prometheus-operator.dev/docs/getting-started/design/ "Prometheus Operator selection and reconciliation"
[3]: https://prometheus-operator.dev/docs/developer/alerting/ "AlertmanagerConfig routing"
[4]: https://docs.cilium.io/en/stable/observability/hubble/hubble-cli/ "Cilium Hubble flow observation"
[5]: https://docs.tigera.io/calico/latest/network-policy/policy-rules/log-rules "Calico network policy logging"
[6]: https://kubernetes.io/docs/concepts/services-networking/network-policies/ "Kubernetes NetworkPolicy semantics"
