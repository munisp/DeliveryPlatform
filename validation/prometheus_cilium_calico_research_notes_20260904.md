# Prometheus Operator and CNI Enforcement Research Notes

## Prometheus Operator

Official installation guidance states that a real installation needs both CRDs and the operator with its required RBAC; version 0.84.0 and later requires Kubernetes 1.25 or newer because its CRDs use CEL. The documentation lists YAML bundles, kube-prometheus, and Helm as supported installation routes.

The design documentation states that Prometheus/Alertmanager instances are reconciled from instance CRs; `ServiceMonitor`, `PrometheusRule`, and `AlertmanagerConfig` are configuration CRs. A `Prometheus` CR selects ServiceMonitors using `serviceMonitorSelector` and `serviceMonitorNamespaceSelector`, and selects rules using `ruleSelector` and `ruleNamespaceSelector`. An `Alertmanager` CR selects `AlertmanagerConfig` objects using `alertmanagerConfigSelector` and `alertmanagerConfigNamespaceSelector`. Empty selectors have documented selection semantics; nil selectors can select no config resources.

The alerting guide explains that AlertmanagerConfig resources can be selected and merged by the Alertmanager resource, while PrometheusRule resources must match a Prometheus `ruleSelector`. It also notes that a nil `ruleSelector` selects no rules.

Sources:

1. https://prometheus-operator.dev/docs/getting-started/installation/
2. https://prometheus-operator.dev/docs/getting-started/design/
3. https://prometheus-operator.dev/docs/developer/alerting/

## Cilium

Official Hubble CLI guidance requires Cilium and Hubble to be running and accessible. `hubble observe` can filter flows, including `--verdict DROPPED`, and records policy denied traffic for TCP flows.

Source:

4. https://docs.cilium.io/en/stable/observability/hubble/hubble-cli/

## Calico

Official Calico documentation says Log rules can observe traffic for policy testing and troubleshooting. In iptables mode, logs can be collected from system/kernel logs; in eBPF mode, trace logs show final policy verdicts. Calico cautions that log rules can add overhead and should be removed after testing. Its eBPF logging prerequisites exclude containerized Kubernetes environments such as kind.

Source:

5. https://docs.tigera.io/calico/latest/network-policy/policy-rules/log-rules

## Kubernetes NetworkPolicy

Kubernetes documents that a NetworkPolicy has no effect without a network plugin that supports enforcement. Policy effects are additive, and a flow needs both applicable source egress and destination ingress permissions. Policy handling can be eventual, so tests should wait for convergence and gather CNI-level evidence.

Source:

6. https://kubernetes.io/docs/concepts/services-networking/network-policies/
