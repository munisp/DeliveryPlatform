# Ride-Matching and Payment-Webhooks: Latency Evidence and Independent Capability Acceptance Checklist

**Assessment date:** 3 September 2026  
**Scope:** The Go ride-matching worker and Python payment-webhook service, exercised only against disposable local PostgreSQL/PostGIS and Redis instances with a local fixture payment provider.  
**Conclusion:** The measured synchronous targets were met in the specified controlled workload. This is **not** evidence of unconditional production readiness, a provider certification, or literal third-party product parity.

> The implementation keeps PostgreSQL/PostGIS as the authority for offer reservation, eligibility, financial state, idempotency, and ledger balance. Redis is a bounded geospatial accelerator only. A payment callback is now an authenticated, durable acceptance signal—not a claim that money has been captured.

## 1. Verified latency result

The final representative test initialized **5,000 available drivers and 5,000 requested trips**, then sent 5,000 matching requests at **24 concurrent matching clients**. In parallel it sent **500 valid payment callbacks at 64 concurrent callback clients**. Each matching request used a 1,500-m Redis GEO radius, a candidate limit of 25, a 32-open/8-idle PostgreSQL pool, and a 128-connection Redis pool. The payment worker used a 32-connection pool, a one-second worker interval, and batches of 100. All dependencies were disposable local processes; no production database, provider key, driver document, or live regulator endpoint was contacted.

| Measured synchronous operation | Requests | Concurrency | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) | HTTP result |
|---|---:|---:|---:|---:|---:|---:|---|
| Go match-attempt creation | 5,000 | 24 | 41.452 | **72.840** | 173.806 | 273.610 | 5,000 × `200` |
| Python signed webhook acceptance | 500 | 64 | 89.114 | **134.364** | 161.485 | 177.331 | 500 × `202` |

The direct evidence is preserved in [`validation/ride_peak_hour_load_20260903/summary.md`](ride_peak_hour_load_20260903/summary.md) and the request-level aggregates in [`load_driver_stdout.json`](ride_peak_hour_load_20260903/load_driver_stdout.json). The harness also observed **zero transport errors**, **zero PostgreSQL rollbacks**, **zero deadlocks**, and **zero observed lock waiters**. It confirmed 5,000 `driver_offered` trips, 500 captured payments, 500 processed webhooks, zero pending queue records, and zero drivers remaining in the Redis available set.

The sub-200-ms statement has a precise boundary: it applies to the **synchronous acceptance paths at the tested client concurrency in this one-process local topology**. It does not establish a global SLO under 128 simultaneous matching clients, multi-pod routing, cross-zone network latency, production provider latency, a real queue outage, or a failover. It also does not measure an async settlement-completion percentile. The latter must become a separately monitored SLO based on queue age and provider verification completion.

## 2. Defects found and remediation applied

| Area | Observed issue | Implemented remediation | Preserved invariant |
|---|---|---|---|
| H3 candidate fan-out | The initial bounded-H3 attempt could have searched a truncated, implicitly ordered set of cells. A low fixed cell count would bias coverage and nearest-driver selection. | The match decision path now uses **full-radius Redis GEO** with an explicit nearest-result count. H3 is still persisted as a spatial projection, but it is not used as an incomplete candidate decision set. PostgreSQL/PostGIS remains the fallback and eligibility authority. | No candidate is excluded merely because an arbitrary H3-cell slice omitted it. |
| Driver reservation | Separate offer insertion and availability update added a database round trip and required compensating deletion after a lost race. | A single PostgreSQL CTE locks a current eligible presence row with `FOR UPDATE SKIP LOCKED`, creates the offer, and updates presence only when the offer row exists. It rechecks availability, location freshness, integrity threshold, driver account/safety state, and eligibility. | A raced driver is skipped, not waited on; a presence record cannot point to an absent offer; PostgreSQL is still the assignment authority. |
| Candidate conflicts | A lost reservation race could prematurely stop the offer wave when only a fixed candidate index was considered. | The matching loop now continues through ranked candidates until the configured number of offers is successfully reserved. | Candidate races do not turn an otherwise fulfilable trip into an avoidable unfulfilled result. |
| Callback latency | The HTTP request synchronously made a provider verification request and wrote financial state, making provider latency part of callback p95. | After raw-body HMAC validation, the endpoint durably inserts an idempotent event and returns `202 Accepted`. A bounded background worker claims records with `FOR UPDATE SKIP LOCKED` and performs provider verification before any money state transition. | Callback data alone never captures a payment or settles a payout. |
| Database connection churn | Python established a new PostgreSQL connection for operations. | `psycopg_pool.ConnectionPool` now provides a bounded reusable pool. A production `requests.Session` reuses outbound HTTP connections and closes during service shutdown. | Connection limits remain explicit and bounded. |
| Retry safety | The worker previously retried all exceptions indefinitely. | Retryable provider availability, timeout, rate-limit, and database-availability errors use jittered exponential backoff. Unsupported event types, unknown verified references, amount/currency discrepancies, nonbillable trip states, and invalid transitions are terminally quarantined. The worker enforces a bounded maximum-attempt policy. | Permanent failure cannot silently loop forever or alter money state. |
| Historical migration safety | Existing records with incomplete historical raw payloads could fail a `NOT NULL` migration. | Migration `0038` deterministically supplies terminal historical metadata, marks unrecognizable historical events processed with an error, and leaves financial facts untouched. It grants access only if the production role exists. | Migration is forward-compatible and does not replay or rewrite historical money events. |
| Operability | Queued verification lacked a protected status surface. | A protected internal endpoint reports pending work, in-progress work, verified count, terminal quarantines, retry exhaustion, and oldest pending age. | Queue diagnostics do not expose payment details publicly. |

