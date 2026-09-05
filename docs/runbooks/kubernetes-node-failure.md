# Kubernetes Node Failure Operations Runbook

**Service:** DeliveryPlatform  
**Audience:** Primary on-call, incident commander, platform/SRE, application owner, security liaison  
**Trigger:** Node readiness loss, node pressure, delivery workload availability loss, PDB exhaustion, HPA saturation, or restart storm alert

## Purpose and operating principles

This runbook provides the operational response for a Kubernetes node failure affecting the `switchos` namespace. It applies to the central TypeScript application, six Go services, five Python services, and the pricing/dispatch Rust services. The deployment design keeps at least one replica available for every two-replica service and at least two replicas available for the central application during one node loss, subject to healthy remaining node capacity and correct scheduler operation.

> **Safety rule:** Do not force-delete Pods, manually remove PDBs, scale a Deployment below its PDB minimum, or rotate secrets during the first containment phase. These actions can turn a recoverable node failure into an avoidable multi-service outage.

## Monitoring and alerting

The alert definitions are in [`deploy/kubernetes/monitoring/prometheus-rules.yaml`](../../deploy/kubernetes/monitoring/prometheus-rules.yaml). Alertmanager routing must map `severity: critical` to the primary on-call paging policy and `severity: warning` to the platform team’s actionable queue.

| Alert | Severity | Meaning | First response target |
|---|---|---|---|
| `DeliveryPlatformNodeNotReady` | Critical | A node has been unready for ten minutes. | Acknowledge within 5 minutes; confirm workload impact within 10 minutes. |
| `DeliveryPlatformNodePressure` | Warning | Memory, disk, or PID pressure has persisted for ten minutes. | Investigate capacity and eviction risk within 15 minutes. |
| `DeliveryPlatformDeploymentUnavailable` | Critical | Available replicas are below the Deployment specification for ten minutes. | Restore ready capacity or escalate within 15 minutes. |
| `DeliveryPlatformPDBExhausted` | Warning | A workload has no safe voluntary-disruption headroom. | Freeze maintenance actions; confirm whether an involuntary node loss occurred. |
| `DeliveryPlatformHPAMaxedOut` | Warning | The HPA has been at maximum replicas for fifteen minutes. | Confirm demand versus capacity and begin scale/capacity decision. |
| `DeliveryPlatformContainerRestartStorm` | Warning | A container restarted at least three times in fifteen minutes. | Inspect events, probes, logs, dependency state, and recent release. |
| `DeliveryPlatformExternalSecretNotReady` | Critical | External secret synchronization has failed for ten minutes. | Confirm secret-store health and block any rollout requiring new secrets. |

The dashboard must combine node readiness and pressure, node allocatable versus requested CPU/memory, Deployment desired/current/available replicas, ReplicaSet events, pending-pod reasons, HPA desired/current/max replicas, PDB healthy/desired/disruptions-allowed, container restarts, ingress error rates, PostgreSQL connection saturation, and ExternalSecret readiness.

## Triage procedure

### 1. Establish incident scope

Acknowledge the page, open an incident record, and assign an incident commander for any alert that is Critical or affects more than one DeliveryPlatform Deployment. Record the failed node, alert timestamps, affected Deployments, current release revision, ongoing maintenance, and whether a cluster-wide control-plane or CNI issue is suspected.

| Command | Expected evidence |
|---|---|
| `kubectl get nodes -o wide` | Node readiness, version, internal IP, and role. |
| `kubectl get pods -n switchos -o wide` | Pods previously on the failed node, replacement placement, and readiness. |
| `kubectl get deploy,hpa,pdb -n switchos` | Desired/current/available replicas, HPA targets, and disruption headroom. |
| `kubectl get events -n switchos --sort-by=.lastTimestamp` | Scheduling, probe, image, PDB, and eviction reasons. |
| `kubectl describe node NODE` | Conditions, taints, allocatable capacity, and eviction pressure. |

If the failed node hosted no DeliveryPlatform Pods, continue monitoring until it is restored but do not declare an application incident solely from the node alert. If it hosted application Pods, continue immediately with containment.

### 2. Contain unsafe changes

Pause all non-emergency deployments, node drains, Cluster Autoscaler changes, HPA limit changes, migration Jobs, and secret rotations. Confirm that the migration Job is not in progress. Verify that PDBs remain present and that `disruptionsAllowed` is zero for workloads that lost a replica; that is the correct protective state after a node failure.

