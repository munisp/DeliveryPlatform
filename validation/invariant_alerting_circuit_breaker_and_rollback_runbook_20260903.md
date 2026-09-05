# Invariant-Probe Alerting, Circuit Breaker, and Rollback Runbook

**Scope.** This runbook covers the isolated `resilience-test` namespace used by the protected Sprint 2 staging-chaos workflow. It describes the exact invariant Job, Prometheus alert rules, automated fail-closed behavior, manual immediate-stop procedure, and recovery authorization process.

> **Safety boundary:** An invariant failure is a P0 validation anomaly. It stops the current test and blocks new resilience runs. It does not authorize production testing, live-money actions, automatic rollout reversal, or deletion/modification of durable application data.

## 1. Exact deployable resources

### 1.1 Circuit-breaker ConfigMap

Apply this ConfigMap as reviewed infrastructure in the isolated namespace before any protected run. Its `state` defaults to `closed`, allowing an explicitly approved test. A controller failure after the circuit is armed patches it to `open`; a subsequent run refuses to start until a separately approved recovery action closes it.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: resilience-validation-circuit-breaker
  namespace: resilience-test
  labels:
    app.kubernetes.io/name: resilience-validation-circuit-breaker
    app.kubernetes.io/part-of: deliveryplatform-resilience-testing
    resilience.delivery-platform.io/environment: non-production
data:
  state: "closed"
  incident_id: ""
  opened_at: ""
  opened_by: ""
  reason: ""
  recovery_evidence_id: ""
  closed_at: ""
  closed_by: ""
```

The checked-in manifest is `deploy/kubernetes/resilience-test/circuit-breaker.yaml`.

### 1.2 Exact invariant-probe Job template

The controller replaces only `RESILIENCE_INVARIANT_PROBE_JOB_NAME` with a safe run-derived name. The job receives the reviewed SQL through `resilience-invariant-probe-sql` and reads the disposable database URL only from the test namespace secret `resilience-invariant-probe-database`. It has no Kubernetes API token, Linux capabilities, writable root filesystem, or restart retries.

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: RESILIENCE_INVARIANT_PROBE_JOB_NAME
  namespace: resilience-test
  labels:
    app.kubernetes.io/name: resilience-invariant-probe
    app.kubernetes.io/part-of: deliveryplatform-resilience-testing
    resilience.delivery-platform.io/environment: non-production
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels:
        app.kubernetes.io/name: resilience-invariant-probe
        app.kubernetes.io/part-of: deliveryplatform-resilience-testing
        resilience.delivery-platform.io/environment: non-production
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 999
        runAsGroup: 999
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: invariant-probe
          image: postgres:16.6-bookworm
          imagePullPolicy: IfNotPresent
          command: ["psql"]
          args: ["$(DATABASE_URL)", "-v", "ON_ERROR_STOP=1", "-f", "/sql/invariant-probe.sql"]
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: resilience-invariant-probe-database
                  key: database-url
          volumeMounts:
            - name: invariant-probe-sql
              mountPath: /sql
              readOnly: true
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "250m"
              memory: "256Mi"
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
      volumes:
        - name: invariant-probe-sql
          configMap:
            name: resilience-invariant-probe-sql
            defaultMode: 0444
```

**Target-cluster change required:** Replace the PostgreSQL image tag with an approved immutable digest before a production-readiness decision. The current tagged test image is an execution template, not proof of supply-chain admission enforcement.

### 1.3 Exact PrometheusRule

The alert rule relies only on kube-state-metrics Job-status series in the `resilience-test` namespace, so it can detect an invariant Job failure before application-specific metrics have been added. The rule is included in `deploy/kubernetes/monitoring/kustomization.yaml` and must be applied only after Prometheus Operator and kube-state-metrics are present and the expressions have been verified against target-cluster metric labels.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: deliveryplatform-resilience-invariant-probe
  namespace: monitoring
  labels:
    app.kubernetes.io/part-of: deliveryplatform
    prometheus: platform
    resilience.delivery-platform.io/environment: non-production
