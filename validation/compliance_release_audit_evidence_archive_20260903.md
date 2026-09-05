# Compliance Release Audit-Evidence Archive Specification

**Purpose.** This specification identifies the minimum evidence to archive before a controlled production release of the dispatch, payment, routing, and geofence capabilities. It supports the steering committee’s ability to independently reconstruct what was tested, what changed, what data was used, what decisions were made, and whether mandatory financial, safety, privacy, and operational controls passed.

> This is an operational evidence framework, not a retention-period prescription or legal advice. Counsel, privacy, finance, insurance, provider, and jurisdictional requirements must set the final retention schedule, legal holds, data-residency requirements, and disclosure obligations for each launch jurisdiction.

## 1. Archive principles

| Principle | Required control |
|---|---|
| Reproducibility | Retain immutable source revision, image digest, dependency/lockfile/SBOM evidence, configuration digest, test scenario revision, data-set revision, execution command, and environment topology for every release-gate run. |
| Integrity | Store a signed or otherwise immutable manifest of artifact names, hashes, size, creator, UTC timestamp, and retention class. Any replacement produces a new version rather than changing evidence in place. |
| Minimum necessary data | Archive IDs, hashes, redacted excerpts, and aggregate metrics by default. Do not archive payment secrets, raw credentials, PAN/CVV, private keys, or unnecessary raw location history. |
| Traceability | Every recorded event links to a run ID, correlation/request ID, tenant-safe subject pseudonym, component version, policy version, and reviewer/approver identity. |
| Separation of duties | Engineers may submit evidence; designated SRE, product, finance, security, and compliance approvers review their relevant gates. No single individual may author, approve, and override a financial/safety release gate. |
| Confidentiality | Encrypt archives at rest and in transit; restrict read/export to named roles; log every archive access and export; redact attachments sent to general collaboration systems. |
| Recoverability | Test indexed search, permissioned retrieval, integrity verification, and restoration of a sample release dossier before declaring the archive control ready. |

## 2. Required release dossier index

Every release candidate must have one immutable dossier identifier, for example `release-YYYYMMDD-build-digest`, that references all evidence categories below.

