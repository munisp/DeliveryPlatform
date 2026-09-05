# Multi-Pod Dispatch, Redis Recovery, and Payment Certification Playbook

**Scope:** Protected-staging acceptance evidence for the DeliveryPlatform matching and payment paths.  
**Data classification:** Synthetic accounts, synthetic drivers/riders/trips, test-only provider credentials, and non-routable or provider-sandbox endpoints only.  
**Authority model:** PostgreSQL/PostGIS remains authoritative for driver eligibility, conditional reservation, active assignment, payments, ledger entries, payout gates, and reconciliation. Redis is a bounded location/candidate acceleration layer. A signed payment callback is a signal; provider-side verification precedes every monetary state change.

> This playbook is an independently authored validation design. It does not claim compatibility with another product's workflow, API, schema, or operational implementation.

## 1. Multi-pod performance acceptance architecture

### 1.1 Protected-staging topology

Deploy a test-only tenant into an isolated namespace/account segment. The ingress path must match the intended launch topology: TLS ingress/load balancer, network policies, service DNS, three Go matching replicas, two Python payment-webhook replicas, a PostgreSQL 16/PostGIS primary with a capacity-equivalent connection limit, and a Redis topology matching the intended cache deployment. Database and Redis addresses must be non-production and accessible only through workload identities.

| Layer              | Minimum validation topology                                                                                                          | Instrumentation and invariant                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Load generators    | Three k6 runners on separate nodes/zones when available; one coordinator assigns `X-Resilience-Run-Id` and synthetic tenant/run IDs. | Record p50/p90/p95/p99, HTTP status, active VUs, generated IDs and clock synchronization.                                                                         |
| Ingress            | Same controller, TLS mode, timeouts, request size limits, connection limits, and retry settings intended for launch.                 | Export request duration/5xx/429/connection/retry metrics by service and route. Disable retries that can duplicate callback delivery unless idempotency is proved. |
| Matching           | Three replicas; set a measured bounded admission limit per pod.                                                                      | Capture Go request/DB pool/Redis operation metrics, candidate count, reservation conflict count, PostgreSQL lock waits, offer/outbox recovery lag.                |
| Payment            | Two replicas and durable queue worker(s), separate from ingress availability measurement.                                            | Capture accept latency separately from queue claim, provider verify, final payment status and payout completion latency.                                          |
| PostgreSQL/PostGIS | Dedicated protected-staging database with query/lock/pool telemetry, backup protection, and synthetic data only.                     | Assert one active driver assignment, one pending offer constraint, balanced ledger entries, provider verification prior to capture/payout.                        |
| Redis              | Staging cache matching desired replication/failover mode.                                                                            | Capture command latency, rejected connections, role/failover, cache hit/fallback count, and projection/reconciliation age.                                        |
| Observability      | Real Prometheus/Alertmanager, logs and traces with run ID, dashboards and alert routes.                                              | Alerting is observed, but alert actions cannot change payment/assignment state.                                                                                   |

### 1.2 Test data and traffic shape

Seed a deterministic Lagos-like synthetic geography or another approved synthetic area. Every fixture must contain a test tenant and ID prefix that permits exact cleanup. Never use real driver locations, documents, phones, payment instruments, or a live provider wallet.

The campaign has five waves. Each wave must start from a clean database/cache/run ID and be followed by durable SQL invariant probes.