spec:
  groups:
    - name: deliveryplatform.resilience-invariant-probe
      rules:
        - alert: DeliveryPlatformResilienceInvariantProbeFailed
          expr: max by (namespace, job_name) (kube_job_status_failed{namespace="resilience-test",job_name=~"resilience-invariant-.*"}) > 0
          for: 0m
          labels:
            severity: critical
            service: deliveryplatform-resilience
            circuit_breaker: open
          annotations:
            summary: "Resilience invariant probe {{ $labels.job_name }} failed"
            description: "The isolated PostgreSQL probe detected a queue, offer, assignment, ledger, verification, or webhook-processing anomaly. Stop the active TestRun, clear Toxiproxy, delete PodChaos, open the resilience circuit breaker, and start the P0 incident procedure."
            runbook_url: "https://REPLACE_WITH_RUNBOOK_HOST/resilience-invariant-probe"
        - alert: DeliveryPlatformResilienceInvariantProbeStalled
          expr: (time() - max by (namespace, job_name) (kube_job_status_start_time{namespace="resilience-test",job_name=~"resilience-invariant-.*"}) > 2100) and on (namespace, job_name) (max by (namespace, job_name) (kube_job_status_succeeded{namespace="resilience-test",job_name=~"resilience-invariant-.*"}) == 0) and on (namespace, job_name) (max by (namespace, job_name) (kube_job_status_failed{namespace="resilience-test",job_name=~"resilience-invariant-.*"}) == 0)
          for: 1m
          labels:
            severity: critical
            service: deliveryplatform-resilience
            circuit_breaker: open
          annotations:
            summary: "Resilience invariant probe {{ $labels.job_name }} exceeded its 35-minute window"
            description: "The isolated invariant Job has neither succeeded nor failed after its bounded window. Stop the active TestRun, clear injected faults, open the resilience circuit breaker, preserve artifacts, and investigate queue drain, database availability, and Job status."
            runbook_url: "https://REPLACE_WITH_RUNBOOK_HOST/resilience-invariant-probe"
```

The currently included third warning rule (`DeliveryPlatformResilienceInvariantProbeMissing`) must be validated in the target Prometheus before it is used for paging because a generic “not succeeded” state cannot distinguish all intentionally pending Job states from missing scrape coverage. It is **not** a circuit-breaker trigger.

## 2. Circuit-breaker trigger policy

The workflow controller automatically opens the circuit breaker when its armed scenario exits non-zero or when it cannot verify cleanup. The Prometheus `critical` alerts page the accountable responders but do not independently patch Kubernetes configuration; an automated Alertmanager-to-cluster mutation must not be enabled without a separate security review. The incident commander/operator invokes the guarded circuit-breaker command after confirming the anomaly.

| Trigger | Severity | Immediate automatic controller action | Required human action |
|---|---|---|---|
| Invariant Job failure | P0 | Workflow fails; trap captures pre-cleanup state, stops any active TestRun, clears tracked Toxiproxy/PodChaos fault, and opens the circuit. | Declare P0, preserve evidence, verify no active fault/test remains, reconcile state, and investigate. |
| Invariant Job stalled beyond 35 minutes | P0 | Workflow wait fails; same fail-closed cleanup/circuit opening. Alert pages responders. | Treat as potential queue/DB/Job outage; investigate before close. |
| k6 `TestRun.status.stage` becomes `error` or `stopped` | P1; P0 if coupled with financial/assignment anomaly | Stops/cleans active fault and opens circuit once armed. | Determine whether failure was infrastructure/tooling or safety/financial; retain artifacts. |
| TestRun never reports a stage / exceeds 1,500 seconds | P1 | Stops the TestRun, clears known faults, opens circuit. | Investigate operator/controller/cluster scheduler and verify no residual runner workload. |
| Toxiproxy fault injection or cleanup fails | P1; P0 if traffic can remain faulted or reach unintended destination | Controller attempts cleanup and opens circuit on cleanup failure. | Confirm proxy state and route manually; isolate/scale down resilience payment workload if proxy cannot be cleared. |
| PodChaos cleanup fails or matching rollout does not recover | P1; P0 if assignment integrity is affected | Controller deletes known PodChaos, checks rollout, fails closed/open circuit. | Confirm no PodChaos remains and matching resilience replicas are healthy before any recovery approval. |
| Any duplicate pending offer/live assignment, unbalanced ledger, captured/settled but unverified payment, or signed webhook error | P0 | Invariant Job fails, causing controller cleanup and circuit opening. | Freeze further scenarios, finance/SRE/security triage, preserve database evidence, run reconciliation; no data repair without approval. |
| Unexpected egress, Secret access, or wrong target/context | P0 | Script preflight refuses before arming where detected. | Stop work, revoke/rotate affected test secret/identity if needed, conduct security incident assessment. |
| Payment queue breach or provider anomaly reported by application monitoring | P1 or P0, depending on monetary state/integrity | Alert only until app metric-to-controller integration is separately approved. | Open breaker manually with `provider-queue-anomaly` or `alerted-financial-anomaly`; then follow this runbook. |
| Operator observes unsafe/unexpected behavior | P0/P1 by impact | No expectation to wait for automated test conclusion. | Use immediate operator stop with reason `operator-stop`. |

## 3. Immediate rollback procedure

### 3.1 First five minutes — stop and preserve

1. The incident commander declares the validation window stopped. Do not begin another scenario and do not close the circuit.
2. Identify the **exact** non-production context and namespace. Never copy the following commands into a production context.
3. Open the circuit breaker with an allowed reason. The operator command first opens the ConfigMap, then requests deletion of the active TestRun, deletes the known PodChaos object, and attempts to clear the Toxiproxy toxic. It requires an exact confirmation binding to the incident ID.

```bash
export RESILIENCE_TEST_CONTEXT=delivery-staging-resilience
export RESILIENCE_TEST_NAMESPACE=resilience-test
export TARGET_ENV=staging
export INCIDENT_ID=INC-20260903-001
export CIRCUIT_REASON=invariant-probe-failure
export PROVIDER_SIMULATOR_UPSTREAM=provider-simulator.resilience-test.svc.cluster.local:8080
export CONFIRM_CIRCUIT_BREAKER_ACTION=open:${INCIDENT_ID}

