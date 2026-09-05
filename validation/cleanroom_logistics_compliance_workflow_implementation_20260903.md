# Clean-Room Logistics and Lagos Compliance Workflow Implementation

**Prepared:** 2026-09-03  
**Scope:** Independently designed logistics route planning and an automated-but-human-gated driver/vehicle onboarding compliance workflow for a Lagos private beta. This implementation is original and is not API, schema, UX, or code compatible with Fleetbase.

> **Operational and legal boundary.** The workflow implements operational controls, not governmental, insurer, payment-provider, or legal approval. A driver is not commercially deployable until current written requirements are confirmed with the relevant Lagos/Nigerian authorities, insurers, providers, and qualified advisers.

## Delivered cross-language capabilities

| Component | Technology | Delivered function | Durable authority |
|---|---|---|---|
| Matching and dispatch eligibility | Go | H3/Redis/PostGIS candidate acceleration; matching remains gated by PostgreSQL eligibility. | `mobility.driver_eligibility`, `mobility.driver_presence` |
| Route planning | Rust | Authenticated, tenant-safe work-order planner; pickup-safe deterministic stop ordering and persisted distance explanation. | `operations.route_plan`, `operations.route_plan_stop` |
| Compliance verification | Python/FastAPI | Evidence intake, signed verifier call, mandatory human decision, expiry reconciliation, eligibility projection, and audit/outbox writes. | `mobility.compliance_evidence`, `mobility.driver_eligibility`, `mobility.compliance_decision_audit` |
| Operations and compliance control room | TypeScript | Fully wired `/logistics-operations` and `/compliance-review` views using protected central APIs—no fixture or browser-only state. | Central authenticated API plus Rust/Python services |
| Central integration layer | TypeScript/Express | Tenant ownership check before plan delegation; operator-role guard before compliance actions; internal token proxying with bounded calls. | Server-side service URLs and audit stores |

## Route-planning contract

The Rust dispatch optimizer exposes `POST /operations/route-plans`. The request accepts a canonical `work_order_id` and a nonzero creator identity. The service requires the internal token, loads only incomplete stops from `operations.work_order_stop`, rejects an unknown or non-routeable work order, and reads the stored tenant from PostgreSQL rather than trusting client tenant input.

The planner retains each pickup before all subsequent non-pickup stops, then applies a deterministic nearest-neighbour geodesic ordering to remaining stops. It persists the selected algorithm/version, source snapshot, total distance, leg distance, estimated arrival offset, and a monotonically increasing plan version. A unique `(work_order_id, plan_version)` constraint and retry loop make concurrent creation deterministic; older `planned` versions are marked `superseded` only after the new plan is stored.

| Invariant | Enforcement |
|---|---|
| Tenant cannot be supplied by a caller | Tenant is read from the durable work order record. |
| No cross-tenant route delegation | Central API calls `assertWorkOrderOwnership` before proxying. |
| Pickup must be first | Planner validates and pins the pickup stop ahead of the nearest-neighbour pass. |
| Reproducible explanation | Planning snapshot, algorithm version, per-leg distance, and visit sequence are committed. |
| Safe UUID and numeric binding | Canonical UUID validation plus text-to-UUID server casts and explicit `float8` casts prevent PostgreSQL driver serialization errors. |

## Lagos onboarding and vehicle inspection workflow

The compliance-review service is intentionally a **hybrid** decision process. Automated checks validate evidence format, expiry, trusted provider response, idempotency, and policy requirements. A designated reviewer must record a reasoned decision for requirements configured as requiring human approval. The browser never receives provider credentials or document bytes; it submits only a restricted object-store reference and provider reference through the central authenticated API.

| Stage | System action | Required human or external control | Result |
|---|---|---|---|
| 1. Evidence intake | Validates subject, evidence type, canonical reference, and immutable digest; writes a pending evidence record. | Operator uses a restricted-object-store document reference; records consent and source outside the browser. | `pending` evidence |
| 2. Provider verification | Sends evidence identifiers to the configured TLS verifier; validates signed HMAC response; records a numbered review attempt. | Provider must be contractually approved for the check. | `verified` or `rejected` evidence outcome |
| 3. Human gate | Applies a reviewer identity, boolean decision, reason, and timestamp. | Required for screening, licensing, training, vehicle inspection, commercial insurance, and operator controls configured by policy. | Approved evidence or reasoned rejection |
| 4. Eligibility projection | Counts required verified-and-unexpired driver, vehicle, and operator evidence; writes driver eligibility atomically. | No manual dispatch override. | `eligible` only if every required active control is satisfied |
| 5. Dispatch state | Returns only `pending_compliance` or `compliance_suspended` drivers to `offline` after full approval. | Separate safety/fraud `suspended` states are never automatically reactivated. | Matching may only use independently verified eligibility |
| 6. Continuous expiry | Background loop and protected reconciliation expire evidence and recompute every affected driver. | Reviewer resolves evidence and policy issues before a new activation. | `compliance_suspended` and ineligible on lapse |
| 7. Reactivation | Requires fresh/verified required evidence, mandated approval, and a refreshed projection. | Safety/fraud controls retain ownership of their own suspension state. | `offline`, eligible, and only then eligible for a new availability event |

