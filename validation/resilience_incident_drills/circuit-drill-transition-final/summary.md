# Simulated Circuit-Breaker Incident Drill

**Run ID:** Recorded in the containing resilience incident-drill artifact directory.  
**Execution type:** Local non-network simulation using checked-in fake `kubectl`/`curl` fixtures and an ephemeral Ed25519 key.  
**Simulated anomaly:** `assignment-anomaly`  
**Result:** PASS — this proves local control-flow guardrails only; it is not a staging chaos result or recovery approval.

| Drill step | Observed result |
|---|---|
| Open circuit | The guarded command recorded the fixed incident reason and transitioned the simulated ConfigMap from `closed` to `open` using a resource-version JSON Patch test. |
| Immediate stop | The simulated control plane recorded TestRun deletion and PodChaos deletion requests. |
| Gateway cleanup | The simulated proxy client recorded the Toxiproxy toxic-clear call. |
| Future-run prevention | A simulated approved baseline controller invocation was refused because the circuit state was `open`. |
| Signed half-open | A synthetic Ed25519 approval bound to the incident, evidence, namespace, breaker, and `half_open` action transitioned only the temporary state to `half_open`. |
| Signed closure | A distinct synthetic Ed25519 approval bound to the `close` action and separate evidence transitioned only the temporary state to `closed`. |
| Network isolation | Every Kubernetes and proxy command resolved to local fake executables. No cluster, DNS, HTTP endpoint, payment provider, or production system was contacted. |

> The synthetic approvals and recovery evidence in this drill have no operational authority. A real circuit transition requires a dedicated operator identity, reviewed staging evidence, an HTTPS approval service, and human approval under the rollback runbook.
