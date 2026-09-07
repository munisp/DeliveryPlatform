# Circuit-Breaker Operator and Failure-Evidence Audit

**Date:** 2026-09-04  
**Scope:** `scripts/testing/resilience/manage-staging-resilience-circuit-breaker.sh` and `validation/integration_cluster_blockers_and_circuit_breaker_recovery_20260904.md`.

## Overall Assessment

The operator command is **fail closed for the basic open/close action**. It validates a syntactically bounded incident identifier, restricts actions to `open` and `close`, requires exact context equality plus a non-production namespace label, uses an explicit reason allowlist for opening, and requires a separate explicit confirmation string for both mutations.

The failure record accurately states that deployment and CNI testing were not executed. It preserves the required evidence order—capture state first, then open the breaker and clear known faults—and it does not present unavailable integration/CNI evidence as passing.

## Enforced Script Controls

| Control                   | Script implementation                                                                               | Audit result                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Shell error handling      | `set -euo pipefail`                                                                                 | Present.                                                     |
| Action allowlist          | Only `open` or `close` is accepted; other values exit with usage error.                             | Present.                                                     |
| Incident identifier       | `INCIDENT_ID` must be 3–81 characters and match `[A-Za-z0-9][A-Za-z0-9._-]{2,80}`.                  | Present; prevents shell/JSON quote injection through the ID. |
| Exact target context      | Current context must equal `RESILIENCE_TEST_CONTEXT`.                                               | Present.                                                     |
| Environment allowlist     | `TARGET_ENV` accepts only `test`, `staging`, or `preproduction`.                                    | Present.                                                     |
| Namespace marker          | Namespace must contain `resilience.delivery-platform.io/environment=non-production`.                | Present.                                                     |
| Open confirmation         | `CONFIRM_CIRCUIT_BREAKER_ACTION` must exactly equal `open:<incident-id>`.                           | Present.                                                     |
| Opening reason            | One of seven named safety/incident reasons is required.                                             | Present.                                                     |
| Scope of breaker mutation | Patches only `resilience-test/resilience-validation-circuit-breaker`.                               | Present.                                                     |
| Close confirmation        | Requires `close:<incident-id>`, current breaker state `open`, and a bounded `RECOVERY_EVIDENCE_ID`. | Present.                                                     |
| Webhook closure           | No webhook close command exists in this script.                                                     | Present; automated intake stays open-only.                   |

## Evidence Preservation Review

The generated failure record correctly requires the following before state mutation: the breaker ConfigMap, active TestRun/PodChaos/Job/Pod state, namespace events, receiver logs, and monitoring custom resources. It also prohibits deletion of invariant Job, receiver, Alertmanager, and CNI evidence before preservation.

The report correctly describes the current two-state deployment (`open` and `closed`). It does not claim an implemented operator half-open transition. It also correctly lists manual evidence required before close: active receiver metrics, no patch-failure escalation, passed invariant probe, drained signed webhook queue, clean financial/assignment checks, cleared faults, redacted bridge delivery, no bridge Kubernetes mutation authority, and archived CNI evidence where in scope.

## Manual Conditions Not Cryptographically or Programmatically Enforced

The operator script validates only the **format** of `RECOVERY_EVIDENCE_ID`; it does not query a ticket system, artifact archive, Prometheus, Alertmanager, PostgreSQL, or the invariant Job before closing. The recovery evidence listed in the report is therefore a change-control and operator responsibility, not a script-enforced proof.

Similarly, `TARGET_ENV` is an allowlisted user input. Protection against a mislabelled production namespace depends on the RBAC binding, kubeconfig separation, and namespace label governance in the target cluster. The script’s exact-context and namespace-label checks are important layers, but are not a substitute for dedicated non-production credentials and admission policy.

## Follow-Up Hardening Items

| Priority | Item                                                                                                                          | Reason                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------ |
| High     | Treat a failed Toxiproxy clear or PodChaos deletion as an explicit `cleanup-failure` record rather than suppressing it with ` |                                                                                                                    | true`. | The breaker remains open, but a failed cleanup should be visible and auditable rather than only best effort. |
| High     | Add a read-only post-open verification that confirms the ConfigMap state and records TestRun/PodChaos deletion status.        | Prevents a success message from being interpreted as proof of cleanup.                                             |
| Medium   | Use a resource-version-aware JSON Patch `test` operation or a serialized operator lock for breaker state transitions.         | Reduces concurrent operator/automation race risk.                                                                  |
| Medium   | Add a separate, operator-only half-open workflow if that is a required release-control state.                                 | The deployed script is intentionally two-state; the Python model’s half-open behavior is not yet operational code. |
| Medium   | Integrate recovery-evidence lookup or a signed approval reference into the close path.                                        | A syntactically valid evidence ID alone does not verify recovery conditions.                                       |

## Conclusion

The current script and failure record are internally consistent and correctly fail closed when no integration cluster exists. The essential context, confirmation, reason, and close-state checks are present. The listed follow-up items should be addressed before treating the manual recovery path as independently enforced rather than operator-governed.