The durable policy table contains the mandated control categories: driver identity/licence, LASDRI certificate where confirmed applicable, background screening, training, vehicle registration, roadworthiness, inspection, commercial passenger insurance, passenger liability cover, and operator permission. This configuration is versioned, city-scoped (`LAG`), expiry-aware, and auditable.

## Safety-critical suspension distinction

Migration `0032_compliance_presence_state.sql` adds `compliance_suspended` to the driver-presence enum. This corrects the discovered ambiguity in which a valid compliance projection could otherwise leave a driver in generic `suspended`, or an automated compliance reactivation could risk overriding a separate safety/fraud hold. The compliance service may reactivate **only** `pending_compliance` and `compliance_suspended`; generic `suspended` remains fail-closed until its owning safety or fraud control resolves it.

## Kubernetes and deployment controls

| Control | Implementation |
|---|---|
| Python compliance service | Registered in the generated workload inventory, with Deployment, Service, HPA, PDB, restricted NetworkPolicy, and no-permission `python-services` service account. |
| Runtime configuration | Non-secret expiry and policy configuration is in the Python ConfigMap. Verifier name, HTTPS endpoint, and HMAC material are declared only in the external-secret template. |
| Central service discovery | `COMPLIANCE_REVIEW_SERVICE_URL` resolves to `compliance-review.switchos.svc.cluster.local:8125`. |
| Privileged access | Central routes use existing authenticated reviewer controls; downstream endpoints use the internal service token and fail closed when absent. |
| Observability | Expiry worker failures are structured log events. Decision/audit/outbox records provide a durable forensic chain. |

## Integration and release evidence

| Check | Result | Evidence |
|---|---|---|
| TypeScript compile | Passed | `pnpm check` |
| TypeScript build | Passed | `pnpm build` |
| TypeScript tests | 41 files passed; 209 tests passed; 30 explicit skips | `pnpm test` |
| Go matching worker | Race target passed | `go test -race ./...` |
| Rust optimizer | 2/2 tests passed | `cargo test` |
| Python service | Syntax compilation passed | `py_compile` |
| Compliance end-to-end | Passed: 11 evidence records, eligible before expiry, ineligible after expiry, `compliance_suspended` projection | `validation/lagos_compliance_workflow_integration_20260903/summary.json` |
| Route-planning end-to-end | Passed: one persisted plan, 3 persisted stops, pickup first, 3,592.94 m explained total distance | `validation/logistics_route_plan_integration_20260903/summary.json` |
| Full migration chain | Passed against a fresh PostgreSQL/PostGIS database; 112 public/mobility/operations tables | `validation/cleanroom_logistics_compliance_schema_final.json` |
| Kubernetes structure | Passed: 25 files, 17 Deployments, 17 HPAs, 17 PDBs | `validate-kubernetes-manifests.py` |
| Kubernetes security | Passed: 17 runtime identities, 7 NetworkPolicies, 4 ExternalSecrets, namespace-scoped CI RBAC | `validate-kubernetes-security.py` |
| Static gates and diff integrity | Passed: zero insecure random APIs, TODO/FIXME, frontend console logs, unstructured Rust/Python stdout, mock/stub markers, and empty-handler indicators | `audit-production-readiness.sh`; `git diff --check` |

## Required private-beta operating evidence

Prior to commercial passenger activation, retain the current regulator/authority confirmation, insurer/broker coverage confirmation, approved verifier contract and its response-signature specification, policy version, reviewer delegation list, driver terms and privacy notice acknowledgment, payment-recipient evidence, current driver and vehicle roster, and a completed suspension/reactivation drill. The code is deliberately designed to reject missing verifier credentials and to keep an ineligible driver outside matching; it cannot establish compliance where external approvals are absent.

## References

[1]: https://www.new.lasdri.org/ "Lagos State Drivers’ Institute: certification and re-certification information"
[2]: https://lagosstate.gov.ng/news/License,%20Permits%20&%20Applications/view/6724e4558bec126a8aa4abaf "Lagos State Government: LASDRI CBT recertification notice, 14 August 2024"
[3]: https://naicom.gov.ng/ "National Insurance Commission: insurance regulatory framework and coverage verification"
[4]: https://ndpc.gov.ng/wp-content/uploads/2025/07/NDP-ACT-GAID-2025-MARCH-20TH.pdf "Nigeria Data Protection Commission: General Application and Implementation Directive"
