# Gateway-Resilience Monitoring Dashboards and Alert Thresholds

**Scope.** This specification covers validation and controlled-launch monitoring for the Go matching worker, Python payment webhook worker, PostgreSQL/PostGIS, Redis, ingress, and the payment-provider path. It distinguishes **technical acceptance latency** from **financial correctness**, which remains a hard gate regardless of latency.

> The numerical thresholds below are proposed initial release/validation thresholds. Product, SRE, finance control, security, and compliance must approve them alongside the expected demand, provider contract, and queue-recovery objective. No threshold may override a financial, assignment, safety, or privacy invariant.

## 1. Instrumentation prerequisite

The current services expose health and protected queue status, but this source-tree review did not identify a Prometheus `/metrics` endpoint or emitted histogram/counter contract for the new matching and payment paths. Therefore, **do not deploy alert expressions as though they are already collecting data**. First add the metric contract below, register service monitors/scrape configuration, and test alert delivery in the isolated staging namespace.

All metrics and logs must include `service`, `environment`, `release_id`, `pod`, and `operation`. Resilience test traffic additionally includes `resilience_run_id` and `scenario_id`. Never use a raw payment reference, raw webhook body, signature, API key, or precise raw location as a metric label.

| Metric family | Required measurements | Safe labels | Purpose |
|---|---|---|---|
| HTTP ingress | Request total, duration histogram, response class, in-flight request gauge. | operation, route class, status class, outcome class. | Match and webhook-acceptance SLOs, overload, and response failures. |
| Matching business invariants | Offered, unfulfilled, idempotent replay, PostgreSQL reservation conflict, duplicate offer/assignment invariant failure. | operation, reason class, zone bucket—not driver/trip IDs. | Distinguishes normal capacity outcomes from unsafe state. |
| Webhook queue | Accepted, claimed, verified, retry scheduled, terminal quarantine, retry exhausted, in-progress count, oldest pending age, claim duration. | event type, outcome/reason class, provider, attempt bucket. | Measures asynchronous verification health independently from HTTP `202`. |
| Provider interaction | Verification/transfer call total, latency histogram, response class, transport/TLS failure, retryable/non-retryable classification. | provider, operation, outcome class, HTTP status class. | Establishes gateway degradation and retry/recovery behavior. |
| Financial invariants | Unverified monetary transition, duplicate provider-event effect, ledger-balance failure, reconciliation unmatched count, payout state exception. | event/state/reason class only. | Hard-stop financial integrity signals. |
| PostgreSQL/PostGIS | Pool in-use/open/wait duration, query-duration histogram by safe query class, transaction commits/rollbacks, deadlocks, lock waits, connection failures. | service, query class, operation. | Identifies persistence saturation before it changes business outcomes. |
| Redis | Command-duration/error counts, connection-pool wait, GEO candidate count, PostGIS fallback count, cache-projection failure/reconcile count. | operation, command class, fallback reason. | Shows accelerator health while confirming it does not own assignment authority. |
| Resilience controls | Experiment active marker, intended fault ID, target count, start/end time, cleanup result, run result. | experiment ID, scenario ID, environment. | Prevents interpreting a silent/incorrect fault as a resilience pass. |

## 2. Dashboard A — ingress SLO and capacity

This dashboard answers: **Can valid matching and webhook-acceptance traffic enter the system within the approved SLO, and are failures/overload visible?** It should display separate healthy and declared-degraded views; never average Redis fallback or chaos-fault traffic into a normal baseline.