| Evidence category | Minimum artifacts to archive | Required metadata | Primary reviewer |
|---|---|---|---|
| Release identity and provenance | Source commit/tag; change request; reviewed diff summary; build log; container image digest; SBOM; dependency lockfile hashes; vulnerability/policy scan; deployment manifest and rendered manifest hashes. | Release ID, UTC build/deploy time, repository revision, CI run ID, image digest, environment, approver. | SRE and security. |
| Environment and isolation | Cluster/context identifier; namespace; node/pod topology; PostgreSQL/PostGIS and Redis version/configuration summaries; ingress/service version; resource quotas; NetworkPolicies; service account/RBAC policy snapshot; secret-reference names only. | Run ID, environment classification, data classification, configuration digest, test namespace label. | SRE and security. |
| Performance and ingress load | k6 source hash; TestRun manifest; ConfigMap/config hash; rate/duration/VU settings; raw k6 summary and threshold outcome; request/response status histogram; percentile/throughput summary; generator resource use; post-run cleanup result. | Run ID, scenario ID, start/end UTC, target revision, topology, test data offset, thresholds. | SRE and product. |
| Durable matching invariants | PostgreSQL query output proving no duplicate active assignment/offer, no missing accepted result, and expected trip/event state counts; Redis fallback/availability counters; sampled correlation traces. | Query revision/hash, database schema revision, anonymized fixture range, observer identity. | SRE and product operations. |
| Chaos experiment | Approved hypothesis; experiment YAML and hash; target selectors; precondition probe; baseline; injection start/end; controller/event logs; dashboards/traces; postcondition and cleanup probes; observed blast radius; rollback/kill-switch record. | Experiment ID, change approval, owner, automated TTL, target namespace, fault type, result. | SRE, security, and compliance for safety/financial scope. |
| Payment callback authenticity | Callback-event pseudonymous ID; raw-body digest; signature-presence/verification verdict; signature algorithm/key identifier (never secret); received timestamp; source IP/network metadata where policy permits; acceptance/rejection reason. | Event/correlation ID, provider name, environment, key reference ID, retention class. | Finance control and security. |
| Provider verification and money state | Provider reference token/hash; verified provider status/amount/currency fields; verification request/response digests or encrypted redacted payload; internal payment/payout state transition; ledger transaction IDs; balanced-ledger assertion; idempotency result. | Provider sandbox/live classification, verification timestamp, internal transaction IDs, policy/schema version. | Finance control and compliance. |
| Reconciliation and exceptions | Daily/provider-test reconciliation report; unmatched item register; refund/dispute/chargeback test output; manual resolution evidence; terminal quarantine/retry-exhaustion events and resolution owner. | Reporting period, source version, exception severity, owner, due date, closure evidence. | Finance control and compliance. |
| Queue and recovery | Queue accepted/claimed/processed/quarantined/retry-exhausted counters; oldest-age history; worker failure/restart/claim-recovery trace; queue-drain query output; alert firing and acknowledgement. | Run/scenario ID, timestamps, worker revision, recovery objective, alert incident ID. | SRE and finance control. |
| Routing quality | Versioned route-policy constraints; routing/map-provider version; dataset card; hold-out metric calculation code/hash; feasibility/legality/ETA/distance segment results; operator blind-review sample; degradation-mode result. | City/service-zone, vehicle class, time band, policy/model/provider version, data-consent classification. | Product and compliance/safety. |
| Geofence safety and privacy | Immutable geometry/policy version/checksum; source/approval; effective window; reference-point/boundary test result; field/shadow test result; accuracy/hysteresis behavior; authorization test; override/rollback drill. | Policy ID/version, scope, approver, data minimization class, test trace IDs. | Product, safety, and compliance. |
| Privacy and data governance | Data inventory; dataset cards; consent/revocation result; access-control test; retention/deletion test; data-subject workflow test where applicable; vendor/subprocessor record; legal-hold status. | Data category, jurisdiction, retention policy ID, DPO/compliance reviewer. | Compliance and security. |
| Security and access controls | Secret-rotation evidence; workload identity test; SAST/dependency/container/IaC scan summaries; RBAC/NetworkPolicy negative tests; archive-access logs; incident/security exceptions. | Scanner/version, policy revision, exception ID/expiry, security approver. | Security and compliance. |
| Operations and recoverability | Alert test receipt; on-call drill; runbooks; backup/PITR/restore report; RTO/RPO measurement; rollback rehearsal; incident timeline for failures; lessons learned and corrective actions. | Drill ID, start/end, RTO/RPO target, result, accountable owner. | SRE and product operations. |
| Governance decision | Completed hard-gate checklist; sign-off rubric; meeting minutes; release/no-release decision; any exception with scope, customer impact, compensating control, owner, expiry, and rollback authority. | Decision date, named approvers, quorum, release scope, exception expiry. | Steering committee chair. |

## 3. Payment and financial evidence: preserve proof without archiving secrets

Financial evidence is the highest-risk archive class. Retain the evidence needed to prove a verified and idempotent state transition while reducing exposure of credentials and sensitive payment data.

| Retain | Do not retain in general test evidence | Storage/control requirement |
|---|---|---|
| Provider event/reference token or keyed digest; internal event ID; timestamp; HMAC/signature verification verdict; signing-key *reference*; verified amount/currency/status; state-transition ID; ledger IDs and balance check. | Full webhook signing secrets, API keys, OAuth tokens, private keys, PAN, CVV, bank-account details, unredacted authorization headers, or raw personal data unrelated to the test. | Encrypt; restrict to finance/security/compliance roles; immutable access log; redacted derivative for product/SRE review. |
| Redacted provider verification response plus canonical response/body hash; request ID; TLS/certificate validation outcome where relevant; provider sandbox test ID. | Raw callback body unless a documented investigation/legal requirement requires it. | If raw body is retained, encrypt separately with strict access, lawful purpose, retention class, and access review. |
| Reconciliation report; unmatched-event register; quarantine/retry exhaustion record; manual resolution approvals. | Screenshots containing secrets or full customer financial identifiers. | Finance-controlled case record with audit history and expiry/closure. |
| Payout/refund/dispute lifecycle and internal ledger journal references. | Production customer credentials copied into staging artifacts. | Use synthetic/sandbox identifiers in all performance and resilience evidence. |

