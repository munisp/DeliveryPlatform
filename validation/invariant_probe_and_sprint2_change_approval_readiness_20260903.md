# Invariant-Probe Semantics and Sprint 2 Change-Approval Readiness

**Purpose.** This guide explains the exact PostgreSQL queries executed by the protected staging invariant Job and gives the operational checklist that must be completed before requesting a Sprint 2 staging-chaos change approval.

> **Scope boundary:** The probe is a post-experiment control for an isolated resilience database. It is not a replacement for application tests, provider reconciliation, alert observation, security review, backup restoration, or human finance/compliance approval. A zero-count result is necessary but not sufficient evidence for release readiness.

## 1. How the invariant Job runs

The controller generates a unique Job name from the approved run ID, mounts the reviewed SQL as an immutable ConfigMap file, and starts a hardened PostgreSQL client Job. The only database connection value is supplied through the `resilience-invariant-probe-database` Secret in the isolated `resilience-test` namespace. The workflow controller never decodes that Secret.

The Job invokes:

```text
psql "$(DATABASE_URL)" -v ON_ERROR_STOP=1 -f /sql/invariant-probe.sql
```

The SQL begins with `\set ON_ERROR_STOP on` and `BEGIN;`. Any `RAISE EXCEPTION`, SQL error, or failed assertion terminates psql with a non-zero status, causes the Kubernetes Job to fail (`backoffLimit: 0`), and causes the staging controller to fail. Only the terminal query returning `resilience_invariant_probe=PASS` followed by `COMMIT` counts as a successful probe.

The controller clears an active Toxiproxy toxic or deletes the active PodChaos object **before** starting this Job. For a pod-kill scenario it also waits for the matching deployment rollout. This makes the probe a recovery/postcondition check, rather than measuring a deliberately unhealed outage.

## 2. Exact query set

### 2.1 Signed webhook verification queue drain

```sql
DO $$
DECLARE
  deadline_at timestamptz := clock_timestamp() + interval '30 minutes';
  pending_webhooks bigint;
BEGIN
  LOOP
    SELECT COUNT(*)
      INTO pending_webhooks
      FROM mobility.provider_webhook_event
     WHERE signature_valid = true
       AND processed_at IS NULL;

    EXIT WHEN pending_webhooks = 0;
    IF clock_timestamp() >= deadline_at THEN
      RAISE EXCEPTION 'webhook verification queue did not drain within 30 minutes; pending=%', pending_webhooks;
    END IF;
    PERFORM pg_sleep(5);
  END LOOP;
END;
$$;
```

| Element | Meaning | Pass condition |
|---|---|---|
| `signature_valid = true` | Limits the queue drain check to callbacks whose raw-body signature was accepted. Invalid signatures must not cause financial processing and are not considered accepted work. | Only valid signed callbacks are in scope. |
| `processed_at IS NULL` | Defines work that remains uncompleted by the durable verification path. | Count reaches zero. |
| `clock_timestamp() + interval '30 minutes'` | Bounds the recovery window. `clock_timestamp()` advances during the transaction, unlike transaction-start time. | Queue drains before the deadline. |
| `pg_sleep(5)` | Polls at a modest five-second interval rather than continuously querying the database. | No excessive database polling. |
| `RAISE EXCEPTION` | Makes a stuck queue a hard failure rather than a warning. | Never raised. |

This check proves that signed callbacks in the **dedicated resilience database** have all reached a terminal `processed_at` state within the configured recovery window. It does not by itself prove that the provider’s external records are reconciled, that an unknown event was correctly quarantined, or that a production queue with unrelated historical work is healthy. The test database must be reset before each run so unrelated work cannot create ambiguous failures.

### 2.2 Duplicate pending driver offers

```sql
SELECT COUNT(*)
  INTO duplicate_pending_offers
  FROM (
    SELECT driver_user_id
      FROM mobility.driver_offer
     WHERE state = 'pending'
     GROUP BY driver_user_id
    HAVING COUNT(*) > 1
  ) AS duplicate_offer_driver;
```

This query groups all currently `pending` offers by `driver_user_id` and counts the groups with more than one row. A count greater than zero would mean at least one driver holds more than one live offer simultaneously.

The table already has the durable partial unique index:

```sql
CREATE UNIQUE INDEX mobility_driver_offer_one_pending_idx
  ON mobility.driver_offer (driver_user_id) WHERE state = 'pending';
```

The probe is intentionally redundant with the database constraint. It validates the observable final state after concurrency/load/failure recovery, detects a missing/invalid constraint in the actual resilience schema, and records an explicit business-invariant outcome in the experiment dossier. A passing result means **no duplicate pending offers exist**. It does not prove that offers were delivered to devices promptly or that no duplicate notification happened; those require outbox/projection and client-delivery evidence.

### 2.3 Duplicate live driver assignments