| Panel | Query concept | Display | Initial attention threshold |
|---|---|---|---|
| Matching latency | p50/p90/p95/p99 histogram quantiles by `operation=match`. | Last hour plus release/run annotations. | p95 > 160 ms warns; p95 > 200 ms pages during validation. |
| Webhook acceptance latency | p50/p90/p95/p99 for `operation=webhook_accept`. | Last hour plus provider/chaos annotations. | p95 > 160 ms warns; p95 > 200 ms pages during validation. |
| Success and overload | 2xx, 4xx, 429, 5xx, timeout/transport rate per operation. | Stacked rate and ratio. | 5xx/timeout ≥ 0.1% for 5 min is warning; ≥ 0.5% for 5 min is page. |
| Throughput/in-flight | Requests/s, in-flight by pod, k6 arrival rate, completion rate. | Per-pod heatmap and aggregate. | Sustained in-flight growth while completion plateaus is warning. |
| Pod saturation | CPU, memory, restart count, GC/runtime where applicable, HPA replicas. | Per-pod and replica count. | Capacity threshold is derived from baseline; alert before latency breach, not after. |
| Correlation drill-down | Exemplars/traces for slow/error samples. | Trace ID links only. | Required in each release test report. |

## 3. Dashboard B — payment verification queue and provider path

This dashboard answers: **Are accepted callbacks being verified and reconciled safely, including during deliberate provider-network faults?** The `202 Accepted` rate is not a settlement-success metric.

| Panel | Query concept | Display | Initial attention threshold |
|---|---|---|---|
| Queue lifecycle | Accepted, claimed, verified, retry scheduled, terminal quarantined, retry exhausted per minute. | Waterfall/rate comparison. | Accepted minus claimed grows for 5 min: warning; accepted minus verified grows after recovery objective: page. |
| Oldest pending age | Age of oldest unprocessed eligible event and age of oldest active claim. | Current value plus percentile/history. | Pending age > 2 min warns; > 5 min pages after provider/service recovery. Active claim > 2 min pages. |
| Provider verification latency | p50/p95/p99 upstream call duration by provider and operation. | Separate collection and transfer views. | p95 > 3 s warns; > 5 s for 5 min pages. |
| Provider failure classes | Timeout, TLS/connect, HTTP 408/425/429/5xx, semantic/rejected, malformed response. | Stacked error-rate and absolute counts. | Retryable upstream failure ≥ 5% for 5 min pages; ≥ 1% for 10 min warns. |
| Retry budget | Attempt distribution, scheduled next-attempt times, retry exhausted count. | Histogram plus event rate. | Any retry exhaustion is P1 during validation; production severity set by finance/SRE policy. |
| Terminal quarantine | Counts and reason classes only: unknown event/reference, amount/currency mismatch, invalid transition, nonbillable state. | Rate and distinct reason classes. | Any amount/currency mismatch or unknown verified reference pages finance/compliance; unsupported non-financial event is triaged. |
| Worker health | Worker loop success/error, DB pool usage/wait, active claims, process restarts. | Per-pod. | Any worker unavailable with rising queue age pages. |
| Reconciliation | Matched, unmatched, stale outstanding, duplicate-effect, and ledger-balance checks. | Daily and run-scoped status. | Any unbalanced or duplicate/unverified financial effect is P0. |

## 4. Dashboard C — persistence, cache, and durable invariants

This dashboard answers: **Is the acceleration layer or database behavior compromising latency or correctness?**

| Panel | Query concept | Initial threshold | Required response |
|---|---|---:|---|
| PostgreSQL pool wait | p95 acquisition wait and pool saturation by service. | > 50 ms warn; > 100 ms for 5 min page. | Inspect request concurrency, pool size, DB CPU/I/O, slow queries; do not simply raise pool limits. |
| PostgreSQL transaction health | Rollback/error rate, deadlocks, locks waiting, query p95 by query class. | Any unexplained deadlock or integrity constraint error is P1; any invariant failure is P0. | Freeze rollout; retain query/trace evidence; remediate/retest. |
| Redis command health | GEO/search latency, errors, pool wait, connection errors. | Redis error/fallback > 1% for 10 min warns; > 5% for 5 min pages. | Verify PostGIS fallback capacity and cache/reconciliation. |
| Candidate and fallback behavior | Candidate count distribution, no-candidate rate, Redis-to-PostGIS fallback ratio. | Sudden deviation from approved baseline; fallback > 5% for 10 min warns. | Diagnose driver projection/cache/network; preserve PostgreSQL authority. |
| Offer projection/reconciliation | Projection success/failure, reconciliation backlog/age, cache-removal result. | Failure > 0.1% for 5 min warns; sustained backlog beyond approved RTO pages. | Trigger/review reconciliation; no manual cache-only assignment. |
| Assignment correctness | Duplicate active assignment, duplicate pending offer, missing accepted result. | **Any value > 0.** | P0 stop-the-line; block rollout and reconcile data. |

