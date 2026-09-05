# Lagos Ride-Hailing Private Beta: Peak-Hour Load Assessment and Operations Runbook

**Prepared:** 2026-09-03  
**Scope:** A controlled 5,000-active-trip simulation of the Go matching worker and Python payment webhook, followed by the operating and compliance workflow required for a Lagos private beta.  
**Decision status:** **Engineering load gate passed in an isolated environment; commercial beta remains blocked pending the legal, insurance, provider, safety, and production-operations gates listed below.**

> **Legal and regulatory notice.** This is an operational implementation checklist, not Nigerian legal, insurance, tax, employment, or transportation advice. Lagos-specific requirements, fees, classifications, and enforcement practice must be confirmed in writing by qualified Nigerian counsel and the relevant agencies before accepting a passenger or activating a driver.

## 1. Peak-Hour Simulation

The simulation used a fresh PostgreSQL 16/PostGIS database, Redis, one real Go matching-worker process, one real Python/FastAPI webhook process, and a local provider-verification fixture. It seeded **5,000 available, compliant drivers**, **5,000 requested ride trips**, and **500 completed-payment rides**. The load driver issued **5,000 match attempts at 128 concurrent clients** and **500 signed payment callbacks at 64 concurrent clients**. Each request used the real service HTTP surface; no production credentials, live funds, or real customer data were used.

| Workload | Requests | Concurrency | HTTP success | p50 | p95 | p99 | Maximum | Transport errors |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Go dispatch matching | 5,000 | 128 | 5,000 `200` | 107.677 ms | 661.750 ms | 1,444.083 ms | 3,571.453 ms | 0 |
| Python payment webhook | 500 | 64 | 500 `202` | 979.533 ms | 1,130.375 ms | 1,198.090 ms | 1,279.183 ms | 0 |

The durable outcome was complete: all **5,000** requested trips reached `driver_offered`, exactly **5,000** pending offers existed, all **500** provider payments reached `captured`, all **500** signed webhook events were processed, and Redis contained **zero** remaining available drivers. PostgreSQL recorded **0 deadlocks**, **0 transaction rollbacks**, no transport errors, and a maximum observed **6 lock waiters** across **18** database sessions. The worker used Redis GEO member discovery for candidate acceleration and PostgreSQL row/unique-guard checks for every durable offer.

| Database / cache outcome | Measured result | Interpretation |
|---|---:|---|
| PostgreSQL commits / rollbacks | 7,839 / 0 | The final read-committed matching transaction and conditional reservation avoided the earlier serializable retry storm. |
| PostgreSQL deadlocks | 0 | No deadlock was observed in this one-process simulation. This is not a substitute for multi-pod chaos testing. |
| Maximum sampled lock waiters | 6 | Lock contention existed but did not cause request failure in the final run. |
| PostgreSQL blocks hit / read | 3,764,700 / 23 | The warm, local test mostly used cached pages; do not extrapolate this ratio to production storage. |
| Redis available drivers after offers | 0 | The worker removed each selected driver from the GEO candidate set after durable offer creation. |

### 1.1 Defect found and remediated during the test

The first 5,000-trip attempt used `SERIALIZABLE` transactions for independent ride requests. It returned **1,216 HTTP 200 responses and 3,784 HTTP 503 responses**, with 12,287 rollbacks caused by serialization retries. Redis location-query parsing also failed because the worker used an API intended for coordinate-bearing replies when it needed only member IDs.

The matching worker was corrected in three ways. It now uses Redis `GEOSEARCH` member IDs, falls back to indexed PostGIS discovery when a Redis result set is stale, and uses `READ COMMITTED` isolation with conditional `available → offer_pending` reservation plus database unique guards. The final run is the evidence reported above. These controls preserve the invariant that Redis does not decide assignment; PostgreSQL remains the authority.

### 1.2 Capacity conclusion and limits