```sql
SELECT COUNT(*)
  INTO duplicate_live_assignments
  FROM (
    SELECT driver_user_id
      FROM mobility.driver_assignment_guard
     WHERE state IN ('reserved', 'en_route', 'arrived', 'on_trip')
     GROUP BY driver_user_id
    HAVING COUNT(*) > 1
  ) AS duplicate_assignment_driver;
```

The query inspects the durable guard table for assignments considered live: `reserved`, `en_route`, `arrived`, and `on_trip`. It groups by driver and fails if any driver has two or more live guard rows.

`mobility.driver_assignment_guard` uses `driver_user_id` as its primary key and `trip_id` as a unique value, so a valid current schema already prevents two guard rows for a driver and prevents two drivers holding the same trip. As with the offer query, this independent aggregate check proves the post-test state, catches an environment/schema mistake, and places a comprehensible count in the failure message.

| What it verifies | What it does not verify |
|---|---|
| A driver has at most one row in the live assignment guard and no duplicate row exists for a live state. | Correct driver-route quality, physical location accuracy, device-attestation quality, or client notification delivery. |
| The current resilience database still honors the durable guard model after a pod failure/load run. | A historical assignment was never duplicated and later repaired before the probe. Trace/event audit is needed for that temporal guarantee. |
| The experiment did not leave a driver multiply committed at probe time. | That live-state definitions are the final product-approved set; changes require governance and test update. |

### 2.4 Balanced double-entry ledger transactions

```sql
SELECT COUNT(*)
  INTO unbalanced_ledger_transactions
  FROM (
    SELECT transaction_id
      FROM mobility.ledger_posting
     GROUP BY transaction_id
    HAVING COALESCE(SUM(amount_kobo) FILTER (WHERE direction = 'debit'), 0) = 0
        OR COALESCE(SUM(amount_kobo) FILTER (WHERE direction = 'debit'), 0)
           <> COALESCE(SUM(amount_kobo) FILTER (WHERE direction = 'credit'), 0)
  ) AS unbalanced_transaction;
```

For each `mobility.ledger_posting.transaction_id`, the query separately totals positive `amount_kobo` values marked `debit` and `credit`. It fails a transaction if either condition is true:

1. The debit total is zero, which catches a transaction with no debit side.
2. The debit total differs from the credit total, which catches a non-zero imbalance.

Because the `amount_kobo` column is constrained positive and the direction is constrained to `debit` or `credit`, the query is a straightforward double-entry balance test in exact integer minor units. It is consistent with the schema’s `mobility.assert_balanced_ledger(uuid)` function, which selects debit/credit totals and raises if debit is zero or totals differ.

A passing result means every ledger transaction with postings in the resilience database has a non-zero debit total exactly equal to its credit total. It does **not** prove correct account classification, correct customer/driver amount, current tax treatment, provider settlement success, or external bank balance. Those remain finance, reconciliation, provider, and regulatory controls.

### 2.5 Verified-money-state guard

```sql
SELECT COUNT(*)
  INTO unverified_money_transitions
  FROM mobility.provider_payment
 WHERE state IN ('captured', 'settled')
   AND verified_at IS NULL;
```

The callback is only a signed signal. Monetary state may advance only after provider-side verification. This query fails if any payment is `captured` or `settled` but has no durable `verified_at` timestamp. A passing count of zero is direct evidence that the resilience run did not create an accepted money state solely from an inbound callback payload.

### 2.6 Signed webhook processing errors

```sql
SELECT COUNT(*)
  INTO webhook_processing_errors
  FROM mobility.provider_webhook_event
 WHERE signature_valid = true
   AND processing_error IS NOT NULL;
```

The probe currently treats any persisted processing error on a valid signed callback as a failed resilience run. This is intentionally conservative for a standard **all-success** load/fault recovery scenario: the queue must recover cleanly after the fault is removed.

For a separate negative/terminal-quarantine test, do not reuse this all-success probe without an approved scenario-specific expectation. Instead, create a separately reviewed probe that verifies the terminal/quarantine reason, attempt count, lack of financial mutation, alert creation, and operator review. Treating a deliberately invalid event as a universal pass would weaken the positive-path financial recovery guarantee.

### 2.7 Composite failure and terminal success

```sql
IF duplicate_pending_offers <> 0
   OR duplicate_live_assignments <> 0
   OR unbalanced_ledger_transactions <> 0
   OR unverified_money_transitions <> 0
   OR webhook_processing_errors <> 0 THEN
  RAISE EXCEPTION
    'resilience invariants failed: duplicate_pending_offers=%, duplicate_live_assignments=%, unbalanced_ledger_transactions=%, unverified_money_transitions=%, webhook_processing_errors=%',
    duplicate_pending_offers,
    duplicate_live_assignments,
    unbalanced_ledger_transactions,
    unverified_money_transitions,
    webhook_processing_errors;
END IF;

SELECT 'resilience_invariant_probe=PASS' AS result;
COMMIT;
```

