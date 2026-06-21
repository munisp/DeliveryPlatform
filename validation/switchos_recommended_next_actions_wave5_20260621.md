# SwitchOS Recommended Next Actions — Wave 5 Staged-Proof Report

**Author:** Manus AI  
**Date:** 2026-06-21

## Executive Summary

This remediation wave moved the platform from **static build-readiness** into the first **truthful live staged-proof path that was executable inside the current sandbox**. The highest-value runnable path was the new Mojaloop Temporal worker foundation, because it could be exercised against a real local Temporal development server and a real PostgreSQL instance without overstating the parts of the wider stage stack that were not actually available.

The result is that SwitchOS now has **verified live evidence** that the Mojaloop worker can connect to a real Temporal server, register the workflow, execute a workflow run, and persist workflow and orchestration status into PostgreSQL-backed tables. During that exercise, one important integrity gap was exposed and closed: the existing Temporal middleware probe was not a real Temporal probe at all, because it was attempting an HTTP fetch against the gRPC frontend address. That probe has now been replaced with an honest socket-level Temporal frontend connectivity check.

The platform is therefore in a materially stronger position than after Wave 4. However, the broader staged objective the user requested — traffic flowing through **APISIX, Keycloak, Permify, Redis, PostgreSQL, broker infrastructure, and the Mojaloop ledger path together** — is still only **partially closed**. The blocking issue is not code compilation anymore. The blocking issue is that the current sandbox does not have Docker available, and no external staged endpoints for APISIX, Keycloak, Permify, Fluvio, or equivalent broker services were configured during this run, so those subsystems could not be exercised honestly as live infrastructure.

## What Was Implemented in This Wave

| Area | Change | Why it mattered |
| --- | --- | --- |
| Mojaloop runtime | Added a real `MOJALOOP_SERVICE_MODE=worker` execution path in `services/go/mojaloop/main.go` | This converted the Temporal worker foundation from library-only code into an executable runtime path that can actually be started for staging and validation. |
| Live Temporal validation | Installed the official Temporal CLI and ran a real local development server | This enabled an actual Temporal runtime instead of stopping at compilation-only evidence. The CLI’s local development server is the documented non-Docker path for local Temporal execution.[1] |
| Database-backed staging | Installed and started a local PostgreSQL instance, created the `switchos` database and runtime user, and exercised the Mojaloop worker against it | This provided real persistence for orchestration state instead of in-memory-only validation. |
| Runtime integrity | Replaced the old HTTP-based Temporal probe with a real socket-based frontend probe in `server/_core/integrationProbes.ts` | This removed a false-positive health pattern and made live integration status more honest for real Temporal deployments. |
| Validation coverage | Updated `tests/integration-probes.test.ts` to match the new real Temporal probe semantics | This kept the automated suite aligned with the corrected runtime behavior. |

## Live Staged-Proof Evidence Captured

The strongest evidence obtained in this wave came from the **Temporal plus PostgreSQL plus Mojaloop worker** path, because that was the highest-value integrated execution chain that could be brought up truthfully in the current environment.

| Evidence item | Observed result | Interpretation |
| --- | --- | --- |
| Local Temporal development server | Started successfully with the official CLI on `127.0.0.1:7233` | A real Temporal runtime was available for worker execution, not just mocked tests. |
| Mojaloop worker mode | Started successfully with `MOJALOOP_SERVICE_MODE=worker` and connected to the local Temporal server | The new worker execution path is runnable in practice. |
| Workflow launch | `FundsWorkflowOrchestration` started with workflow ID `funds-proof-20260621-01` | The worker was able to receive a real workflow from Temporal. |
| Temporal workflow status | `COMPLETED` with a recorded history length of `29` and state transition count of `19` | The workflow did not merely register; it actually executed inside Temporal and wrote history. |
| PostgreSQL workflow persistence | `mojaloop_workflows` row recorded `status = completed` for `funds-proof-20260621-01` | Workflow state persistence is working against a real database. |
| PostgreSQL orchestration persistence | `mojaloop_workflow_orchestration` row recorded `status = completed` and task queue target `switchos-funds-workflows` | The orchestration status updates also persisted correctly. |

## Automated Validation Results

After the live runtime exercise and the Temporal probe fix, the targeted validation suites and build were re-run.