This is an **isolated single-host engineering result**, not a production SLO certification. It demonstrates that the current worker can complete a 5,000-trip burst with the tested concurrency profile and no database deadlocks after the remediation. It also identifies the payment path as the principal latency constraint: every callback performs a fresh PostgreSQL connection and synchronous provider verification. Before public release, operate connection pooling, provider timeouts/circuit breaking, a durable webhook queue, and provider-sandbox load validation.

The following gates are mandatory before treating the result as a city-scale capacity commitment.

| Gate | Required evidence | Pass condition |
|---|---|---|
| Multi-replica dispatch test | At least three matching-worker pods and two payment-webhook pods on production-equivalent PostgreSQL/Redis | No duplicate assignment, no duplicate payout, and error rate within the beta SLO during a sustained 15-minute peak profile. |
| Redis resilience test | Redis primary failover and intentional cache flush while matching continues | PostgreSQL fallback preserves correctness; degraded latency and availability stay within a pre-approved error budget. |
| Database resilience test | Postgres failover, connection pool saturation, and a restore rehearsal | No money or assignment duplication; recovery time and data-loss measures meet signed RTO/RPO. |
| Payment provider sandbox test | Real selected provider sandbox using signed callbacks, verification, transfers, reversals, and duplicate webhooks | Reconciliation is zero-difference; invalid/replayed callbacks are rejected; no unverified payout is released. |
| Security test | Independent application, API, mobile, payment, and cloud-configuration assessment | All critical/high findings closed or formally risk-accepted by accountable leadership. |

## 2. Private-Beta Operating Model

The beta should begin with one Lagos service zone, scheduled operating hours, named on-call staff, invited riders, and a small verified-driver cohort. It must not offer cash collection, pooling, airport operations, intercity service, unrestricted public sign-up, or automatic payout release until their separate controls are approved.

| Function | Accountable owner | Pre-launch responsibility | Peak-hour responsibility |
|---|---|---|---|
| Service operations | City Operations Lead | Zone boundaries, driver roster, hours, passenger communications | Monitor supply, trip completion, cancellations, and manual recovery queue. |
| Safety | Safety Lead / 24×7 escalation partner | Emergency SOP, local emergency contacts, incident triage, evidence retention | Own emergency, assault, crash, harassment, missing-person, and unsafe-driver response. |
| Dispatch reliability | Engineering on-call | SLO dashboard, rollback plan, Redis/PostgreSQL alerting, load test | Resolve matching backlog, cache degradation, and trip-state anomalies. |
| Payments and reconciliation | Finance Operations Lead | Provider contract, settlement account, payout approval rules, daily reconciliation | Monitor capture/transfer failures, chargebacks, duplicate callbacks, and payout holds. |
| Compliance and privacy | Nigerian counsel and DPO | Written approvals, DPIA, notices, retention schedule, processing register | Approve new data uses, regulator responses, breach handling, and driver activation exceptions. |

### 2.1 Launch-day control room

The launch-day bridge must include the City Operations Lead, Safety Lead, Engineering on-call, Finance Operations Lead, and a Nigerian compliance representative. No single employee should be able to activate drivers, change payout recipients, approve payouts, and reconcile provider settlements.

The control room must monitor matching p95/p99 latency, match success rate, candidate exhaustion, driver location freshness, Redis errors, database connection pool utilization, PostgreSQL lock waits/deadlocks, webhook signature failures, provider verification failures, duplicate event rate, capture success, payout-hold count, chargeback count, and safety-event response times. Alert thresholds are operational decisions that must be approved before beta; alerts should page rather than merely log when they affect passenger safety, payment integrity, or dispatch availability.

### 2.2 Incident procedure