The composite condition reports every observed count in one failure message, rather than failing at the first category and concealing others. A failure rolls back the probe transaction; it does not modify application financial or assignment rows. The only modification outside the transaction is the controller’s creation of its test ConfigMap and Job. A successful `COMMIT` plus terminal `PASS` marks the experiment’s database postcondition as satisfied.

## 3. Query limits and companion evidence

| Limit | Why it matters | Required companion control |
|---|---|---|
| Snapshot timing | A final-state aggregate can miss a transient duplicate that was repaired before the probe. | Database constraints, transaction/event traces, application idempotency tests, and selected real-time alert counters. |
| Isolated database only | Broad query predicates are correct only when the database contains the scenario’s synthetic workload. | Reset/recreate the test database before run; archive seed manifest and teardown proof. |
| No provider-side reconciliation | Internal balance/verification state cannot prove remote provider/bank settlement. | Provider sandbox reconciliation, transfer verification, finance close, and exception review. |
| No semantic amount validation | Balance does not prove a fare/tax/commission value was economically correct. | Fare/settlement allocation tests, source-of-truth price/commission policy, finance sampling. |
| No external delivery proof | Offer rows do not prove one device notification or human receipt. | Durable outbox/projection evidence, delivery telemetry, retry/reconciliation test. |
| Negative event handling differs | A terminal/quarantined malformed event may be correct but the all-success probe treats it as a failure. | Separate approved negative-path scenario/probe with no-financial-mutation condition. |
| Queue success must be bounded | An empty queue alone could result from improper deletion. | `signature_valid`, raw event durability, event count/reconciliation checks, worker logs/traces. |

## 4. Operational prerequisites before requesting change approval

**Do not request the change approval** until each item below has a named evidence link and an accountable owner has verified it. A blank, untested, or “will be done during the window” entry is a reason to defer approval.

### 4.1 Governance and experiment charter

| # | Pre-approval condition | Required evidence | Accountable verifier |
|---:|---|---|---|
| 1 | One fixed scenario is selected: `baseline`, `gateway-latency`, `gateway-timeout`, `gateway-reset`, `gateway-outage`, or `matching-worker-pod-kill`. | Charter names exactly one scenario and no unreviewed parameter/function. | SRE experiment owner. |
| 2 | Change/experiment ID is assigned. | Change record with purpose, hypothesis, start/end window, source commit, run ID convention, and rollback authority. | Change manager / steering chair. |
| 3 | Required approvers are scheduled and reachable. | Named SRE, product observer, security reviewer; additionally finance control for any payment path and compliance/safety where applicable. | Steering chair. |
| 4 | Stop conditions are explicit. | Written P0/P1 stop conditions: unverified money state, imbalance, duplicate active assignment, unexpected egress/secret access, harmful policy action, or unavailable cleanup. | SRE/security/finance. |
| 5 | Evidence archive is prepared. | Restricted dossier location, access list, retention class, run-artifact schema, and evidence custodian. | Compliance/security. |

### 4.2 Environment and access boundary

| # | Pre-approval condition | Required evidence | Accountable verifier |
|---:|---|---|---|
| 6 | Exact cluster context is non-production. | `kubectl config current-context` matches documented `RESILIENCE_TEST_CONTEXT`; environment protection is configured. | SRE. |
| 7 | Namespace is isolated and labelled. | `resilience-test` has `resilience.delivery-platform.io/environment=non-production`; quota/limits and separate ingress are applied. | SRE. |
| 8 | CNI/RBAC boundaries are enforced, not merely present. | Positive/negative ingress/egress/DNS/metadata probes; least-privilege `kubectl auth can-i` results; no ordinary namespace/Secret access. | Security + SRE. |
| 9 | All workloads and dependencies use synthetic/de-identified data. | Dataset card, seed manifest/counts, disposable Postgres/PostGIS database, isolated Redis, teardown/recreation procedure. | Product data owner + compliance. |
| 10 | Test-only secret and identity paths work. | External-secret/workload-identity readiness; secret key-presence only; rotation/revocation test; no value printed or stored in artifact. | Security. |
| 11 | Immutable source/image provenance is known. | Approved commit, signed/digested images, SBOM/vulnerability result, rendered manifests without unresolved placeholders, rollback image. | Security + SRE. |
| 12 | Required control planes exist. | k6 `testruns.k6.io` CRD, Chaos Mesh `podchaos.chaos-mesh.org` for pod kill, Toxiproxy deployment/service, and version/RBAC inventory. | SRE. |

### 4.3 Service, payment, and data preparation