The relevant final code is in [`services/go/ride-matching-worker/main.go`](../services/go/ride-matching-worker/main.go), [`services/python/payment-webhook/service.py`](../services/python/payment-webhook/service.py), [`services/python/payment-webhook/main.py`](../services/python/payment-webhook/main.py), and migration [`drizzle/0038_payment_webhook_verification_queue.sql`](../drizzle/0038_payment_webhook_verification_queue.sql). The non-secret Kubernetes tuning is in the reviewed Go and Python runtime ConfigMaps.

## 3. Payment callback and recovery semantics

The endpoint now exposes an intentionally limited contract: a valid callback response means **“accepted for durable provider verification.”** It does not mean captured, settled, paid out, or financially final. Duplicate callbacks are recognized by `(provider, provider_event_id)`, and the durable queue makes acknowledgement survivable across an HTTP-process restart.

| Condition | Worker action | Financial action | Operator signal |
|---|---|---|---|
| Valid collection or transfer callback | Claim once with `SKIP LOCKED`; verify provider-side state | Apply only the immutable, provider-verified amount/currency/state in one database transaction | Verified counter increments |
| Provider timeout, connection failure, 408/425/429, or 5xx | Reschedule with bounded jittered exponential backoff | None | Pending age and processing error visible |
| Provider reports pending/in-progress | Retry within the maximum-attempt policy | None | Pending age alert candidate |
| Unknown event, unknown verified payment/transfer, nonbillable state, amount/currency mismatch, invalid state transition | Mark processed with terminal quarantine reason | None | Quarantine counter and error log |
| Retry budget exhausted | Mark processed with `retry_exhausted` reason | None | Retry-exhausted counter and escalation required |
| Two workers see the same event | Only one claims its row; the other skips it | At most one logical effect, with database idempotency protections as a second layer | Concurrent-claim test passes |

The database integration suite now contains seven cases, including signature rejection before persistence, enqueue-before-provider-call, duplicate idempotency, exactly-once concurrent claim, transient-outage rescheduling with no ledger change, terminal unknown-payment quarantine, retry exhaustion, and unsupported-event quarantine. All seven passed. The valid collection test also confirms a balanced ledger and settled driver payout after the background worker explicitly processes the accepted record.

## 4. Regression and integrity evidence

The final full repository runner, [`scripts/testing/run-full-cross-language-regression.sh`](../scripts/testing/run-full-cross-language-regression.sh), completed with `RESULT=PASS` after the final source changes. It included TypeScript checks, 209 passing TypeScript tests with 30 explicitly skipped integration-dependent tests, production build, Go `-race` tests, Rust tests, Python compilation, payment/compliance/route/surge/financial/telematics integrations, Kubernetes manifest/security/CI checks, static audit, and `git diff --check`.