| Wave         | Traffic                                                                                                                       | Purpose                                                                            | Minimum assertions                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Baseline     | 25–50 concurrent matching attempts, 10 concurrent signed payment notifications.                                               | Establish no-chaos p50/p95/p99 and queue baseline.                                 | 100% valid request handling; no duplicate active assignment; balanced ledger.                                      |
| Target load  | 5,000 active synthetic trips over the agreed arrival period, with bounded concurrent matching requests; 500 callback accepts. | Reproduce the representative local demand at multi-pod topology.                   | Matching p95 and callback-accept p95 meet the approved SLO; completion SLO measured separately.                    |
| Burst        | 2× planned arrival rate for 2–5 minutes, then recovery.                                                                       | Prove explicit overload/backpressure.                                              | 429/503 are explicit and bounded; no unbounded DB pool or in-memory queue growth; recovery within agreed duration. |
| Replica loss | Drain/kill one matching pod and one webhook pod in separate runs.                                                             | Verify PDB/HPA/readiness/outbox/queue recovery.                                    | No lost durable offer/event, duplicate reservation, provider double effect, or queue orphan.                       |
| Soak         | 60–120 minutes at 60–70% planned peak.                                                                                        | Find leak, fragmentation, pool saturation, timer, queue-age or cache drift issues. | Stable heap/CPU/pool/queue; no sustained SLO breach or invariant failure.                                          |

The availability criteria must be declared before testing. A recommended starting point is matching response p95 <200 ms and callback acceptance p95 <200 ms for valid synthetic requests at the agreed bounded concurrency. Do not use those response measures as payment settlement objectives. Define distinct thresholds for receipt-to-claim, claim-to-provider-confirmation, and receipt-to-terminal-state queue age.

### 1.3 Required durable SQL/invariant checks

Run the immutable `invariant-probe.sql` after every wave and additionally sample during long tests. Reject the run if any count is non-zero: duplicate pending driver offer; duplicate active driver assignment; ledger transaction with unequal debit/credit minor units; captured/settled payment without provider verification; signed webhook with a processing error; or signed callback still pending after the agreed drain window.

The expected state ownership is:

```text
client/location/callback request
  -> ingress validation and durable PostgreSQL state
  -> Redis projection/cache only after durable change
  -> Redis read is a bounded acceleration
  -> PostgreSQL/PostGIS eligibility/reservation/provider verification decides ownership or money
  -> outbox/reconciliation restores projections after degradation
```

## 2. Redis degradation and recovery procedures

### 2.1 Guardrails before fault injection

Only the test namespace Redis route may be faulted. Confirm that PostgreSQL/PostGIS capacity can support fallback work and establish a maximum fault duration, abort threshold, operator, change ID, and circuit-breaker behavior. Do not perform a Redis fault while payment-provider certification is capturing real sandbox financial effects unless provider and finance owners specifically approve the combined exercise.

| Preflight                  | Evidence required                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Cache is non-authoritative | Reviewed source/config and a baseline test showing a reservation still requires PostgreSQL conditional write. |
| Redis client bounds        | Connection-pool cap, dial/read/write timeout, retry policy, and circuit-breaker or fallback metrics are set.  |
| Database capacity          | PostgreSQL pool headroom, query/lock baseline, statement timeout, and fallback candidate plan recorded.       |
| Rollback                   | Exact fault-clear command, owner, stop condition, PDB state, and invariant-probe invocation prepared.         |
| Correlation                | New run ID appears in ingress, Go structured events, database fixture IDs, cache fault tool and dashboards.   |

### 2.2 Fault scenarios

Use Toxiproxy, Chaos Mesh network fault, or the approved staging fault controller. Prefer one fault at a time. Each scenario must prove both the short-term safe behavior and convergence after recovery.

| Scenario              | Injection                                                                | Expected matching behavior                                                                                                                                       | Recovery proof                                                                                          |
| --------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Latency               | Add 100–250 ms Redis downstream latency for a bounded 2–5 minute window. | Matching bounds Redis wait and uses the authoritative PostGIS eligibility/fallback route or explicit overload response.                                          | Command latency falls; cache/fallback ratio normalizes; outbox projection and reconciliation age drain. |
| Timeout/unreachable   | Reset connection or blackhole Redis service path.                        | No invented availability; matching either uses PostGIS fallback within budget or returns retryable backpressure. Payments remain PostgreSQL/provider controlled. | Fault cleared; connections recover without restart storm; all durable offers/assignments reconcile.     |
| Partial node/failover | Simulate one cache endpoint loss if topology supports it.                | Client selects surviving cache or bounded fallback; no reservation loss.                                                                                         | Role/replica recovery recorded; projection lag returns to target.                                       |
| Stale cache           | Pause updates while PostgreSQL location/presence changes continue.       | Candidate is revalidated with PostgreSQL/PostGIS eligibility and location/time/device rules before reservation.                                                  | Reconciler corrects stale projections; no invalid assignment remains.                                   |
| Cache saturation      | Restrict connections or add command failure.                             | Explicit pool/timeouts; do not permit goroutine/request accumulation.                                                                                            | Pool wait falls after release; p95 recovers; no leaked handles.                                         |

