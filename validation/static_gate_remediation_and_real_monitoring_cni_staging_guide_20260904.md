# Static-Gate Remediation and Real Monitoring/CNI Staging Guide

**Prepared:** 2026-09-04  
**Scope:** Exact shell control-flow repair, protected-staging Prometheus Operator and Alertmanager reconciliation, and CNI-enforced NetworkPolicy testing for the resilience circuit-breaker flow.

> **Safety boundary:** The local kind fixture used compatibility CRDs and an inert mock controller only. It was deleted after evidence collection. The steps below describe the required **protected-staging** implementation and verification, not completed production evidence.

## 1. Static-Gate Failure: Root Cause and Exact Remediation

### 1.1 Observed symptom

The original full cross-language regression runner exited non-zero at `production_static_gate`. The generated `.audit-static-report.txt` showed zero findings for all prohibited-pattern checks, but stopped while enumerating durable-client indicators. The failure was therefore not a code-quality finding.

| Audit section | Finding before repair |
|---|---|
| Insecure random APIs | 0 matches |
| TODO/FIXME | 0 matches |
| Frontend `console.*` | 0 matches |
| Rust/Python stdout logging | 0 matches |
| Mock/stub/fake markers | 0 matches |
| Likely empty handlers | 0 matches |
| Durable-client indicator | Aborted on the circuit-breaker receiver |

### 1.2 Why the shell exited

The script uses:

```bash
set -euo pipefail
```

Its durable-client loop previously ran this pipeline directly:

```bash
grep -RIlE ... "$service" 2>/dev/null | tr '\n' ' '
```

For `services/go/resilience-circuit-breaker-alert-receiver`, there is intentionally no SQL, Redis, Kafka, or other datastore client. The receiver has only a fixed-scope Kubernetes API client used to conditionally PATCH one ConfigMap. `grep` therefore returned status `1` for “no matches.” With `pipefail` enabled, the pipeline status became non-zero; with `set -e`, the subshell that writes the report stopped immediately.

That behavior was incorrect because this loop is an **informational inventory**, not a required security gate. It also caused the outer full runner to fail before it could print `RESULT=PASS`.

### 1.3 Applied repair

The direct pipeline was replaced with a guarded assignment and an explicit classification:

```bash
durable_clients="$(grep -RIlE ... "$service" 2>/dev/null || true)"
if [[ -n "$durable_clients" ]]; then
  printf '%s' "$durable_clients" | tr '\n' ' '
elif [[ "$service" == "services/go/resilience-circuit-breaker-alert-receiver" ]]; then
  printf 'intentional fixed-scope Kubernetes ConfigMap patch receiver (no datastore client)'
else
  printf 'no durable-client indicator found'
fi
```

This retains `set -euo pipefail` and leaves all mandatory zero-match gates unchanged. The only behavioral change is that a zero-result informational scan is no longer fatal.

### 1.4 Regression proof

Run these commands from the repository root:

```bash
scripts/testing/audit-production-readiness.sh
scripts/testing/run-full-cross-language-regression.sh
```

Required outcomes are:

```text
services/go/resilience-circuit-breaker-alert-receiver: intentional fixed-scope Kubernetes ConfigMap patch receiver (no datastore client)
RESULT=PASS
```

The refreshed local full runner produced `RESULT=PASS` after the repair. This validates the script control flow and the local repository test suite; it is not a protected-staging deployment certification.

## 2. Replace the Mock Monitoring Fixture With a Real Monitoring Stack

The real chain is:

```text
receiver /metrics
  → ServiceMonitor selection and scrape
  → Prometheus recording rule
  → Prometheus alert rule
  → AlertmanagerConfig selection and merge
  → Alertmanager HTTPS webhook delivery
  → Matrix and Wazuh escalation bridges
```

The Prometheus Operator manages the lifecycle of Prometheus and Alertmanager instances and reconciles `ServiceMonitor`, `PrometheusRule`, and `AlertmanagerConfig` resources. A `Prometheus` resource must select the ServiceMonitor and rule labels, and an `Alertmanager` resource must select the AlertmanagerConfig labels. A CRD existing in the API server is insufficient: a reconciled instance must select it. [1] [2]

