# Gateway Monitoring, Resilience-Template Dry Run, and Independent Capability Status

**Assessment date:** 3 September 2026  
**Scope:** Monitoring and alert design for the payment-gateway resilience validation; a deliberately non-network dry run of new k6/Toxiproxy templates; and an evidence-based independent capability status.  
**Decision boundary:** This report does not certify a production deployment, actual multi-pod resilience, payment-provider integration, regulatory approval, or literal compatibility with any external platform.

## 1. Recommended dashboard set and alert thresholds

Four dashboards are required during gateway-resilience validation. They should be provisioned in the isolated test/staging observability stack and annotated with release ID, resilience run ID, scenario ID, fault start/end, image digest, and configuration revision. No metric label may contain a raw payment reference, callback body, secret, precise location, driver ID, trip ID, or other unbounded/sensitive identifier.

| Dashboard | Questions it answers | Required panels | Initial alert threshold |
|---|---|---|---|
| **A. Ingress SLO and capacity** | Can valid matching and webhook-acceptance traffic enter within the approved SLO, without hidden 5xx/overload? | Match/webhook p50/p90/p95/p99; status-class ratios; timeouts; 429 separate from success; request rate; per-pod in-flight work; CPU/memory/HPA; slow-request trace exemplars. | Match or webhook-acceptance p95 >160 ms for 10 min: warning. p95 >200 ms for 5 min: P1 validation page. 5xx/timeout ≥0.1% for 5 min: warning; ≥0.5% for 5 min: P1. |
| **B. Payment verification queue and provider path** | Are accepted callbacks verified, retried, quarantined, and reconciled safely? | Accepted/claimed/verified/retry/quarantine/exhausted rate; oldest pending/active-claim age; provider verification latency; upstream error class; worker health; reconciliation result. | Oldest pending age >2 min: warning; >5 min after healthy provider/service probe: P1. Active claim >2 min: P1. Provider p95 >3 s: warning; >5 s for 5 min: P1. Retryable upstream failures ≥5% for 5 min: P1. |
| **C. PostgreSQL, Redis, and durable invariants** | Is persistence/cache saturation causing tail latency, and do correctness controls remain intact? | PostgreSQL pool usage/wait, transaction/rollback/deadlock/lock waits, query latency; Redis GEO/command/pool latency/error; fallback ratio; candidate distribution; cache projection/reconciliation; offer/assignment invariants. | Pool-acquire p95 >50 ms: warning; >100 ms for 5 min: P1. Redis error/fallback >1% for 10 min: warning; >5% for 5 min: P1. Any unexplained deadlock/constraint error: P1. |
| **D. Chaos control plane and recovery** | Did the intended fault occur within scope, and did all systems recover correctly? | Experiment approval/ID/TTL/target count; precondition baseline; injected-fault marker; blast radius; cleanup; recovery; invariant-probe result; evidence-bundle completion. | Target outside allowlist, TTL breach, or cleanup failure: P1; P0 if a prohibited/sensitive scope is reached. Missing post-fault invariant evidence: failed experiment, not a pass. |

The following hard-stop alerts must never be muted automatically, including during a resilience test:

| Hard-stop alert | Trigger | Severity | Required first action |
|---|---|---|---|
| `FinancialInvariantViolation` | Any unverified monetary transition, duplicate provider-event financial effect, or failed ledger-balance check. | P0 | Pause the affected money workflow; preserve restricted evidence; finance/compliance/security/SRE assess reconciliation scope. |
| `DuplicateAssignmentInvariantViolation` | Any duplicate active driver assignment, duplicate pending offer, or missing durable result for an accepted request. | P0 | Stop automated offers in the affected scope; reconcile PostgreSQL records; preserve traces and configuration. |
| `PaymentQuarantineFinancialMismatch` | Amount/currency mismatch, unknown verified financial reference, or invalid verified state transition. | P1 by default | Freeze affected payment scope; finance/compliance investigate without manually changing money state absent provider verification. |
| `WebhookRetryExhausted` | Retry budget exhausted for a financially relevant verified callback. | P1 | Reconcile against provider; assign finance/SRE owner; resolve only with approved verified evidence. |

### Instrumentation status