scripts/testing/resilience/manage-staging-resilience-circuit-breaker.sh open
```

Allowed reasons are intentionally limited to:

```text
invariant-probe-failure
alerted-financial-anomaly
unexpected-egress
assignment-anomaly
provider-queue-anomaly
cleanup-failure
operator-stop
```

4. Capture the controller/TestRun/Job/PodChaos/Pod/Event artifacts, dashboard time window, alert fingerprint, traces, redacted application logs, configuration/image digests, and proxy status before any manual remediation. Do not print or archive secret values, payment credentials, full raw HMAC headers, PAN/CVV, or unnecessary raw location data.
5. Verify the stop state:

```bash
kubectl -n resilience-test get testrun,podchaos,pods,jobs
kubectl -n resilience-test get configmap resilience-validation-circuit-breaker \
  -o jsonpath='{.data.state}{" incident="}{.data.incident_id}{" reason="}{.data.reason}{"\n"}'
```

Expected result is a circuit `state` of `open`, no active PodChaos, and no active TestRun. If Toxiproxy cannot be cleared, temporarily scale the **resilience payment deployment only** to zero, confirm the simulator-only route, and escalate to SRE/security. Do not modify shared staging or production workloads as a shortcut.

### 3.2 Stabilize the isolated environment

| Anomaly type | Stabilization action | Preserve / verify |
|---|---|---|
| Ledger imbalance or unverified payment state | Keep payment resilience worker stopped if needed; preserve PostgreSQL snapshot/logical evidence; prohibit ledger repair or payout state transitions; run approved reconciliation queries. | Provider callback/verification chronology, transaction/posting rows, idempotency keys, queue rows, deployment/revision. |
| Duplicate offer or assignment | Keep matching resilience worker stopped if ongoing duplicate creation is plausible; preserve trip/offer/guard/event chronology; prevent test rerun. | Driver/Trip IDs, match attempt/rank/correlation, guard rows, transactions/traces, cache/outbox evidence. |
| Queue non-drain/processing error | Remove injected fault, confirm provider simulator readiness and worker health, retain the queue records; do not delete callbacks to make the probe pass. | Queue ages, attempts/reasons, worker logs/traces, provider status, DB pool/lock metrics. |
| Toxiproxy failure/residual fault | Use `toxiproxy-payment-faults.sh clear` through the exact context; if unable to clear, scale down only test payment workload and remove Toxiproxy route after evidence capture. | Proxy status/toxics, NetworkPolicy, DNS resolution, payment-worker configuration. |
| PodChaos residual/replica failure | Delete the fixed PodChaos manifest; wait for matching rollout; check PDB/HPA/node events. | PodChaos object, events, deployment revision, replica readiness, request/error trends. |
| Unexpected egress/identity/Secret event | Stop TestRun/workloads; revoke/rotate test identities and keys; preserve audit records; assess whether boundary was truly isolated. | Network flow/DNS, Kubernetes audit, workload identity logs, secret access logs, CNI policy evidence. |

### 3.3 Deployment rollback is a separate decision

The circuit breaker rolls back **the validation activity**, not the application release. It deletes the TestRun/PodChaos and clears the simulated gateway fault. A deployment rollback is justified only after triage shows that a newly deployed resilience application/configuration revision caused or materially worsened the anomaly.

If a rollback is authorized, use the protected staging deployment mechanism and the previously approved immutable image/configuration revision. Re-run migration compatibility and health checks; do not reverse schema migrations containing financial/assignment facts without a separately reviewed data-recovery plan. Record the rollback change ID, image digest, configuration revision, operator, start/end time, and effect in the incident dossier.

## 4. Investigation and recovery close procedure

The circuit must remain open until the incident commander, finance owner for financial scenarios, SRE, and security/compliance as relevant agree that the anomaly is understood and recovery evidence is complete. Minimum requirements are: cause/hypothesis, impact bound, remediation, successful targeted regression/invariant run, proxy/PodChaos/TestRun absence, dashboard recovery, reconciliation as relevant, and a dated evidence reference.

The recovery close is explicitly separate from authorizing another experiment:

```bash
export RESILIENCE_TEST_CONTEXT=delivery-staging-resilience
export RESILIENCE_TEST_NAMESPACE=resilience-test
export TARGET_ENV=staging
export INCIDENT_ID=INC-20260903-001
export RECOVERY_EVIDENCE_ID=EV-20260903-042
export CONFIRM_CIRCUIT_BREAKER_ACTION=close:${INCIDENT_ID}