| Validation command | Result | Notes |
| --- | --- | --- |
| `npm test -- --run tests/integration-probes.test.ts tests/funds-integrity.test.ts tests/platform.scenarios.test.ts` | Passed | `18/18` tests passed. |
| `npm run build` | Passed | The Node production build now completes successfully after the Wave 4 module restoration and the Wave 5 Temporal probe correction. |
| Live Temporal workflow describe | Passed | The workflow completed on the real local Temporal runtime and returned `Status COMPLETED`. |
| PostgreSQL orchestration queries | Passed | Both workflow and orchestration tables contained the expected completed status rows. |

## Newly Exposed and Closed Gap

A meaningful issue surfaced only because the worker was exercised against a real Temporal server. The repository’s prior Temporal middleware check had been coded as an HTTP request against the `TEMPORAL_ADDRESS` gRPC frontend port. That can appear testable under mocks, but it does **not** represent a truthful health check for a real Temporal frontend.

This wave corrected that problem by switching the Temporal integration probe to a **socket-level connectivity check** against the configured Temporal address. That change makes the health surface materially more reliable for staged validation, because a healthy result now means the frontend is at least reachable as a real service endpoint rather than merely satisfying an artificial HTTP mock.

## Residual Blockers After Wave 5

The platform has now crossed an important threshold: **the next blockers are mostly infrastructure-availability blockers, not the same class of compile-time blockers that dominated earlier waves**. That said, the user’s requested full staged proof is still not completely satisfied.

| Remaining blocker | Current state | Why it still blocks full staged proof |
| --- | --- | --- |
| APISIX live routing path | Not exercised live | Docker is unavailable in the current sandbox, and no external staged APISIX endpoint was configured. |
| Keycloak OIDC path | Not exercised live | No external Keycloak stage endpoint was configured, and the local compose-based identity stack could not be started here. |
| Permify authorization path | Not exercised live | No running Permify service was available in the current environment. |
| Broker infrastructure / Fluvio path | Not exercised live | No broker service was configured or reachable for this run. |
| Full Redis-backed message path | Not exercised live | Redis integration remains probe-ready in code, but it was not part of the real end-to-end runtime chain exercised in this wave. |
| Cross-middleware edge-to-ledger route | Partially blocked by missing stage infra | The live proof reached the Mojaloop worker, Temporal, and PostgreSQL layers, but not the full gateway, identity, policy, and broker chain. |
| Broader platform-wide idempotency outside the current covered funds paths | Still pending | This remains the next major code-hardening target after live stage infrastructure access is established. |

## Readiness Impact

This wave improved the platform’s production posture in two different ways. First, it converted the new Temporal worker foundation into something that can actually be executed in a staged environment. Second, it replaced a misleading Temporal health check with one that corresponds to a real runtime property. Those are meaningful changes because they shift the repository from **“it compiles”** toward **“part of the real orchestration path has been exercised under live infrastructure conditions.”**

The platform should therefore be assessed as **stronger than Wave 4, but still short of full staged operational proof**. The biggest remaining gap is now externalized: the repository needs either a reachable staged middleware environment or a Docker-capable persistent host so that the APISIX, Keycloak, Permify, broker, Redis, and Mojaloop edge-to-ledger path can be exercised together and documented with the same level of evidence obtained here for Temporal and PostgreSQL.

## Recommended Next Actions

The next highest-value action is to perform a **full middleware-backed staged proof run** on infrastructure that can actually host the compose-defined services or reach an already provisioned stage environment. In practical terms, that means one of two honest paths. The lighter path is to point the repository’s live integration probe and workflow tooling at an already running stage stack for APISIX, Keycloak, Permify, Redis, OpenSearch, broker services, and Mojaloop endpoints. The heavier but more self-contained path is to move this validation onto a Docker-capable persistent host so the compose-defined middleware can be started and exercised there.

After that infrastructure-backed proof is in place, the next code-hardening priority should be the one already identified by the user: **extend durable idempotency coverage to the remaining non-Mojaloop write-heavy services that may be retried by operators, schedulers, or middleware.**

## References

[1]: https://docs.temporal.io/cli/setup-cli "Install and configure the CLI | Temporal Platform Documentation"