| Severity | Examples | Immediate containment | Escalation and closure |
|---|---|---|---|
| SEV-1 Safety | Active emergency, crash with injuries, credible assault/abduction report | Stop new matching in the affected zone if needed; contact emergency services through the approved local protocol; preserve evidence; keep rider/driver contact channels active. | Safety Lead owns case; counsel/privacy lead assesses notification; executive duty officer approves public/regulator communication. |
| SEV-1 Financial | Unauthorized payout, confirmed capture mismatch, payment-provider compromise | Disable payouts; rotate provider credentials; block affected recipient/driver accounts; preserve webhook and ledger records. | Finance Lead reconciles provider and ledger; security lead investigates; release only after dual approval. |
| SEV-2 Dispatch | Matching success collapse, stale locations, Redis outage, database failover | Enable PostgreSQL fallback; reduce admission rate; suspend new offers only if correctness is at risk; communicate delay to riders. | Engineering on-call tracks recovery; City Operations manages manual completion/cancellation. |
| SEV-2 Compliance | Suspected identity fraud, expired insurance, data-rights request, security/privacy incident | Suspend affected driver or processing path; preserve audit trail; stop non-essential sharing. | DPO/counsel determines statutory and contractual notifications. |

Every SEV-1/SEV-2 case needs a timestamped incident record, accountable commander, decision log, affected-trip list, customer communication record, evidence-preservation action, and a post-incident corrective-action review.

## 3. Driver Onboarding and Ongoing Compliance Workflow

Driver activation must be a **four-eyes, evidence-based workflow**. The platform may gather and validate information, but it must not infer regulatory eligibility from an incomplete document set. The Lagos State Drivers’ Institute publicly lists a valid driver licence and visual-acuity test among its requirements; its current card/training applicability to the beta must be verified directly with LASDRI and Lagos authorities before activation.[1]

| Stage | Required evidence / action | System state | Approval rule |
|---|---|---|---|
| 1. Application | Invite-only registration, mobile/phone verification, consent to screening, privacy notice acknowledgement | `applicant` | No trip access. |
| 2. Identity and right-to-drive | Government identity/NIN evidence, current driver licence, identity/document consistency review, fraud/liveness review through an approved provider | `identity_pending` | Fail closed when a document is unreadable, expired, inconsistent, or not independently validated. |
| 3. Lagos professional-driver requirements | Obtain and validate every current Lagos requirement confirmed by counsel and agencies, including LASDRI competence/training and any LASRRA, badge, or permit requirement that applies to the chosen vehicle/service class | `city_compliance_pending` | Written agency/counsel confirmation is required; do not rely on a historical blog or competitor policy. |
| 4. Vehicle onboarding | Registration evidence, ownership/authorized-use evidence, current roadworthiness/inspection evidence, vehicle photographs, capacity/class match, and no disqualifying damage | `vehicle_pending` | Field or approved remote inspection; expiring evidence creates automatic suspension before expiry. |
| 5. Insurance | Broker/insurer confirmation of commercial/e-hailing/passenger-use cover, policy number, insured vehicle, named or eligible driver, coverage dates, insurer licence status, and claims contact | `insurance_pending` | Do not accept ordinary private-use cover as sufficient. Use an insurer licensed for motor business; NAICOM publishes licensed motor insurers.[2] |
| 6. Safety and quality | Safety training, passenger conduct, emergency protocol, accessibility/non-discrimination, child/vulnerable-person rules, intoxication policy, consented background/screening checks where lawful, and in-app safety feature training | `safety_pending` | Training completion and policy attestation are auditable; serious safety flags block activation. |
| 7. Payment and tax | CBN-licensed provider recipient verification, account-holder match review, payout hold policy acceptance, tax identity/document collection and finance review | `payout_pending` | Never store raw bank credentials; payout recipient must be provider-verified and separation-of-duty approved. |
| 8. Activation | Final compliance checklist, dual approval, service-zone assignment, insurance/eligibility expiry timers, first-trip support briefing | `active` | Only city-specific active drivers are candidate eligible. |

### 3.1 Ongoing driver monitoring

The service must automatically suspend matching eligibility when the driver licence, city credential, vehicle inspection, commercial insurance, payout recipient, or safety clearance expires or is revoked. It should use staged notices at 30, 14, 7, and 1 day before expiry, but the actual notice schedule must be validated against operating experience and any legal requirements. A driver must be removed from Redis availability and blocked by PostgreSQL eligibility in the same operating event.

