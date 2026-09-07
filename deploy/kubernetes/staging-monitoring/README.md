# Protected-Staging Resilience Monitoring Bundle

This directory provisions the **real controller side** of the resilience circuit-breaker monitoring path. It replaces the deleted kind compatibility-CRD fixture; it is not intended for local or production use.

## Contents

| Artifact                                         | Purpose                                                                                                                                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vendor/prometheus-operator-v0.93.1-bundle.yaml` | Vendored official Prometheus Operator v0.93.1 CRDs, controller deployment, and controller RBAC. Its SHA-256 is stored alongside it.                                                                                                        |
| `namespace.yaml`                                 | Creates/labels `monitoring` and `resilience-test` as non-production namespaces.                                                                                                                                                            |
| `prometheus-alertmanager.yaml`                   | Defines real `Prometheus` and `Alertmanager` resources with selectors matching the committed resilience resources.                                                                                                                         |
| `kube-state-metrics.yaml`                        | Deploys kube-state-metrics and a ServiceMonitor for the invariant Job rule inputs.                                                                                                                                                         |
| `external-secrets.yaml`                          | Declares only test-token and receiver private-TLS secret contracts; no secret value is committed.                                                                                                                                          |
| `trust-bundles.yaml`                             | Input template only. The provisioner generates the three required CA ConfigMaps from reviewed local PEM files instead of applying placeholders.                                                                                            |
| `provision-staging-monitoring.sh`                | Guarded provisioner. It refuses missing context, incorrect confirmation, non-digest images, unverified bundle integrity, unlabelled namespaces, missing External Secrets prerequisites, unresolved placeholders, or unavailable workloads. |

## Required Inputs

All images must be approved immutable digests. All credentials and TLS private keys must be supplied through the named ExternalSecret remote references. The CA PEM files are public trust anchors, but must still be obtained from the approved staging PKI source.

```bash
export STAGING_MONITORING_CONTEXT='REPLACE_WITH_APPROVED_STAGING_CONTEXT'
export CONFIRM_STAGING_MONITORING_PROVISION="${STAGING_MONITORING_CONTEXT}:approved"
export STAGING_CLUSTER_ID='REPLACE_WITH_STAGING_CLUSTER_ID'
export STAGING_MONITORING_STORAGE_CLASS='REPLACE_WITH_APPROVED_STORAGE_CLASS'
export PROMETHEUS_IMAGE='registry.example/prometheus@sha256:REPLACE'
export ALERTMANAGER_IMAGE='registry.example/alertmanager@sha256:REPLACE'
export KUBE_STATE_METRICS_IMAGE='registry.example/kube-state-metrics@sha256:REPLACE'
export RESILIENCE_RECEIVER_IMAGE='registry.example/resilience-circuit-breaker-alert-receiver@sha256:REPLACE'
export STAGING_CLUSTER_SECRET_STORE='platform-staging-secrets'
export RECEIVER_CA_FILE='/secure/path/receiver-ca.crt'
export MATRIX_BRIDGE_CA_FILE='/secure/path/matrix-bridge-ca.crt'
export WAZUH_BRIDGE_CA_FILE='/secure/path/wazuh-bridge-ca.crt'

scripts/testing/resilience/provision-staging-monitoring.sh
```

The provisioner defaults to the vendored v0.93.1 bundle and validates its SHA-256 before applying it. To use an audited replacement bundle, pass both `PROMETHEUS_OPERATOR_BUNDLE` and its expected `PROMETHEUS_OPERATOR_BUNDLE_SHA256`.

## Reconciliation Acceptance Checks

After provisioning, perform these protected read-only checks before any synthetic receiver failure:

```bash
kubectl -n monitoring get prometheus platform alertmanager platform
kubectl -n monitoring get servicemonitor,prometheusrule,alertmanagerconfig
kubectl -n monitoring get pods
kubectl -n resilience-test get pods,servicemonitor
```

Then use authorized internal Prometheus/Alertmanager access to demonstrate:

1. The receiver `/metrics` target is active.
2. `resilience_circuit_breaker_patch_failures_total` is queryable.
3. `resilience:circuit_breaker_patch_failures_10m` is loaded.
4. `ResilienceCircuitBreakerPatchFailureEscalation` fires after exactly three synthetic patch failures.
5. The Alertmanager runtime configuration includes the Matrix/Wazuh fan-out route and each bridge receives a redacted firing payload.

## CNI Enforcement Script

Use `scripts/testing/resilience/test-staging-cni-policy-enforcement.sh` only after the above stack is reconciled and the Matrix/Wazuh bridge workloads exist. It requires an approved immutable net-test image containing `sh` and `nc`.

```bash
export STAGING_CNI_TEST_CONTEXT='REPLACE_WITH_APPROVED_STAGING_CONTEXT'
export STAGING_CNI='cilium' # or calico
export CONFIRM_STAGING_CNI_POLICY_TEST="${STAGING_CNI}:${STAGING_CNI_TEST_CONTEXT}:approved"
export STAGING_NETTEST_IMAGE='registry.example/nettest@sha256:REPLACE'
export MATRIX_EGRESS_HOST='matrix.matrix.svc'
export WAZUH_EGRESS_HOST='wazuh.wazuh.svc'

# Cilium only: cilium and hubble CLIs must target the approved cluster.
# Calico only: supply a reviewed read-only command that writes policy-flow evidence to stdout.
export CALICO_EVIDENCE_COMMAND='kubectl -n calico-system logs daemonset/calico-node --since=10m'

scripts/testing/resilience/test-staging-cni-policy-enforcement.sh
```

The script creates only four short-lived, tokenless probe Pods and deletes them at exit. It never changes a NetworkPolicy, CNI configuration, workload deployment, circuit-breaker state, or production namespace.