### 2.3 Abort and rollback conditions

Immediately clear the injected Redis fault, stop new traffic, open the resilience breaker, and preserve evidence if any monetary state changes without provider verification; a ledger imbalance appears; a driver gains two active assignments; a Redis value is treated as a final reservation; database lock/pool saturation persists past the declared budget; or client retries create unbounded load. After fault clearance, run the invariant probe, drain worker queues, compare durable offers/assignments to projected cache state, and only then permit a new test run.

## 3. Payment-provider sandbox certification

### 3.1 Entrance criteria

Select one approved, licensed provider for the target jurisdiction, obtain a segregated sandbox merchant, webhook secret, verification API credentials, test settlement report access, documented IP/TLS requirements, support channel and sandbox terms. Store credentials only through the protected secret manager; never include them in source, Kustomize output, test logs, Alertmanager payloads, or application traces.

The test team must maintain a provider-to-internal state mapping approved by finance and compliance. No callback payload should be mapped directly into captured/settled state without an exact provider verification query.

### 3.2 Protocol and authenticity tests

| Test                      | Input                                                                                                | Required assertion                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Correct callback          | Provider sandbox sends signed raw body for a test payment.                                           | Ingress returns accepted/durable response; no capture before provider verification.                                          |
| Tampered body/signature   | Change a byte, replay signature, wrong secret, missing signature.                                    | Request rejected; no durable callback event and no payment/ledger/payout mutation.                                           |
| Header/encoding variation | Provider-supported timestamp/content encoding and raw-body behavior.                                 | Verification is interoperable without normalizing the signed bytes incorrectly.                                              |
| Key rotation              | Old/new sandbox webhook secret during documented overlap.                                            | Expected active secret(s) accepted only in approved rotation period; audit indicates key generation identity but not secret. |
| Replay/idempotency        | Deliver exact event repeatedly and concurrent duplicates.                                            | One durable event effect; no duplicate ledger or payout operation.                                                           |
| Ordering                  | Deliver completion before a delayed prior event, duplicate status, or terminal-after-terminal event. | State machine is monotonic/guarded; invalid transition quarantines without money mutation.                                   |

### 3.3 Authoritative verification and failure tests

| Test                                   | Provider behavior                                                                           | Required result                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Verified success                       | Verification API returns exact reference, amount, currency, merchant, status and timestamp. | Internal payment can transition only after equality checks and balanced ledger posting.                                          |
| Mismatch                               | Callback reference/amount/currency/status does not match verification result.               | Terminal/quarantine state with alert; no ledger/payout effect.                                                                   |
| Unknown payment                        | Verification returns a reference not known to internal payment records.                     | Terminal non-retryable quarantine; no new payment record is fabricated.                                                          |
| Provider 429/5xx/timeout/TLS/DNS fault | Introduce bounded provider path failures.                                                   | Durable event remains pending/retryable only where safe; jittered exponential backoff; provider outage alert; no capture/payout. |
| Delayed success                        | Provider verification initially times out and later confirms success.                       | Exactly one final money effect after later verified response.                                                                    |
| Permanent validation error             | Invalid signature/malformed verified response/non-billable unsupported event.               | Terminal state; no endless retry; operator-facing evidence retained.                                                             |