scripts/testing/resilience/manage-staging-resilience-circuit-breaker.sh close
```

The close command refuses if the breaker is not already open, requires a non-empty constrained evidence ID, and records `closed_at`, `closed_by`, and `recovery_evidence_id` without overwriting the original `incident_id`, `opened_at`, or `opened_by` evidence. A new scenario still requires its own single-scenario change approval and protected-environment review.

## 5. Validation boundaries and next implementation dependency

The Job-status Prometheus alerts are deployable now where Prometheus Operator and kube-state-metrics exist. They provide a reliable control-plane signal for completed/failed/stalled invariant Jobs. Application-level circuit triggers—such as matching p95 breach, request error ratio, provider verification latency, queue depth/age, and unverified-money counters—require the service metric instrumentation and target-cluster scrape validation documented in the readiness roadmap. Until that implementation exists, use the alerting specification and manual circuit-breaker operation; do not fabricate alerts over nonexistent series.

## References

[1]: ../deploy/kubernetes/resilience-test/invariant-probe-job.yaml "Invariant Job template"

[2]: ../deploy/kubernetes/resilience-test/invariant-probe.sql "Invariant SQL source"

[3]: ../deploy/kubernetes/monitoring/resilience-invariant-probe-rules.yaml "Invariant Job alert rules"

[4]: ../scripts/testing/resilience/run-staging-chaos-validation.sh "Protected staging chaos controller"

[5]: ../scripts/testing/resilience/manage-staging-resilience-circuit-breaker.sh "Guarded circuit-breaker operator command"

[6]: invariant_probe_and_sprint2_change_approval_readiness_20260903.md "Probe semantics and approval readiness"