A callback `202 Accepted` record alone is insufficient financial evidence. The dossier must demonstrate the sequence: authenticated receipt; durable idempotent event; provider-side verification; legal internal state transition; balanced ledger; and reconciliation outcome. Any manual repair must include reason, two-person approval where required by finance policy, before/after identifiers, and post-repair balance/reconciliation evidence.

## 4. Resilience, chaos, and multi-pod artifact bundle

For every distributed load or chaos run, archive the bundle below as one named run. Do not archive only a dashboard screenshot; dashboards can be edited and are not enough to reconstruct conditions.

| Bundle item | Required contents | Why it matters |
|---|---|---|
| Test charter | Hypothesis, scenario ID, preconditions, expected outcome, hard fail conditions, owner, approval, maximum blast radius, start/end window, and kill switch. | Demonstrates that the test was intentional, bounded, and approved. |
| Exact test inputs | k6 source and SHA-256; test-run manifest; generator image digest; environment config digest; test data seed/version; proxy/chaos manifest and fault parameters. | Allows replay and identifies changed variables. |
| Topology snapshot | Replica count, pod/node placement, HPA state, ingress/service endpoints (redacted), database/Redis capacity summary, pool sizes, and relevant NetworkPolicy versions. | Explains whether performance/failure behavior was evaluated in a comparable environment. |
| Baseline and fault telemetry | Pre-fault baseline, latency/error/throughput histograms, CPU/memory/network, DB pool waits, locks/deadlocks, Redis latency/fallback, queue age, provider request outcomes, and fault event timestamps. | Distinguishes a genuine resilience result from unrelated saturation or a silent fault failure. |
| Invariant probes | SQL outputs/probe hashes for offers, assignments, idempotency, payment/ledger balance, queue state, and reconciliation. | Prevents a technically successful load test from masking a business-integrity failure. |
| Recovery evidence | Fault removal, cleanup check, pod/service recovery, queue drain, retry/quarantine result, alert acknowledgement, restoration result, and final invariant probes. | Establishes safe recovery rather than only controlled failure. |
| Review and action record | Pass/fail decision, issues, severity, root-cause hypothesis, remediation owner/date, required re-test, and link to closed corrective action. | Gives the steering committee an accountable closure trail. |

## 5. Routing and geofence evidence

Routing and geofencing influence safety, fairness, customer experience, and potentially financial/service eligibility decisions. Archive both the automated score and the policy context used to produce it.

| Capability | Minimum archived evidence | Non-negotiable condition |
|---|---|---|
| Route feasibility and legality | Constraint/policy version, map/routing-provider version, deterministic test corpus ID, result explaining each constraint/tie-break, prohibited-route assertions. | A route that violates a declared safety/legal/capacity/time-window constraint is a blocker even if its ETA is fast. |
| ETA/distance quality | Dataset card, data-quality filters, evaluation code digest, held-out cohort definition, segment-level median/p90 measures, confidence/coverage explanation, known-bias register. | Do not treat unverified or poor-quality location samples as ETA ground truth. |
| Operator review | Blind-review protocol, sampled route IDs, reviewer role/training, decision and rationale, disagreement resolution. | Product acceptance cannot rely solely on aggregate automated metrics. |
| Degradation and change control | Traffic/map-source outage behavior, fallback policy, user/operator disclosure, route/model/version rollout/rollback record. | A degraded source must not fabricate precision or bypass constraints. |
| Geofence geometry | Immutable policy/geometry version, canonical geometry checksum, CRS, source/licence authority, effective period, scope, approver, rollback version. | The archive must reconstruct exactly which geometry and policy applied at event time. |
| Geofence decision quality | Curated point/path test set; boundary/holes/multipolygon results; accuracy/hysteresis/dwell policy; field/shadow metrics for false/missed triggers; duplicate/stale/out-of-order event tests. | No automated enforcement without shadow evidence and approved accuracy-aware safeguards. |
| Geofence authorization/privacy | Create/approve/publish/override access test, operator override event, audit trail, consent/retention classification, data minimization review. | Unauthorized change, access, or unlogged override is a release blocker. |

