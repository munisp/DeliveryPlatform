# Circuit-Breaker Half-Open and Signed-Recovery Upgrade

**Date:** 2026-09-04  
**Scope:** Protected-staging resilience testing only. No integration cluster was contacted by this implementation or its tests.

## Implemented State Machine

The breaker now has three explicit durable states: `closed`, `open`, and `half_open`. The automated receiver remains **open-only**. A critical allowlisted invariant alert opens a `closed` breaker or re-opens a `half_open` breaker. It exposes no route for `half_open` or `closed` transitions.

| Transition | Actor | Preconditions | Result |
|---|---|---|---|
| `closed → open` | Receiver or dedicated operator | Critical allowlisted alert, or explicit approved incident reason; matching resource version/state | Stops new validation work and records incident metadata. |
| `half_open → open` | Receiver | New critical allowlisted alert; matching resource version/state | Reopens immediately; no automated recovery is permitted. |
| `open → half_open` | Dedicated operator only | Exact non-production context, matching incident, confirmation, signed `half_open` approval, valid recovery evidence, matching resource version/state | Allows exactly one separately approved bounded validation. |
| `half_open → closed` | Dedicated operator only | Exact non-production context, matching incident, confirmation, signed `close` approval, valid recovery evidence, matching resource version/state | Records immutable approval metadata and ends the active incident state. |

The transition policy uses a Kubernetes `ValidatingAdmissionPolicy` to deny changes to `half_open` or `closed` unless `request.userInfo.username` is `system:serviceaccount:resilience-test:resilience-circuit-breaker-operator`. The Alertmanager receiver ServiceAccount remains separately restricted to the one ConfigMap and cannot close or half-open it.

## Optimistic-Concurrency Controls

The Go receiver and the Bash operator use JSON Patch operations. Every mutable transition tests both:

```json
{"op":"test","path":"/metadata/resourceVersion","value":"<observed-version>"}
{"op":"test","path":"/data/state","value":"<expected-state>"}
```

Half-open and close also test the current `incident_id`. A `409` or failed test is a hard refusal; the operator must re-read the ConfigMap, review the new state/evidence, and make a new decision. There is no automatic retry over a conflicting state.

Non-state audit fields use JSON Patch `add`, which is safe for both new and pre-existing ConfigMaps: adding an object member replaces it when present and creates it when absent. This allows the deployed ConfigMap to gain approval audit fields without an unsafe reset to `closed`.

## Signed Recovery Approval Contract

`verify-signed-recovery-approval.py` accepts an HTTPS approval artifact by default. It requires both the trusted public key file and the exact trusted key identifier, so the envelope `key_id` cannot merely be an unauthenticated audit claim. It allows `file://` only when **both** `TARGET_ENV=test` and `LOCAL_RESILIENCE_TEST=true`, for deterministic local tests.

The approval envelope is JSON with these fields:

```json
{
  "key_id": "staging-recovery-ed25519-1",
  "signature_algorithm": "ed25519",
  "payload_b64": "<base64 canonical JSON payload>",
  "signature_b64": "<base64 64-byte Ed25519 signature>"
}
```

The signed payload itself must be canonical JSON (sorted keys, compact separators) and bind all security-relevant values:

```json
{
  "action": "half_open or close",
  "approval_id": "APPROVAL-...",
  "breaker_name": "resilience-validation-circuit-breaker",
  "environment": "staging",
  "expires_at": "RFC3339 UTC",
  "incident_id": "INCIDENT-...",
  "issued_at": "RFC3339 UTC",
  "namespace": "resilience-test",
  "purpose": "resilience-circuit-breaker-recovery",
  "recovery_evidence_id": "RECOVERY-..."
}
```

The verifier rejects a non-HTTPS source, missing CA bundle, untrusted Ed25519 signature, invalid envelope, noncanonical payload, wrong action, wrong incident/evidence/environment/namespace/breaker, an expiry in the past, future-dated issuance beyond five minutes, or validity windows longer than 24 hours. It records only the approval ID, key ID, payload SHA-256, and verification time in the breaker ConfigMap; it never stores the signed payload or signature.