## 5. Dashboard D — chaos experiment and recovery control plane

This dashboard is displayed only during a scheduled resilience run. It overlays experiment start/end and target count on all relevant operational panels.

| Panel | Required view | Hard condition |
|---|---|---|
| Experiment status | Experiment ID, approval ID, namespace, target selector/count, start/end/TTL, controller status, cleanup completion. | A fault outside the allowed namespace or past TTL is P0/P1 according to scope. |
| Hypothesis probes | Precondition baseline, intended service/connection effect, and postcondition check. | If the fault did not occur, the experiment is invalid—not a pass. |
| Blast radius | Affected pods, endpoints, request/error changes, dependency paths, and unexpected target count. | Unexpected scope triggers immediate cleanup and escalation. |
| Recovery | Replica readiness, latency/error return to baseline, queue drain, database/ledger and assignment invariant result. | No recovery/invariant result means the experiment remains failed. |
| Evidence completeness | Artifact hash/index, logs/traces, SQL probe output, approval, cleanup and review record. | Missing evidence makes the result unsuitable for release sign-off. |

## 6. Alert matrix

These alert definitions are deliberately categorized by business harm. Validation alerts should route to the named experiment owner and SRE lead; controlled-launch alerts route according to the approved escalation matrix.

| Alert | Proposed expression concept | For | Severity | First action |
|---|---|---:|---|---|
| `FinancialInvariantViolation` | `unverified_money_transition + duplicate_provider_event_effect + ledger_balance_failure > 0` | Immediate | P0 | Pause affected money automation; preserve provider/payment/ledger evidence; notify finance, compliance, security, SRE. |
| `DuplicateAssignmentInvariantViolation` | `duplicate_active_assignment + duplicate_pending_offer + missing_durable_match_result > 0` | Immediate | P0 | Stop automated offers in affected scope; reconcile PostgreSQL records; notify product operations/SRE/compliance. |
| `WebhookSignatureAnomaly` | Invalid-signature rate > approved baseline *and* absolute count threshold; or any bypass indication. | 5 min | P1; P0 if bypass/exposure | Inspect callback route/key rotation and source; never relax signature checking. |
| `WebhookQueueAgeWarning` | `oldest_pending_age_seconds > 120` | 5 min | P2 | Inspect provider latency, worker health, DB pool, retry schedule; track recovery. |
| `WebhookQueueAgeCritical` | `oldest_pending_age_seconds > 300` after a healthy provider/service probe. | 5 min | P1 | Freeze release expansion; scale/recover worker safely; begin provider escalation and reconciliation. |
| `WebhookClaimStuck` | `oldest_processing_claim_age_seconds > 120` | 2 min | P1 | Investigate worker/process/DB stall; ensure lease/claim recovery, do not force money state. |
| `ProviderVerificationFailureHigh` | Retryable provider verification failure ratio ≥ 5%. | 5 min | P1 | Confirm provider status and network path; retain payload digests; allow bounded retry only. |
| `ProviderLatencyHigh` | Provider verification p95 > 5 s. | 5 min | P1 | Verify proxy/network/provider; watch queue age; do not change acceptance semantics. |
| `WebhookRetryExhausted` | Retry-exhausted count > 0. | Immediate | P1 | Finance/SRE triage and reconciliation; resolve as new event only with provider verification and approval. |
| `PaymentQuarantineFinancialMismatch` | Amount/currency mismatch, unknown verified reference, or invalid verified state transition > 0. | Immediate | P1 | Freeze affected payment flow; finance/compliance investigate; retain restricted evidence. |
| `MatchingP95Warning` | Match p95 > 160 ms. | 10 min | P2 | Inspect concurrency, DB/Redis pool wait, cache fallback, and saturation. |
| `MatchingP95Critical` | Match p95 > 200 ms. | 5 min | P1 | Freeze capacity expansion; apply approved backpressure/rollback; investigate topology and datastore saturation. |
| `MatchingErrorBudgetBurn` | 5xx/timeout ratio ≥ 0.5% or fast-burn forecast beyond approved budget. | 5 min | P1 | Halt rollout; inspect traces and durable invariants. |
| `RedisFallbackElevated` | Redis error or PostGIS fallback ratio > 5%. | 5 min | P1 | Verify PostGIS capacity and Redis health; no cache-only mitigation. |
| `PostgresPoolWaitHigh` | Pool-acquire p95 > 100 ms. | 5 min | P1 | Reduce concurrency/scale correctly; diagnose query and DB resource pressure. |
| `PostgresDeadlockOrIntegrityError` | Deadlock or unexpected integrity error > 0. | Immediate | P1; P0 if state invariant affected | Stop release progression; preserve query and transaction evidence; retest after remediation. |
| `ChaosScopeOrCleanupFailure` | Target outside allowlist, TTL expiry, or cleanup probe failure. | Immediate | P1; P0 if prohibited scope | Trigger kill switch; revoke test access; investigate RBAC/admission controls. |