Acceptance requires a measured completion SLO and bounded queue age. Provider unavailable is not a reason to mark payment complete from callback data. Financial effects must stay absent until provider verification returns an exact expected result.

### 3.4 Funds lifecycle and payout certification

Exercise the provider's supported lifecycle using test-only payments and test-only payout destinations.

| Lifecycle test                             | Required internal result                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Authorization/capture or direct collection | Idempotent payment transition and exactly balanced ledger transaction in integer minor units.                                |
| Duplicate success and delayed webhook      | No duplicate collection, invoice settlement, ledger row, or driver payout.                                                   |
| Void/cancel before capture                 | No capture ledger event; terminal internal state reconciles with provider.                                                   |
| Full and partial refund                    | Refund amount/currency/ref relation matches provider verification; balances and invoice state reconcile.                     |
| Chargeback/dispute/reversal                | Payment/payout eligibility gates hold or reverse according to approved policy; no automatic unsafe reactivation.             |
| Payout initiate/status/failure/retry       | One idempotency key, held payout eligibility, provider verification, status progression and failed-transfer recovery.        |
| Provider report reconciliation             | Internal payment, ledger, payout and fee totals match a downloaded/queried sandbox settlement report by day/cycle/reference. |

### 3.5 Settlement reconciliation workflow

Reconciliation must be run independently of webhook processing. It is not a retry of the webhook handler.

1. **Acquire a bounded provider settlement report** for a test-only date/cycle using a read-only provider reporting credential.
2. **Normalize to an approved internal staging table** keyed by provider reference, merchant/currency, gross amount, fee, net amount, payout identifier and provider final state. Store the source digest, retrieval time and report period; do not alter original ledger facts.
3. **Join internal immutable records**: `payment`, signed/verified `provider_webhook_event`, ledger transaction/entries and `payout` records. Use only integer minor-unit values and exact currency equality.
4. **Classify every row** as matched, timing difference, expected held payout, expected provider pending, internal-only anomaly, provider-only anomaly, amount/currency mismatch, duplicate, or illegal state transition.
5. **Require zero unexplained exceptions** before certification. A timing difference is acceptable only with a named owner, due date, provider reference, documented policy and later closure evidence.
6. **Prohibit automatic adjusting entries** for unexplained differences. Finance must create an approved, auditable correcting workflow after provider evidence is reviewed.
7. **Archive redacted evidence**: query/report digest, run ID, counts and sum totals by classification, exception register, reviewer sign-off and provider support case references. Never archive credentials, full payment instrument details or raw callback signatures.

A final certification rehearsal must cover at least one settlement cycle from collection through report reconciliation, a delayed webhook, an outage/retry scenario, a refund or dispute supported by the provider, and a payout failure/recovery path. Finance, engineering, SRE, security and compliance must each approve their respective evidence.

## 4. Completion criteria

The remaining score can change only when the following are all true for the agreed protected-staging target:

- Multi-pod load, burst, soak, replica loss and cache-degradation tests meet declared SLOs and all durable invariant probes are clean.
- Cache fault recovery shows PostgreSQL/PostGIS remains the authority and projections/outbox converge within an approved window.
- Payment sandbox protocol, verification, failure, lifecycle, payout and independent settlement-reconciliation tests pass with no unexplained discrepancy.
- Real monitoring/CNI/API-server/admission evidence is archived along with change approvals and incident/rollback results.
- Product, finance, SRE, security, compliance and legal owners sign their distinct release gates.

## References

[1] [Independent protected-staging readiness scorecard and clean-room gap analysis](protected_staging_readiness_scorecard_and_cleanroom_gap_analysis_20260904.md)

[2] [Protected-staging latency and payment acceptance evidence](ride_matching_payment_latency_and_cleanroom_acceptance_20260903.md)

[3] [Gateway resilience monitoring and alert thresholds](gateway_resilience_monitoring_and_alert_thresholds_20260903.md)

[4] [Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/)

[5] [PostgreSQL documentation](https://www.postgresql.org/docs/)