| # | Pre-approval condition | Required evidence | Accountable verifier |
|---:|---|---|---|
| 13 | Resilience replicas are ready and correctly labelled. | At least three running matching replicas for pod kill; at least two payment workers; topology/PDB/HPA evidence; health checks green. | SRE + engineering. |
| 14 | Payment worker’s provider route is simulator-only. | Rendered redacted configuration points to cluster-local Toxiproxy; proxy upstream is simulator DNS:port; target CNI proves no real provider/prod egress. | Finance + security/SRE. |
| 15 | Provider simulator contract works. | Successful authorised verification/transfer fixture test, rejected bad token test, redacted request log, and teardown policy. | Python/backend + finance. |
| 16 | Database/cache state is clean and seeded. | No prior run IDs; required test trips/drivers/payments exist; Redis GEO data populated; baseline schema/migration version recorded. | Backend/SRE. |
| 17 | Invariant Job can access only the test database. | `resilience-invariant-probe-database` key presence, role privilege listing, dry-run Job manifest, SQL checksum, and no application write privilege beyond required read/poll. | Security + DBA/SRE. |

### 4.4 Observability and operational recovery

| # | Pre-approval condition | Required evidence | Accountable verifier |
|---:|---|---|---|
| 18 | Baseline telemetry is known. | Ten-minute low-load baseline for ingress p50/p95/p99, matching errors, queue age/depth, verification latency, DB/Redis pool waits, outbox/backlog, and invariant counters. | SRE. |
| 19 | Alert routes are tested. | Fire/ack/recovery evidence for P0 financial/assignment and P1 queue/provider/replica alerts; named on-call recipients. | SRE + finance/security as applicable. |
| 20 | Dashboard/traces/logs have safe correlation. | `release_id` and `resilience_run_id` correlation, time synchronization, redaction verified; no secrets/card data/raw unnecessary locations. | SRE + compliance. |
| 21 | Cleanup is rehearsed. | TestRun delete, PodChaos delete, Toxiproxy `clear`, workload rollout recovery, Job/log collection, generated ConfigMap/Job purge, data/cache purge. | SRE experiment owner. |
| 22 | Finance/assignment postcondition is runnable. | Invariant SQL checksum matches reviewed commit; Job image/secret/configmap mount validated; standard positive-path probe has completed successfully against baseline. | Finance control + SRE. |
| 23 | Window and communications are prepared. | No conflicting migrations/rollouts; banner/channel/incident bridge; start/stop times; stakeholder availability; customer/staff impact boundary. | SRE + product operations. |

## 5. Approval request packet

The change request should contain the following concise packet, each as a link to the evidence archive rather than embedded sensitive material.

| Packet section | Minimum content |
|---|---|
| Summary | Change ID, scenario, hypothesis, target isolated environment, window, source/image revision, expected impact. |
| Scope and boundary | Exact context/namespace, workload labels, ingress hostnames, data classification, prohibited production targets, CNI/RBAC evidence. |
| Fault specification | Single allowlisted scenario, fixed parameter values, expected start point, duration, automatic/manual cleanup method. |
| Readiness checklist | Items 1–23 above with pass evidence or approved deferral. Any hard-gate deficiency must block, not be noted informally. |
| SLO/invariant criteria | k6 thresholds, allowed error budget, p95/p99 goals, queue recovery window, and all invariant Job zero-count requirements. |
| Rollback and escalation | Stop authority, exact disable/clear/delete commands, incident bridge, P0/P1 escalation contacts, restart/reconciliation procedure. |
| Evidence handling | Artifact path, redaction/classification, hash/checksum, retention policy, and reviewers. |
| Approvals | SRE/security/product plus finance/compliance as scenario requires; expiry and scope of each approval. |

## 6. Request/no-request decision

Request the change approval only when all relevant preconditions are **Verified**, the charter identifies exactly one fixed scenario, and the accountable reviewers can observe and stop the run. Do not request if any P0 condition remains incomplete: environment isolation; secret/identity boundary; synthetic-data reset; no-production payment route; observability/alerting; cleanup/rollback; invariant probe; or required finance/security/compliance attendance.

A granted approval authorizes one time-bounded experiment only. It does not authorize a production test, live-money provider fault, automatic repeated chaos schedule, routing/geofence enforcement, broader fault combination, or an unconditional launch.

## References

[1]: ../../deploy/kubernetes/resilience-test/invariant-probe.sql "PostgreSQL invariant probe source"

[2]: ../../drizzle/0026_ride_hailing_dispatch.sql "Ride-hailing offers, assignment guard, ledger, payment, and webhook schema"

[3]: ../../scripts/testing/resilience/run-staging-chaos-validation.sh "Protected staging chaos controller"

[4]: sprint_2_staging_chaos_pipeline_hook_implementation_20260903.md "Sprint 2 protected staging chaos hook"

[5]: chaos_gateway_tooling_and_steering_committee_rubric_20260903.md "Chaos sign-off rubric and escalation matrix"
