# Staging Prometheus Operator and CNI Enforcement Package Validation

**Date:** 2026-09-04  
**Status:** Source package validated; no staging deployment or CNI traffic test executed.

## Delivered Components

| Component | Location | Validation result |
|---|---|---|
| Vendored Prometheus Operator bundle | `deploy/kubernetes/staging-monitoring/vendor/prometheus-operator-v0.93.1-bundle.yaml` | Official v0.93.1 bundle present; SHA-256 matches `1d38ea4ab904545f3203862c1a793b18fd53ab1e571fdbf47afb4dc9e33a98b8` |
| Staging monitoring resources | `deploy/kubernetes/staging-monitoring/` | Kustomize renders Prometheus, Alertmanager, kube-state-metrics, namespace, and ExternalSecret resources |
| Reconciliation selectors | `prometheus-alertmanager.yaml` and existing monitoring manifests | Prometheus selects `prometheus: platform` ServiceMonitors/rules; Alertmanager selects `alertmanagerConfig: enabled` routes |
| Guarded provisioner | `scripts/testing/resilience/provision-staging-monitoring.sh` | Bash syntax passed; empty-context execution refused before any cluster call |
| Cilium/Calico enforcement test | `scripts/testing/resilience/test-staging-cni-policy-enforcement.sh` | Bash syntax passed; empty-context execution refused before any cluster call |
| Existing resilience rules/routes | `deploy/kubernetes/monitoring/` | Recording rule and Matrix/Wazuh AlertmanagerConfig remain renderable and formatted |

## Guardrails

The provisioner requires an exact approved context, an explicit confirmation string, a checksummed local operator bundle, a non-production namespace label, existing External Secrets CRDs and ClusterSecretStore, approved digest-pinned images, a storage class, and readable staging CA files. It renders placeholders in a temporary directory and rejects unresolved values.

The CNI test script requires an exact staging context, an explicit confirmation string keyed to Cilium or Calico, a digest-pinned net-test image, and named Matrix/Wazuh egress hosts. It creates four tokenless disposable probe pods, executes expected allow/deny checks, captures Cilium Hubble or a caller-provided Calico evidence command, and removes only its probes on exit.

## Evidence Still Required

The package has not been applied to a staging cluster. Before closing the monitoring/CNI readiness gate, collect real controller and dataplane evidence:

1. Prometheus Operator reconciliation of `ServiceMonitor` and `PrometheusRule` resources.
2. Active receiver metrics scrape and successful rule evaluation.
3. AlertmanagerConfig merge into the active Alertmanager configuration.
4. Test-only TLS delivery of the three-failure escalation to both Matrix and Wazuh bridges.
5. Cilium Hubble dropped-flow records or Calico policy-log evidence for expected denied probes.
6. Successful CNI allowed-flow probes, with NetworkPolicy selectors and bridge labels matching the deployed pods.

## References

[1]: https://prometheus-operator.dev/docs/getting-started/installation/ "Prometheus Operator installation"
[2]: https://prometheus-operator.dev/docs/getting-started/design/ "Prometheus Operator resource selection"
[3]: https://docs.cilium.io/en/stable/observability/hubble/hubble-cli/ "Hubble CLI flow evidence"
[4]: https://docs.tigera.io/calico/latest/network-policy/policy-rules/log-rules "Calico policy logging"
[5]: https://kubernetes.io/docs/concepts/services-networking/network-policies/ "Kubernetes NetworkPolicy semantics"
