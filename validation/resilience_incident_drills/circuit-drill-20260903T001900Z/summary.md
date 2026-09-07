# Simulated Circuit-Breaker Incident Drill

**Run ID:** Recorded in the containing resilience incident-drill artifact directory.  
**Execution type:** Local non-network simulation using the checked-in fake `kubectl` and `curl` fixtures.  
**Simulated anomaly:** `assignment-anomaly`  
**Result:** PASS — this proves local control-flow guardrails only; it is not a staging chaos result or recovery approval.

| Drill step | Observed result |
|---|---|
| Open circuit | The guarded command recorded the fixed incident reason and transitioned the simulated ConfigMap from `closed` to `open`. |
| Immediate stop | The simulated control plane recorded TestRun deletion and PodChaos deletion requests. |
| Gateway cleanup | The simulated proxy client recorded the Toxiproxy toxic-clear call. |
| Future-run prevention | A simulated approved baseline controller invocation was refused because the circuit state was `open`. |
| Simulated closure | Closure required a separately supplied recovery evidence ID and transitioned only the temporary simulated state back to `closed`. |
| Network isolation | Every Kubernetes and proxy command resolved to local fake executables. No cluster, DNS, HTTP endpoint, payment provider, or production system was contacted. |

> The synthetic recovery evidence ID in this drill has no operational authority. A real circuit close requires reviewed staging evidence, reconciliation where relevant, and human approval under the rollback runbook.