If an active deployment is independently causing probe failures, use the existing revision history to roll back only after confirming that the node failure is not the root cause. Record every change in the incident log.

### 3. Confirm scheduler recovery

The two-replica Go, Python, pricing, and dispatch services use a strict two-hostname spread rule. One node loss leaves one healthy replica; the scheduler should place the replacement on the other healthy node. The three-replica central application uses preferred anti-affinity and should retain two replicas immediately, then restore its desired/HPA target across the remaining nodes.

| Verification | Healthy result | Escalation condition |
|---|---|---|
| Replacement Pods | New Pods are scheduled on healthy nodes and transition to Ready. | Pods remain `Pending` for more than 5 minutes. |
| PDB | Affected two-replica services remain at one healthy Pod; central remains at two. | Current healthy replicas fall below PDB desired healthy value. |
| HPA | Desired replicas remains within configured min/max and HPA conditions show no metric error. | HPA is unable to calculate metrics or remains maxed with unavailable Pods. |
| Probes | Startup/readiness recover; no growing restart count. | Repeated probe failure, `CrashLoopBackOff`, or dependency errors. |
| Data plane | Authenticated health/API checks succeed through in-cluster service and ingress. | 5xx, authentication failure, or database/policy/secret errors. |

## Recovery playbooks

### Node remains unavailable but workload recovers

Keep the node cordoned. Do not drain it while affected PDBs have no voluntary-disruption headroom. Verify that replacement Pods are Ready, HPA has reconciled, service error rates are normal, and database connection capacity remains below the defined budget. Coordinate with the infrastructure provider to repair or replace the node. Once the node has been repaired and is Ready, uncordon it only after confirming it has current CNI, kubelet, runtime, and security patches.

### Replacement Pods remain pending

Inspect `kubectl describe pod POD -n switchos` for resource insufficiency, taint/toleration mismatch, topology spread, PVC attachment, image-pull, or admission-policy denial. Add capacity by bringing up a healthy node or scaling the node group; do not lower PDB minima. If strict topology spreading prevents placement because fewer than two healthy nodes remain, restore a second node first. If the speech-runtime PVC blocks scheduling, confirm the storage class and volume attachment health before moving or recreating the Pod.

### HPA is maxed while availability is degraded

Treat this as a capacity incident. Confirm whether traffic is legitimate, a retry storm is occurring, or a dependency latency increase is inflating CPU. For pricing/dispatch, check PostgreSQL connection utilization and query latency before raising replica counts or database pool limits. Scale the node group or use the approved emergency capacity procedure. Do not increase HPA maximums until the database connection and dependency budgets have been recalculated.

### PDB prevents a necessary maintenance action

A zero-disruptions-allowed PDB after node loss is expected. Restore workload availability first. For a maintenance action unrelated to the incident, defer the action. An emergency PDB modification requires incident commander approval, a documented business justification, and a rollback time; it must not be used to evade normal capacity planning.

### ExternalSecret fails to synchronize

Verify the External Secrets Operator controller, `ClusterSecretStore` condition, provider identity, remote secret path, and policy permissions. Do not inspect or print secret values. Check the ExternalSecret status and controller logs with values redacted. A failed synchronization blocks rollout of Pods that require new keys. Existing Pods may continue using their projected environment until restart, so treat key rotation and restart as separate controlled steps.

## Communication and escalation

For a Critical node or availability incident, the incident commander posts an initial status within 15 minutes: impact, affected user paths, mitigation in progress, current availability, and next update time. Update every 30 minutes until recovery. Notify security if the incident involves credentials, unexpected RBAC/API activity, secret-store access denial, or suspected compromise. Notify data/platform owners if PostgreSQL, Kafka, Redis, OpenSearch, TigerBeetle, or Mojaloop contributes to delayed recovery.

## Recovery acceptance criteria

The incident can move to recovery only after the failed node is isolated or restored, all `switchos` Deployments meet their desired available replica count, HPA/PDB conditions are normal, no Pods are pending or restarting repeatedly, ExternalSecrets are Ready, database connection metrics are within budget, and a representative authenticated request succeeds through the ingress. Hold the incident open for at least 30 minutes of stable observation after these criteria are met.

## Post-incident review

Within two business days, capture the detection timeline, alert delivery, node condition, affected Pods, PDB/HPA behavior, scheduler events, dependency symptoms, actions taken, user impact, and missed automation opportunities. Include an owner and due date for every corrective action. Run a controlled staging node-failure exercise at least quarterly and after material changes to PDB/HPA, topology rules, secret management, or cluster networking.