## 7. Alert-routing and validation rules

1. **Metrics only become release evidence after they are tested.** Generate controlled alert conditions in the non-production namespace and archive firing, routing, acknowledgement, remediation, and recovery evidence.
2. **Use a validated dependency-health signal before escalating queue age.** A growing queue under a confirmed provider outage needs a provider incident workflow; an equally growing queue while the provider probe is healthy suggests an internal P1.
3. **Avoid high-cardinality and sensitive labels.** IDs go in traces/logs with restricted access, not in Prometheus labels.
4. **Record declared chaos state.** Suppress only redundant symptoms with an auditable, time-bounded experiment label; never suppress P0 invariant alerts.
5. **Do not auto-close correctness alerts on metric recovery.** A financial or assignment invariant requires an explicit data reconciliation and a named reviewer.

## 8. Minimum dashboard-acceptance test

Before production release, run the following in the isolated resilience namespace:

| Test | Required outcome |
|---|---|
| Healthy traffic baseline | Dashboard shows match/webhook latency, traffic, pool/capacity, queue lifecycle, and zero invariant failures; labels identify release/run. |
| Provider timeout/reset | Toxiproxy or controlled dependency fault raises provider failure and queue-age signals; callbacks remain durable; no ledger state changes before verification. |
| Webhook worker restart | Stuck-claim/queue signals appear as appropriate; recovery drains safely; alert is acknowledged and evidence archived. |
| Redis degradation | Fallback and latency/capacity panels show transition; durable assignment invariants remain zero. |
| Duplicate/invalid callback | Signature/quarantine/duplicate counters reflect outcome without sensitive labels; financial hard-gate remains zero. |
| Synthetic invariant signal | In an isolated test metric path only, P0 routing is delivered and incident process is rehearsed; no production mutation is performed. |
| Chaos cleanup | Experiment marker ends, targets return to normal, and alerts clear only after postcondition/invariant probes pass. |

## References

[1]: chaos_gateway_tooling_and_steering_committee_rubric_20260903.md "Chaos, gateway tooling, and steering-committee rubric"

[2]: compliance_release_audit_evidence_archive_20260903.md "Compliance release audit-evidence archive specification"

[3]: ride_matching_payment_latency_and_cleanroom_acceptance_20260903.md "Latency evidence and remaining production gaps"