## 6. Retention, storage, and access model

The compliance steering committee should approve a data-class-specific retention schedule rather than a universal duration. The schedule needs to distinguish financial/audit records, security evidence, resilience telemetry, location-derived operational records, synthetic data, and raw troubleshooting payloads.

| Archive class | Examples | Proposed handling rule; final duration set by counsel/policy |
|---|---|---|
| A — restricted financial/security | Provider verification evidence, ledger/reconciliation data, security incidents, identity/secret audit trails. | Strong encryption, role-separated access, immutable access logs, legal-hold support, quarterly access review. |
| B — restricted location/safety | Geofence enforcement history, location-derived field traces, safety incidents, operator overrides. | Pseudonymize/minimize, limit access to need-to-know roles, retention/deletion tied to approved purpose and jurisdiction. |
| C — internal operational | k6 summaries, anonymized traces, rendered manifests, chaos artifacts, capacity reports, non-sensitive service logs. | Immutable release bundle, least-privilege read access, defined operational retention, periodic integrity sampling. |
| D — public/internal non-sensitive | Sanitized runbooks, non-sensitive aggregate scorecards, release decision summary. | Normal document controls, version history, no secrets or personal data. |

Storage must provide encryption, a tamper-evident or immutable retention option for final release dossiers, off-site durability appropriate to the approved recovery policy, independent audit access, and periodic restore/readability tests. Evidence exports should be watermarked or logged with requester, reason, and case/release ID.

## 7. Pre-release archive acceptance test

Before a release dossier is accepted, execute this audit-retrieval exercise:

1. Select one multi-pod chaos run, one payment sandbox lifecycle case, one routing scorecard case, and one geofence shadow-policy case.
2. An independent reviewer retrieves the run charter, exact source/configuration, topology, raw/redacted telemetry, database invariant output, recovery result, and approval decision using only the dossier index.
3. The reviewer verifies artifact hashes, confirms no secret/PAN/CVV is in the general artifact bundle, and tests that restricted data cannot be read by an unauthorized role.
4. The finance reviewer follows one event from accepted callback through provider verification, internal state transition, ledger balance, and reconciliation report.
5. The safety/compliance reviewer reconstructs the policy and geometry version that applied to one geofence decision and confirms override/audit history.
6. Record retrieval time, missing evidence, access-control failures, and corrective actions. The release is conditional until all deficiencies are corrected and re-tested.

## 8. Steering committee minimum sign-off package

A committee pack should include a one-page decision summary plus links to the immutable dossier, not large unindexed log exports. The summary must list hard-gate outcome, performance trials, financial/reconciliation status, security/privacy status, routing/geofence scorecards, unresolved P1/P2 issues, exceptions/expiry, rollout limit, rollback authority, and named approvers.

The committee must receive enough evidence to conclude that: the specified release was tested; the test had a bounded non-production blast radius; financial/assignment/safety invariants passed; failures recovered safely; and any residual risk is explicit, owned, time-limited, and does not cross a non-negotiable gate.

## References

[1]: chaos_gateway_tooling_and_steering_committee_rubric_20260903.md "Automated resilience tooling and formal sign-off rubric"

[2]: multipod_gateway_routing_geofence_acceptance_plan_20260903.md "Multi-pod, payment, routing, and geofence acceptance plan"

[3]: https://github.com/Shopify/toxiproxy "Toxiproxy fault-injection documentation"

[4]: https://grafana.com/docs/k6/latest/ "Grafana k6 documentation"