## Required Operator Identity

Outside local tests, `manage-staging-resilience-circuit-breaker.sh` requires `RESILIENCE_OPERATOR_KUBECONFIG`. The kubeconfig must authenticate as the dedicated `resilience-circuit-breaker-operator` ServiceAccount, whose Role is limited to `get`/`patch` of the named ConfigMap and `get`/`delete` of the fixed TestRun and PodChaos resources.

The command refuses to use the ambient kubeconfig outside `TARGET_ENV=test` with `LOCAL_RESILIENCE_TEST=true`. Create a short-lived ServiceAccount token using the organization-approved credential process and construct an ephemeral kubeconfig outside source control. Do not place that kubeconfig, the Ed25519 private key, recovery token, or CA private material in Git.

## Operator Invocations

After evidence collection, an approved half-open transition requires:

```bash
export RESILIENCE_OPERATOR_KUBECONFIG=/secure/runtime/resilience-operator.kubeconfig
export RESILIENCE_TEST_CONTEXT=approved-staging-context
export TARGET_ENV=staging
export INCIDENT_ID=INCIDENT-20260904-001
export HALF_OPEN_EVIDENCE_ID=RECOVERY-20260904-001
export HALF_OPEN_APPROVAL_URL=https://approval.staging.internal/v1/recovery/APPROVAL-HALF-OPEN-001
export RECOVERY_APPROVAL_PUBLIC_KEY_FILE=/secure/runtime/staging-recovery-ed25519.pub
export RECOVERY_APPROVAL_KEY_ID=staging-recovery-ed25519-1
export RECOVERY_APPROVAL_CA_FILE=/secure/runtime/approval-ca.pem
export CONFIRM_CIRCUIT_BREAKER_ACTION="half-open:${INCIDENT_ID}"

scripts/testing/resilience/manage-staging-resilience-circuit-breaker.sh half-open
```

A close is separate and requires a **new approval whose action is `close`**:

```bash
export RECOVERY_EVIDENCE_ID=RECOVERY-20260904-002
export CLOSE_APPROVAL_URL=https://approval.staging.internal/v1/recovery/APPROVAL-CLOSE-001
export CONFIRM_CIRCUIT_BREAKER_ACTION="close:${INCIDENT_ID}"

scripts/testing/resilience/manage-staging-resilience-circuit-breaker.sh close
```

## Staging Prerequisites

The guarded staging provisioner now checks for `ValidatingAdmissionPolicy` and `ValidatingAdmissionPolicyBinding` API support before applying the resilience package. The new policy and dedicated operator RBAC are rendered into the non-mutating staging validation artifact and applied with the receiver/monitoring manifests.

A staging admission test must prove that the Alertmanager receiver can open the breaker, but cannot move it from `open` to `half_open` or `closed`; the dedicated operator identity can perform signed half-open/close operations; and an unrelated identity is denied. This remains an integration evidence gate because no staging cluster is currently reachable.

## Local Validation

| Test | Result |
|---|---|
| Go receiver tests with `-race` | Passed; includes resource-version test operation and critical half-open re-open coverage. |
| Signed approval verifier tests | Passed 4/4; valid approval, action mismatch, expiry, and signature tamper cases. |
| Operator workflow fixture | Passed 3/3; signed half-open/close, action mismatch refusal, and resource-version conflict refusal. |
| Staging render validator | Passed; the rendered artifact contains the admission policy and dedicated operator RBAC, with no unresolved placeholders. |

## Remaining Evidence Boundary

These files implement the controls and deterministic local checks. A protected-staging run must still validate Kubernetes admission enforcement, actual dedicated-identity authentication, HTTPS approval lookup with managed CA/key material, real Alertmanager re-open behavior, and CNI/network enforcement.