Driver complaints, low ratings, repeated cancellation, abnormal route deviation, high-speed events, device compromise signals, identity mismatch, fraud signals, payment chargebacks, and safety reports must enter a case-management queue. Automated signals may trigger a temporary safety hold, but final adverse decisions require documented human review, clear evidence, appeal path, and privacy-aware retention.

## 4. Data Protection, Payments, Insurance, and Regulatory Gates

The Nigeria Data Protection Commission is the public authority for Nigeria’s data-protection regime.[3] Location traces, identity documents, safety reports, and payment-linked data make the ride service a high-risk processing context. Before beta, appoint the appropriate data-protection leadership, maintain a processing register, complete a documented DPIA, minimize/segregate safety and location data, define retention/deletion rules, implement access logging and data-subject-rights handling, control cross-border transfer arrangements, and rehearse breach response. The final applicability of registration, DPO, and reporting obligations must be validated against the Nigeria Data Protection Act and current NDPC guidance.

| Area | Private-beta prerequisite | Evidence retained |
|---|---|---|
| Lagos e-hailing authority | Written confirmation of current operator approval, data/reporting, driver, vehicle, service-zone, fare, and fee conditions for the selected launch model | Counsel opinion; regulator correspondence; approved policy register. |
| Corporate and tax | Nigerian operating entity, tax registrations and invoicing/withholding treatment confirmed for fares, commissions, and payouts | CAC/tax records; finance sign-off; provider settlement agreement. |
| Motor/passenger insurance | Commercial passenger/e-hailing cover verified per active vehicle; claims and passenger-injury procedures tested | Policy schedule, insurer/broker confirmation, expiry monitor, claims drill. |
| Payment provider | Contract with a CBN-licensed provider appropriate to the final funds flow; provider sandbox and reconciliation passed | Licence/authorisation due diligence, contract, API security review, daily reconciliation evidence. |
| Privacy and security | DPIA, privacy notice, consent/notice workflow, role-based access, audit logs, data-retention schedule, incident plan | DPO sign-off, penetration test, access review, incident exercise. |
| Safety | 24×7 escalation coverage or an approved equivalent for the beta hours, emergency contacts, accident/assault process, rider/driver safety controls | Training records, drill logs, on-call roster, case-management audit. |

## 5. Private-Beta Go/No-Go Checklist

The accountable executive may authorize invited-rider beta only when every item is evidenced, signed, and current.

1. The 5,000-trip engineering result is repeated in a production-like multi-pod environment, including Redis and PostgreSQL failover.
2. The selected payment provider has approved the actual collection, split/transfer, webhook, reversal, chargeback, and payout model; no provider key, URL, recipient, or host placeholder remains in deployment configuration.
3. Lagos operator and driver/vehicle requirements are confirmed in writing by qualified local counsel and the competent agencies.
4. Every activated driver has current identity, licence, city credential, vehicle, insurance, safety, payout, and tax evidence under the approved workflow.
5. Commercial passenger/e-hailing insurance coverage and claims escalation are confirmed for every active vehicle.
6. The NDPC/DPIA/privacy/access-control programme is approved and the breach-response exercise has passed.
7. The service has named incident commanders, safety coverage, on-call rotations, dashboards, alert rules, communications templates, and a completed simulation for safety, provider, Redis, Postgres, and payment failure.
8. Finance has signed off daily provider-to-ledger reconciliation, payout holds, manual exception approval, refunds, chargebacks, and end-of-day close.
9. PostgreSQL backups, WAL/PITR, restore drills, and RPO/RTO are signed off; Redis recovery is understood as cache recovery, not a financial or assignment source of truth.
10. The beta terms, rider communications, support escalation, cancellation/refund process, and stop-service procedure are tested with the invited cohort.

## References

[1]: https://www.new.lasdri.org/ "Lagos State Drivers’ Institute (LASDRI)"
[2]: https://naicom.gov.ng/2025/04/14/list-of-insurance-companies-licensed-to-transact-motor-insurance-business-in-nigeria/ "NAICOM: Licensed Motor Insurance Companies"
[3]: https://ndpc.gov.ng/ "Nigeria Data Protection Commission"
