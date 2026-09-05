# Integration-Cluster Execution Boundary and Circuit-Breaker Recovery Procedure

**Date:** 2026-09-04  
**Execution result:** Deployment and CNI testing were not executed because no live integration cluster is available in the current environment.

## Integration-Cluster Preflight Result

| Check              | Observed result                                  | Consequence                                                      |
| ------------------ | ------------------------------------------------ | ---------------------------------------------------------------- |
| Configured context | `kind-deliveryplatform-ci` remains in kubeconfig | It is a stale local context, not an approved integration context |
| Kind clusters      | `No kind clusters found`                         | No local API server exists                                       |
| Kubernetes API     | Connection to `127.0.0.1:40261` refused          | No manifest can be safely applied                                |
| Container runtime  | No running local test containers                 | No bridge/service fixture is available                           |
| CNI dataplane      | Unavailable                                      | No Cilium Hubble or Calico policy evidence can be captured       |

The staging-monitoring provisioner and CNI test script were deliberately not invoked because each requires an exact reachable context, explicit confirmation, non-production namespace labels, and real prerequisites. No partial deploy, fake CNI success, or stale-context retry was attempted.

## Immediate Stop and Rollback

The guarded command is `scripts/testing/resilience/manage-staging-resilience-circuit-breaker.sh`. It accepts only `open` or `close` and first requires the exact expected non-production context and a `resilience-test` namespace label of `resilience.delivery-platform.io/environment=non-production`.

### 1. Preserve Evidence Before Mutating State

Run these read-only commands first and archive their output under the incident/change ID:

```bash
kubectl -n resilience-test get configmap resilience-validation-circuit-breaker -o yaml
kubectl -n resilience-test get testrun,podchaos,job,pod -o wide
kubectl -n resilience-test get events --sort-by=.lastTimestamp
kubectl -n resilience-test logs deploy/resilience-circuit-breaker-alert-receiver --all-containers --since=30m
kubectl -n monitoring get prometheusrule,alertmanagerconfig,servicemonitor -o yaml
```

Do not delete a failed invariant Job, receiver logs, Alertmanager event, or CNI flow evidence before preserving it.

### 2. Open the Breaker and Stop the Active Test

Select one approved reason: `invariant-probe-failure`, `alerted-financial-anomaly`, `unexpected-egress`, `assignment-anomaly`, `provider-queue-anomaly`, `cleanup-failure`, or `operator-stop`.

```bash
export RESILIENCE_TEST_CONTEXT='approved-integration-context'
export TARGET_ENV='staging'
export INCIDENT_ID='INCIDENT-20260904-001'
export CIRCUIT_REASON='invariant-probe-failure'
export CONFIRM_CIRCUIT_BREAKER_ACTION="open:${INCIDENT_ID}"
export PROVIDER_SIMULATOR_UPSTREAM='https://test-provider-simulator.internal'

scripts/testing/resilience/manage-staging-resilience-circuit-breaker.sh open
```

The command patches only `resilience-test/resilience-validation-circuit-breaker` to `state=open`, records the incident metadata, requests deletion of the fixed `ride-payment-ingress` TestRun, removes the fixed PodChaos manifest, and clears Toxiproxy only when a simulator upstream is explicitly supplied. It does not patch Deployment state, close the breaker, alter credentials, or mutate a production namespace.

### 3. Stabilize the Affected Component

After the breaker is open, suspend new resilience scenarios and remove the direct failure cause. For a receiver rollout defect, use the normal immutable release rollback path:

```bash
kubectl -n resilience-test rollout undo deployment/resilience-circuit-breaker-alert-receiver
kubectl -n resilience-test rollout status deployment/resilience-circuit-breaker-alert-receiver --timeout=300s
```

For a rule/route defect, delete only the named resilience resources after confirming they are not shared:

```bash
kubectl -n monitoring delete --ignore-not-found alertmanagerconfig resilience-matrix-wazuh-escalation
kubectl -n monitoring delete --ignore-not-found prometheusrule deliveryplatform-resilience-invariant-probe
```

Do not delete Prometheus Operator CRDs as an application rollback. They can be shared by unrelated monitored resources.

### 4. Verify Recovery Before Closure

The current deployed operator command implements a strict two-state control: `closed` and `open`. It does **not** implement a webhook-controlled close or an operator half-open state. The automated receiver may only open the breaker. Manual closure requires an incident ID, a separately supplied recovery evidence ID, exact context/namespace checks, and a deliberate confirmation string.

Before allowing closure, the recovery owner must collect and approve evidence that:

1. The receiver deployment is ready and its metrics target is active.
2. No `ResilienceCircuitBreakerPatchFailureEscalation` alert is firing.
3. The invariant probe has passed and the signed webhook queue is drained.
4. Ledger, payment verification, offer, and assignment invariant queries are clean.
5. Toxiproxy and PodChaos resources are absent.
6. Matrix/Wazuh test events are redacted, delivered as expected, and neither bridge has Kubernetes mutation authority.
7. Any CNI allow/deny test evidence required by the change is archived.

### 5. Close Only With Recovery Evidence

```bash
export RESILIENCE_TEST_CONTEXT='approved-integration-context'
export TARGET_ENV='staging'
export INCIDENT_ID='INCIDENT-20260904-001'
export RECOVERY_EVIDENCE_ID='RECOVERY-20260904-001'
export CONFIRM_CIRCUIT_BREAKER_ACTION="close:${INCIDENT_ID}"

scripts/testing/resilience/manage-staging-resilience-circuit-breaker.sh close
```

The command refuses closure unless the breaker is currently `open`. It writes `state=closed`, `closed_at`, `closed_by`, `reason=recovery-approved`, and the immutable recovery-evidence reference. It does **not** authorize a new test scenario; a new change approval remains required.

## Required Inputs to Resume Integration Testing

To execute the requested deployment and CNI evidence run, provide an approved reachable integration context with non-production labels, a real Cilium or Calico deployment, External Secrets Operator and `platform-staging-secrets`, approved digest-pinned images, storage class, CA files, test-only bridge services/labels, and the required Matrix/Wazuh test endpoints. Then execute the guarded provisioner first, followed by the CNI script, retaining the produced evidence directory.