The dashboard and alerts are a **required next implementation step**, not a claim that all alerts are live today. A source-tree review found health and protected queue-status surfaces but no Prometheus `/metrics` endpoint or matching/payment histogram/counter implementation. The monitoring contract must therefore be added and tested before Prometheus alert rules or Grafana panels can become release evidence. The complete metric contract, panels, proposed alert values, and testing rules are in [`gateway_resilience_monitoring_and_alert_thresholds_20260903.md`](gateway_resilience_monitoring_and_alert_thresholds_20260903.md).

## 2. Guarded k6 and Toxiproxy dry-run report

The dry run intentionally did **not** create Kubernetes resources, issue HTTP requests, send callbacks, connect to a provider, or inject a network fault. It verified that the templates parse and refuse production-like targets before reaching Kubernetes or network logic.

| Check | Result | Evidence / interpretation |
|---|---|---|
| `ride_payment_ingress.js` parse | Pass | JavaScript syntax check completed successfully. |
| k6 runner shell syntax | Pass | `bash -n` completed successfully. |
| Toxiproxy control shell syntax | Pass | `bash -n` completed successfully. |
| k6 production-target guard | Pass | Explicitly supplied production-like matching/payment hostnames were refused with exit code `1` before Kubernetes actions. |
| Toxiproxy production-upstream guard | Pass | Explicitly supplied production-like simulator upstream was refused with exit code `1` before Kubernetes or proxy actions. |
| Network/provider calls | **0** | This was a guardrail simulation only. |
| k6 binary in this sandbox | Not installed | No load traffic was produced; no k6 threshold result exists. |
| Kubernetes TestRun/Chaos/Toxiproxy deployment | Not executed | The required non-production cluster, CRD, namespace label, external test secret, and approval context were not supplied or created by this dry run. |

The machine-readable dry-run summary is [`resilience_template_dry_run_20260903/summary.txt`](resilience_template_dry_run_20260903/summary.txt). The script and manifest hashes captured at dry run were:

| Template | SHA-256 |
|---|---|
| `ride_payment_ingress.js` | `b017b022d09e5cc007dfe3450804388b8a392244cef34d8901e282c99e7bf15a` |
| `ride-payment-ingress-testrun.yaml` | `e9fd9008d0932367fbb705619e605bf0f6cb9d3c40a3ce1297a844b2d08f725a` |
| `run-k6-ride-payment-ingress.sh` | `13144ac7cc51b464a879725133b241158eb2ee6aaeb230dc24c1a05e50619412` |
| `toxiproxy.yaml` | `14a6aa614a7f3927e60bed751e2bf73ce5d9c888a691f3d929ba9dff754b405a` |
| `toxiproxy-payment-faults.sh` | `a3853541520d390f71a25c483be224555bef5aca55e33612a91bff2c2c1c1b54` |

### What is required for an actual run

An actual test requires a deliberately provisioned environment—not merely changing an environment variable. Required preconditions are a named non-production Kubernetes context, a `resilience-test` namespace labelled `resilience.delivery-platform.io/environment=non-production`, k6 Operator CRDs, a test-only secret containing the internal service token and webhook signing secret, seeded synthetic trip/payment references, test-only gateway simulator routing for Toxiproxy, immutable test images, and a post-run PostgreSQL/queue invariant probe. The scripts require explicit confirmation and compare the active context to an operator-provided exact non-production context name.

## 3. Independent clean-room capability status

The appropriate question is not whether “Fleetbase-inspired” features are 100% complete, because that would imply a third-party parity claim that this project has explicitly not established and must not claim. The named external project is licensed under AGPL-3.0; this effort uses independently defined logistics/mobility capability categories and must not represent source, endpoint, schema, interface, brand, or behavioural compatibility.[1]

The last defensible platform-level status remains **82/100 as a protected-staging candidate**, not public-production readiness. This is an evidence-based readiness score across implemented components and validation artifacts. It is not a feature-parity score and it is not increased by creating new test templates that have not yet run in a production-like environment.[2]