### 2.1 Install a real, pinned monitoring stack

Use a reviewed, pinned deployment method approved by platform security, such as the organization’s GitOps package or the `kube-prometheus-stack` chart. Do **not** use the local compatibility CRDs in staging.

The installed components must include:

| Component | Required purpose |
|---|---|
| Prometheus Operator | Reconciles monitoring CRDs into Prometheus/Alertmanager configuration |
| Prometheus | Scrapes receiver metrics and evaluates the recording/alert rules |
| Alertmanager | Receives alerts and sends Matrix/Wazuh webhooks |
| kube-state-metrics | Exposes Kubernetes Job status metrics consumed by invariant-probe rules |
| Prometheus Adapter only if otherwise needed | Not required for this circuit-breaker flow |
| CNI with NetworkPolicy enforcement | Enforces the declared ingress/egress policy, rather than merely storing API objects |

Before installing, pin chart/controller images by digest or organization-approved version, scan and sign them, and record the rendered manifests. The monitoring operator requires namespace-scoped or cluster-scoped RBAC appropriate to its documented CRDs; the circuit-breaker receiver itself must retain its far narrower `get`/`patch` permission to one ConfigMap only.

### 2.2 Create and label monitoring namespaces

```bash
kubectl create namespace monitoring
kubectl label namespace monitoring kubernetes.io/metadata.name=monitoring --overwrite
kubectl label namespace resilience-test resilience.delivery-platform.io/environment=non-production --overwrite
```

The namespace label is part of the runtime boundary checked by the protected workflow. Do not run resilience workflows in an unlabelled or production namespace.

### 2.3 Configure a real Prometheus resource

The receiver ServiceMonitor carries `prometheus: platform`; the Prometheus resource must explicitly select it and select the rule resource in `monitoring`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: platform
  namespace: monitoring
spec:
  serviceAccountName: prometheus-platform
  replicas: 2
  serviceMonitorSelector:
    matchLabels:
      prometheus: platform
  serviceMonitorNamespaceSelector:
    matchLabels:
      kubernetes.io/metadata.name: resilience-test
  ruleSelector:
    matchLabels:
      prometheus: platform
  ruleNamespaceSelector:
    matchLabels:
      kubernetes.io/metadata.name: monitoring
  alerting:
    alertmanagers:
      - namespace: monitoring
        name: alertmanager-platform
        port: web
```

The exact labels and namespace selectors must match the deployed manifests. A nil selector selects nothing for these configuration resources, so omission is a common silent reconciliation failure. [1] [2]

### 2.4 Configure a real Alertmanager resource

The Matrix/Wazuh `AlertmanagerConfig` carries `alertmanagerConfig: enabled`. The Alertmanager resource must select it:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Alertmanager
metadata:
  name: platform
  namespace: monitoring
spec:
  replicas: 2
  alertmanagerConfigSelector:
    matchLabels:
      alertmanagerConfig: enabled
  alertmanagerConfigNamespaceSelector:
    matchLabels:
      kubernetes.io/metadata.name: monitoring
```

Provide the external-secret-managed credentials and CA ConfigMaps named by the route:

```text
monitoring/matrix-escalation-bridge-auth      key: token
monitoring/wazuh-escalation-bridge-auth       key: token
monitoring/matrix-escalation-bridge-ca        key: ca.crt
monitoring/wazuh-escalation-bridge-ca         key: ca.crt
```

Use a test-only internal CA and test-only bearer tokens. Do not place actual tokens or CA private keys in Git. Alertmanager must only receive firing critical alerts for `ResilienceCircuitBreakerPatchFailureEscalation`; resolved alerts remain disabled, and neither endpoint receives Kubernetes credentials.

### 2.5 Verify real reconciliation before injecting a failure

Use the following read-only checks after the monitoring stack is healthy:

```bash
kubectl -n monitoring get prometheus,alertmanager
kubectl -n monitoring get servicemonitor,prometheusrule,alertmanagerconfig
kubectl -n monitoring get pods -l app.kubernetes.io/name=prometheus-operator
kubectl -n monitoring logs deploy/prometheus-operator --since=15m
kubectl -n monitoring get secret -l app.kubernetes.io/managed-by=prometheus-operator
```

Then check the Prometheus and Alertmanager UIs or their protected APIs using an authorized internal port-forward:

```bash
kubectl -n monitoring port-forward svc/prometheus-operated 9090:9090
curl --cacert "$PROMETHEUS_CA" -H "Authorization: Bearer $READ_ONLY_TOKEN" \
  'https://127.0.0.1:9090/api/v1/targets?state=active'

kubectl -n monitoring port-forward svc/alertmanager-operated 9093:9093
curl --cacert "$ALERTMANAGER_CA" -H "Authorization: Bearer $READ_ONLY_TOKEN" \
  'https://127.0.0.1:9093/api/v2/status'
```

Do not declare success based only on CRD presence. Acceptance requires an active receiver scrape target, rule groups loaded without evaluation errors, and an Alertmanager configuration that includes the selected route.

### 2.6 Exercise the real alert chain in bounded staging

1. Open an approved change with a bounded test window and `scenario:change_id` authorization.
2. Deploy the immutable receiver image and wait for its readiness probe.
3. Verify its `/metrics` target is `up == 1` and that the service account can only `get`/`patch` the named ConfigMap.
4. Produce exactly three **synthetic** receiver patch failures against the disposable test ConfigMap. Do not use a production ConfigMap or live payment callback.
5. Query Prometheus for:

```promql
resilience_circuit_breaker_patch_failures_total
resilience:circuit_breaker_patch_failures_10m
ALERTS{alertname="ResilienceCircuitBreakerPatchFailureEscalation"}
```

6. Confirm a firing critical alert in Alertmanager and one redacted delivery to each self-hosted Matrix/Wazuh bridge.
7. Confirm the bridges cannot read Secrets or mutate Kubernetes objects.
8. Preserve target/rule/alert/receiver logs, alert fingerprint, redacted bridge receipt, receiver metrics, and ConfigMap audit event.
9. Stop the test, remove synthetic failure configuration, and leave the circuit breaker in the operator-approved state only after recovery evidence.

## 3. Configure a CNI That Enforces NetworkPolicy

Creating NetworkPolicy objects has no traffic effect unless the selected CNI implements NetworkPolicy enforcement. Kubernetes documents this as a prerequisite, and the policy model is additive: a connection must satisfy both source egress and destination ingress policy where both apply. [3]

### 3.1 Required CNI decision

Use an organization-supported CNI distribution with verified Kubernetes NetworkPolicy support, such as Cilium or Calico. The choice must be recorded in the staging architecture decision and installed before the resilience namespace is used for acceptance testing.

The required properties are:

| Requirement | Why it matters |
|---|---|
| Enforces Kubernetes `networking.k8s.io/v1` NetworkPolicy | Prevents policies from being API-only declarations |
| Enforces ingress and egress | The Matrix/Wazuh bridge policies restrict both directions |
| Supports namespace and pod selectors | The manifests depend on `monitoring` namespace and Alertmanager labels |
| Observable deny decisions | Enables incident evidence and false-positive diagnosis |
| Tested in the actual staging topology | Avoids differences between a local kind CNI and target cluster dataplane |

### 3.2 Preflight checks

```bash
kubectl -n kube-system get pods -o wide
kubectl get networkpolicy -A
kubectl get namespace monitoring resilience-test matrix wazuh --show-labels
kubectl -n resilience-test get networkpolicy matrix-escalation-bridge-isolation wazuh-escalation-bridge-isolation
```

Confirm the real bridge pod labels match the policy selectors exactly:

```bash
kubectl -n resilience-test get pods -l app.kubernetes.io/name=matrix-escalation-bridge --show-labels
kubectl -n resilience-test get pods -l app.kubernetes.io/name=wazuh-escalation-bridge --show-labels
kubectl -n monitoring get pods -l app.kubernetes.io/name=alertmanager --show-labels
```