| Gate | Final observed result |
|---|---|
| Go ride-matching worker | `go test -race ./...` passed |
| Python payment webhook | Python compilation and 7 PostgreSQL-backed integration tests passed |
| TypeScript application | Check, tests, and production build passed |
| Rust pricing and dispatch services | All unit tests passed |
| Kubernetes configuration | 25 manifest files, 17 Deployments, 17 HPAs, and 17 PDBs validated |
| Kubernetes security configuration | 17 runtime identities, 7 NetworkPolicies, 4 ExternalSecrets, and namespace-scoped CI RBAC validated |
| Production static audit | Zero matches for insecure random APIs, production TODO/FIXME, frontend console logging, unstructured Rust/Python stdout, mock/stub/fake markers, and likely empty handlers |
| Diff integrity | Passed |

These are strong regression signals for the source tree, not proof that a target cluster has safe CNI enforcement, immutable images, real workload identity, valid external secrets, payment-provider certification, or operational response coverage.

## 5. Remaining performance and production gaps

The final latency target is met only at the explicitly measured per-pod profile. The following work remains mandatory before treating it as a public-production SLO.

| Gap | Why it remains a gap | Required acceptance evidence |
|---|---|---|
| Multi-pod load and routing | The test used a single Go and single Python process on loopback networking. | Run a production-like multi-pod test with ingress/service-mesh overhead, per-pod concurrency controls, HPA behavior, pod disruption, and cross-zone database/Redis latency. |
| Async verification SLO | The harness proves all 500 records completed, but does not publish p50/p95/p99 queue-to-verification completion latency. | Emit and alert on received-to-claimed, claimed-to-verified, oldest pending age, terminal count, retry exhaustion, and provider error rate; define a separate completion SLO. |
| Backpressure policy | The result uses 24 concurrent matching clients per worker. Higher concurrent demand must be spread across replicas or explicitly throttled. | Define an ingress/per-pod concurrency budget, 429/retry semantics if admission control is used, and load-test it at expected fleet size. |
| Offer projection outbox | The current path still writes a Redis offer projection after the durable transaction commits. It is not authoritative, and reconciliation exists, but this work is still synchronous. | Before moving it fully asynchronous, prove durable outbox consumption, bounded delivery lag, cache eviction recovery, double-offer prevention, and alerting. |
| Provider behavior | Local fixture success is not a payment-provider sandbox certification. | Test the configured gateway’s sandbox signature algorithm, verification response variants, idempotency, dispute/chargeback behavior, payout status reconciliation, outage handling, and credential rotation. |
| Telemetry integrity | Test controls exist; real device attestation and spoofing resistance are environment- and provider-dependent. | Validate mobile attestation, device binding, replay resistance, GPS spoof detection, consent revocation, and operator remediation against real beta devices. |
| Target-cluster safety | Earlier kind validation intentionally stopped short of workload rollout because immutable image placeholders and CNI limitations remained. | Use immutable signed images, a real secret provider, OIDC/workload identity, enforced NetworkPolicies, production CNI tests, restore drills, monitoring, and incident ownership. |

## 6. Clean-room boundary and independent capability checklist

A literal **“Fleetbase feature parity”** finding cannot be made and is not the goal of this review. The named third-party project is published under the GNU Affero General Public License v3.0, and a clean-room implementation must not claim copied endpoint, schema, UI, brand, extension, behavioral, or source-code compatibility.[1] This checklist is independently authored from general logistics and mobility product needs. It is an acceptance framework for product owners and counsel—not a representation of third-party parity.

### Scoring rule

A category can be called **accepted** only when a product owner approves written use cases and test evidence; security/legal sign-off is complete where marked; production dependencies are operating; and the corresponding failure/recovery tests pass. A percentage cannot be credibly assigned by code volume or generic feature names.