| Independent capability category | Current evidence-backed status | Material remaining acceptance gap |
|---|---|---|
| Tenant operations and workflow | Substantially implemented: durable zones/jobs/stops/state history, versioned workflow transitions, tenant-scoped APIs and operator surfaces. | Operator-configurable policy simulation/approval/rollback, contradictory-rule detection, and broad workflow acceptance tests. |
| Dispatch and telematics | Implemented durable PostgreSQL/PostGIS authority, Redis GEO acceleration, H3 projection, conditional reservations, device/attestation/consent controls, and latency improvement evidence. | Production-like multi-pod load/chaos/recovery, real mobile attestation/spoof testing, and SLO-based concurrency/backpressure acceptance. |
| Route planning and ETA | Protected Rust route-plan persistence, pickup-safe ordering, deterministic heuristic, and integration evidence. | Selected routing/traffic adapter, map/licensing control, multi-zone capacity/skills/time windows, ETA/distance calibration, and operational acceptance. |
| Pricing and commission | Integer-safe pricing/commission persistence and related integration evidence. | Commercial policy approval, scaled financial reconciliation, selected payment-provider integration, and funds-flow controls. |
| Payments, payout, and financial operations | Durable provider event queue, HMAC receipt, provider verification before money, ledger/payout flows, outage retry/quarantine tests, invoices/disputes/governed reports. | Real provider sandbox certification, refund/chargeback/payout reconciliation, finance close/support workflow, compliance/legal approval, and production queue SLO evidence. |
| Partner/developer integration | API key scopes, signed inbound events, replay protection, credential digests, revocation, integration storage. | Versioned public API lifecycle, developer portal/SDK policy, connector governance, DLQ/replay, partner certification, and support ownership. |
| Maps, geofences, and tracking | Spatial zones/geofences/tracking structures and central operator capability exist. | Versioned authoring/publication, entry/exit auditing, playback/retention, accuracy-aware enforcement, mobile/offline tests, and shadow/field acceptance. |
| Compliance and safety | Signed verifier contract, human approval, expiry/suspension, attestation/consent boundaries, and Lagos-focused workflow evidence. | Current jurisdictional approval, external verifier contract certification, independent fraud/safety red-team testing, insurance and operational readiness. |
| Analytics and reporting | Operational/financial data structures and report requests exist. | Metric definitions, lineage/freshness, tenant-safe scheduled export/delivery, immutable finance reports, retention, and customer-facing analytics acceptance. |
| Enterprise tenant controls | Tenant-oriented routes, invitations/branding evidence, durable domains. | Query/cache isolation proof, SSO/SCIM, ABAC/RBAC review, delegated administration, audit export, region/retention, enterprise support. |
| Kubernetes, security, and operations | Manifests/security/CI validation passed; 17 deployment/HPA/PDB resources, RBAC/NetworkPolicy/ExternalSecret contracts exist. | Actual target-cluster CNI policy enforcement, immutable signed images, secret store/OIDC workload identity, observability, real rollout/rollback, backup/PITR restore drill, on-call/recovery exercises. |

The prior source and disposable-dependency validation is substantial: TypeScript check/tests/build, Go race tests, Rust tests, Python compilation, PostgreSQL/PostGIS/Redis integrations, Kubernetes/security/CI validators, static gates, and diff integrity passed. The final disposable ride/payment workload also measured p95 **72.840 ms** for 5,000 Go matches at 24 concurrent clients and **134.364 ms** for 500 signed Python callback acceptances at 64 concurrent clients, with all reported requests successful and no observed deadlock/rollback. These results confirm the narrow local behavior, not multi-pod production capacity or real gateway behavior.[3]

## 4. Practical completion conclusion

The correct completion statement is:

> **The independently designed logistics/mobility platform is materially implemented and validated as a protected-staging candidate (last defensible platform-level readiness: 82/100). It is not verified as 100/100 complete, not certified for unconditional public production, and not demonstrably compatible with any external platform.**

To move the score or release designation, the team must execute—not merely template—the multi-pod k6/chaos scenarios, provider sandbox certification, live metrics/alerts, routing/geofence acceptance scorecards, target-cluster identity/CNI/secret controls, backup restore drills, security review, and current local regulatory/insurance/privacy/payment approvals. Each change needs independent product-owner acceptance and evidence retention as specified in the steering documents.

## References

[1]: https://github.com/fleetbase/fleetbase/blob/master/LICENSE "Fleetbase repository license"

[2]: cleanroom_logistics_capability_completion_20260903.md "Independent logistics capability completion assessment"

[3]: ride_matching_payment_latency_and_cleanroom_acceptance_20260903.md "Ride-matching and payment-webhook latency evidence"

[4]: gateway_resilience_monitoring_and_alert_thresholds_20260903.md "Monitoring dashboard and alert-threshold specification"

[5]: resilience_template_dry_run_20260903/summary.txt "Guarded resilience template dry-run summary"