### 3.3 CNI dataplane test matrix

Run short-lived test clients in dedicated, labelled namespaces. The test clients must have no production secrets, payment data, or customer data.

| Source | Destination | Expected outcome | Evidence |
|---|---|---|---|
| Labelled Alertmanager client in `monitoring` | Matrix bridge TCP 8443 | Allowed | HTTPS success and bridge access log |
| Labelled Alertmanager client in `monitoring` | Wazuh bridge TCP 8443 | Allowed | HTTPS success and bridge access log |
| Unlabelled pod in `monitoring` | Either bridge TCP 8443 | Denied | Connection timeout/refusal and CNI flow/deny record |
| Pod in another namespace | Either bridge TCP 8443 | Denied | Connection timeout/refusal and CNI flow/deny record |
| Matrix bridge | Matrix service TCP 8448 | Allowed | Synthetic TLS/HTTP health endpoint success |
| Matrix bridge | Wazuh service TCP 55000 | Denied | Connection timeout/refusal and CNI flow/deny record |
| Wazuh bridge | Wazuh service TCP 55000 | Allowed | Synthetic health endpoint success |
| Either bridge | Arbitrary external/internal target | Denied except DNS | CNI flow/deny record |

Use protocol-appropriate probes and a bounded timeout. For example:

```bash
kubectl -n monitoring run allowed-alertmanager-probe --rm -i --restart=Never \
  --labels='app.kubernetes.io/name=alertmanager' \
  --image=REPLACE_WITH_APPROVED_NETTEST_IMAGE_DIGEST -- \
  sh -ec 'wget -qO- --timeout=5 https://matrix-escalation-bridge.resilience-test.svc:8443/healthz'

kubectl -n monitoring run denied-probe --rm -i --restart=Never \
  --labels='app.kubernetes.io/name=untrusted-probe' \
  --image=REPLACE_WITH_APPROVED_NETTEST_IMAGE_DIGEST -- \
  sh -ec '! wget -qO- --timeout=5 https://matrix-escalation-bridge.resilience-test.svc:8443/healthz'
```

Use a pre-approved test image by immutable digest rather than an unreviewed public tag. Correlate client timestamps with CNI flow logs and bridge access logs. Kubernetes warns that policy implementation is eventual and varies by network plugin, so allow for short convergence before recording test outcomes. [3]

## 4. Evidence Gate and Rollback Requirements

The following are release blockers for the real staging exercise:

| Gate | Required evidence | Failure action |
|---|---|---|
| Operator reconciliation | Selected ServiceMonitor, PrometheusRule, and AlertmanagerConfig visible in active runtime configuration | Stop; correct selectors/labels/CRD compatibility |
| Receiver scrape | Receiver target healthy and metric values queryable | Stop; correct TLS, CA, service labels, or NetworkPolicy |
| Alert chain | Recording rule and critical alert fire after three synthetic failures | Stop; correct metric/rule selector or scrape interval |
| Escalation delivery | One redacted Matrix and Wazuh delivery with valid internal TLS | Stop; correct certificate, secrets, bridge readiness, or route |
| CNI enforcement | All allowed/denied matrix rows observed with flow evidence | Stop; correct CNI install or policy selectors; do not claim policy enforcement |
| Fail-closed authority | Receiver remains limited to one ConfigMap and bridge SAs remain unable to read Secrets/mutate resources | Stop; revoke excess RBAC and rotate test tokens |

Rollback consists of ending the test client Jobs, deleting only the synthetic alert/failure fixture, clearing injected network faults, retaining the circuit breaker’s fail-closed state until authorized recovery, and preserving all evidence. It does **not** authorize automatic circuit-breaker closure or production workload changes.

## References

[1]: https://prometheus-operator.dev/docs/getting-started/design/ "Prometheus Operator design and selectors"
[2]: https://prometheus-operator.dev/docs/developer/alerting/ "Prometheus Operator alerting routes and AlertmanagerConfig selection"
[3]: https://kubernetes.io/docs/concepts/services-networking/network-policies/ "Kubernetes NetworkPolicy prerequisites and semantics"