| Independent capability area | Present implementation evidence | Remaining acceptance criteria before marking accepted |
|---|---|---|
| Workflow configurability and conditional rules | Durable trips, offers, service zones, state transitions, outbox events, and policy-version fields exist. | Operators can define, version, simulate, approve, roll back, audit, and scope rules by tenant, zone, vehicle class, customer, and time; contradictory-rule detection and test fixtures are required. |
| Real-time matching, ETA, and routing adapters | Redis GEO acceleration, PostGIS eligibility/fallback, H3 projection, and routing/planning service tests exist. | Production traffic/ETA adapter contracts, timeout/degradation policy, cost caps, quality monitoring, map data licensing, and comparison against observed trip outcomes are accepted. |
| Multi-stop, capacity, skills, and time-window planning | Route-planning integration evidence exists. | Vehicle capacity dimensions, driver skills, pickup/drop-off sequence constraints, breaks, shift limits, appointment/time windows, exception replanning, and explainable optimizer results are accepted by operations. |
| Maps, geofences, and operational playback | Geospatial service-zone and location infrastructure exists. | Geofence authoring/versioning, entry/exit auditing, map playback with retention controls, dispatch intervention, privacy redaction, and mobile/offline behavior are tested end to end. |
| Passenger, driver, dispatcher, and merchant applications | Central web/PWA and native project structures are present. | Role-specific journeys use real authenticated APIs for registration, booking, accepting/declining, navigation, proof/issue reporting, support, accessibility, localization, and offline/recovery cases. |
| Telematics, safety, and fraud controls | Device integrity, consent, location freshness, integrity thresholds, and telematics anomaly validation are present. | Independent red-team tests of spoofing, collusion, replay, account takeover, emergency workflows, human-review queues, false-positive governance, and model/rule auditability are accepted. |
| Payment, invoicing, disputes, and reconciliation | Provider payment records, balanced ledger, payout instructions, verified callbacks, payout integration, and queue recovery tests exist. | Gateway sandbox certification; taxes/invoices/receipts; refunds; disputes/chargebacks; settlement reconciliation; payout holds; finance close; support tooling; and a legally approved funds-flow are accepted. |
| Public API, developer experience, and lifecycle governance | Internal authenticated service endpoints and Kubernetes configuration are present. | Versioned public API contracts, tenant OAuth/API key governance, rate limits, webhooks, replay protection, SDK policy, documentation portal, change/deprecation policy, sandbox, usage analytics, and support ownership are accepted. |
| Inbound/outbound integrations | Outbox and service integration patterns are present. | Connector registry, schema validation, dead-letter replay, credentials rotation, retry/idempotency policy, audit trail, data minimization, partner certification, and change control are accepted. |
| Analytics, reporting, scheduled delivery, and export | Operational data structures and reporting-related services exist. | Metric definitions, tenant isolation, freshness SLA, immutable finance reports, scheduled exports, report authorization, CSV/PDF controls, retention, lineage, and reconciliation to ledgers are accepted. |
| Multi-tenant enterprise controls | Tenant-oriented application tests and branding/invite configuration tests exist. | Hard tenant isolation at every query and cache key, delegated administration, SSO/SCIM, RBAC/ABAC, audit export, contractual retention, region controls, and enterprise support processes are accepted. |
| Operational support, audit, and retention | Outbox/events, health checks, runbooks, static/security gates, and validation artifacts exist. | On-call ownership, SLO/error budgets, dashboards/alerts, incident drills, tamper-evident audits, data retention/deletion, backup/PITR/restore drills, DR exercises, and customer-support case controls are accepted. |
| Deployment and supply-chain controls | Manifest, HPA/PDB, RBAC, NetworkPolicy, ExternalSecrets template, and CI validation files exist. | Target-cluster CNI enforcement, real secret backend, workload OIDC identity, immutable signed images/SBOM/vulnerability policies, admission controls, observability agents, actual rollout, and rollback drill are accepted. |
| Local regulatory, insurance, privacy, and operational approvals | Compliance workflow code and Lagos-beta research/runbook artifacts exist. | Counsel and licensed partners verify the current jurisdictional requirements; obtain insurance, payment/settlement, tax, privacy, transport, consumer-protection, and incident-reporting approvals before launch. |

## 7. Acceptance decision

The final code and tests support the following narrow conclusion:

> **For the final controlled, disposable workload, the Go matching acceptance path and Python authenticated webhook-acceptance path both measured below 200 ms at p95 while preserving the tested PostgreSQL assignment, webhook idempotency, provider-verification-before-money, and balanced-ledger invariants.**

The broader conclusion is intentionally more conservative: the platform remains a **protected-staging candidate**, not an unconditional public-production launch and not a verified “100/100” third-party-parity implementation. The checklist above is the defensible route to an independent product acceptance decision.

## References

[1]: https://github.com/fleetbase/fleetbase/blob/master/LICENSE "Fleetbase repository license"

[2]: ride_peak_hour_load_20260903/summary.md "Final disposable 5,000-trip and 500-webhook load summary"

[3]: ../scripts/testing/run-full-cross-language-regression.sh "Cross-language regression runner"

[4]: ../drizzle/0038_payment_webhook_verification_queue.sql "Durable payment-webhook verification queue migration"

[5]: ../services/go/ride-matching-worker/main.go "PostgreSQL/PostGIS-authoritative ride-matching worker"

[6]: ../services/python/payment-webhook/service.py "Provider-verified payment webhook domain service"
