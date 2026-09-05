# Gateway Chaos, k6 Correlation, and Settlement-Reconciliation Inspection

**Scope.** This review distinguishes executable repository assets from the protected-staging certification design. It does not assert a live cluster run, a payment-provider sandbox certification, or unconditional production readiness. The proposed reconciliation migration below is an original PostgreSQL design grounded in the existing `mobility` payment tables; it is **not yet committed or deployed**.

> **Authority boundary.** PostgreSQL/PostGIS owns final driver eligibility, assignment, payment, ledger, payout, and reconciliation facts. Redis is a rebuildable candidate/projection accelerator, and a signed callback is only a signal until provider-side verification succeeds.[1]

## 1. Gateway-fault chaos controller: executable behavior

The high-level controller accepts precisely six scenario names: `baseline`, `gateway-latency`, `gateway-timeout`, `gateway-reset`, `gateway-outage`, and `matching-worker-pod-kill`. Gateway scenarios are delegated to the Toxiproxy shell controller; they do not inject any Redis fault.[2]

| Control | Exact implemented behavior | Assessment |
|---|---|---|
| Explicit authorization | Requires `CONFIRM_APPROVED_STAGING_CHAOS` to equal `<scenario>:<CHANGE_ID>`; the subordinate gateway script independently requires `CONFIRM_NON_PRODUCTION_GATEWAY_FAULTS=run`. | Present; the two gates reduce accidental execution. |
| Target restriction | Requires `TARGET_ENV` to be `test`, `staging`, or `preproduction`, the current context to equal `RESILIENCE_TEST_CONTEXT`, and the namespace label `resilience.delivery-platform.io/environment=non-production`. | Present in both controllers. |
| Initial safety state | Reads `resilience-validation-circuit-breaker` and refuses to start unless its `data.state` is `closed`. | Present. |
| Gateway fault upstream | Requires a DNS `host:port`, rejects IP literals, URLs and names containing `prod` or `production`, and defaults to the dedicated provider-simulator Toxiproxy service. | Script-level protection; it is not an independently verified network-policy proof. |
| Fault cleanup | An `EXIT` trap captures pre-cleanup state on failure, stops the named TestRun, deletes PodChaos when tracked, and calls the Toxiproxy `clear` path when a proxy fault is tracked. Any scenario or cleanup failure after arming opens the breaker and captures artifacts. | Present and fail-closed for the tracked resources. |
| Completion evidence | Waits for TestRun `finished`, clears faults, waits for matching rollout after pod kill, runs the durable PostgreSQL invariant Job, and captures TestRun/PodChaos/resources/events YAML plus probe log. | Present, but it does not archive each k6 runner’s summary/log output. |

### 1.1 High-level scenario allowlist

The parent controller’s `case` expression is the actual orchestration allowlist. Only the following four gateway commands can be reached from it.

| Parent scenario | Subordinate invocation | Toxic/effect | Parent defaults |
|---|---|---|---|
| `gateway-latency` | `latency <latency_ms> <jitter_ms>` | Toxiproxy downstream `latency` | 300 ms latency, 100 ms jitter |
| `gateway-timeout` | `timeout <timeout_ms>` | Toxiproxy downstream `timeout` | 1,000 ms |
| `gateway-reset` | `reset 0` | Toxiproxy downstream `reset_peer` | immediate reset |
| `gateway-outage` | `down` | disables the provider proxy | n/a |

The `baseline` scenario injects no fault. `matching-worker-pod-kill` requires the Chaos Mesh CRD and at least three labelled running matching pods before applying the fixed PodChaos manifest after TestRun startup.[2]

### 1.2 Lower-level Toxiproxy command allowlist

The lower-level script has a wider interactive allowlist than the parent controller: `deploy`, `ensure`, `clear`, `latency`, `timeout`, `reset`, `bandwidth`, `loss`, `down`, and `status`. The extra `bandwidth` and `loss` operations are not reachable through the staging chaos controller today.[3]

Every faulting lower-level command first enables/creates proxy `payment-provider`, clears all existing toxics on that proxy, then adds exactly one downstream toxic at 100% toxicity. `clear` deletes all toxics and re-enables the proxy. Its proxy manifest deploys one hardened, test-labelled Toxiproxy instance exposing control port 8474 and provider port 8666; it has no mounted service-account token, drops Linux capabilities, uses a read-only root filesystem and runs as non-root.[4]

### 1.3 Material controller limitations

The following are implementation gaps rather than evidence of unsafe payment logic.

| Gap | Why it matters | Required correction before treating it as protected-staging Redis evidence |
|---|---|---|
| No Redis scenario exists in either controller. | Gateway degradation only exercises the payment-worker-to-provider-simulator boundary. It does not test Redis client timeout, PostGIS fallback, stale projection, cache failover, or cache saturation. | Add separate allowlisted `redis-latency`, `redis-timeout`, `redis-reset`, `redis-stale-projection`, and `redis-saturation` scenarios, each restricted to an isolated Redis service and each followed by durable and cache-convergence probes. |
| The parent toxic values are configurable without an upper-bound validation. | Defaults are bounded by convention, but a caller can set a very large latency or timeout value; the lower-level script accepts any non-negative latency/reset/timeout. | Enforce maximum latency, jitter, timeout, loss percentage, bandwidth and a maximum wall-clock fault duration in both layers. |
| `TOXIPROXY_API_URL` and proxy name are overrideable without an endpoint identity check. | The default is the dedicated service, but the shell script does not verify that an overridden API endpoint belongs to the labelled test namespace or that an existing proxy’s upstream still matches the accepted simulator. | Resolve the service endpoint through Kubernetes, reject arbitrary controller URLs, and read/compare the existing proxy upstream before mutation. Reinforce this with egress NetworkPolicy. |
| Fixed TestRun name and ConfigMap names are shared. | Concurrent changes can delete or replace another run’s TestRun/configuration. | Derive bounded DNS-safe names from `RUN_ID`, label every resource with the run ID, and reject a conflicting active run. |
| k6 result files are not persisted by the template or copied by the controller. | The JavaScript summary is written to runner-local storage; the controller archives TestRun YAML but not individual runner stdout/summary files. | Configure a durable result sink or copy runner logs/summaries before pod cleanup, recording their SHA-256 digests. |
| Breaker opening is a plain merge patch from the invoking identity. | The controller does not use a resource-version conditional patch. Its safety relies on RBAC/admission controls outside this file. | Use the approved alert receiver or an operator action with explicit identity/RBAC and conditional JSON Patch semantics; preserve an audit event. |

## 2. Distributed k6 peak-ingress configuration and correlation propagation

The launcher requires HTTPS matching and payment ingress URLs and rejects production-like hostnames. It validates the same exact non-production context/namespace label, verifies the k6 TestRun CRD and verifies that the test-only secret contains `internal-service-token` and `payment-webhook-secret`. It writes `RUN_ID`, endpoints, ID prefixes, rates, durations and virtual-user limits into a run ConfigMap, then applies the named TestRun.[5]

The TestRun declares `parallelism: 3` and `separate: true`; therefore it requests three distinct runner pods. It does **not** define topology spread constraints, node affinity or zone affinity, so it cannot by itself prove three different nodes or zones.[6]

| Workload setting | Default in launcher/script | What is actually asserted |
|---|---:|---|
| Matching arrival rate | 80 iterations/second for 15 minutes | Constant-arrival-rate scenario with 50 pre-allocated VUs and maximum 250 VUs. |
| Webhook arrival rate | 10 iterations/second for 15 minutes | Constant-arrival-rate scenario with at least 10 pre-allocated VUs and at least 50 maximum VUs. |
| Graceful stop | 30 seconds | Configured separately for each scenario. |
| Match availability threshold | HTTP failed rate <0.1%; custom success rate >=99.9% | HTTP 200 plus body state `driver_offered` or `matching`. |
| Webhook acceptance threshold | HTTP failed rate <0.1%; custom acceptance rate >=99.9% | HTTP 202 plus `{accepted:true, queued:true}`. |
| Latency threshold | p95 <=200 ms and p99 <=400 ms for each ingress measure | Measures HTTP duration only; payment terminal completion is deliberately outside acceptance latency. |

### 2.1 Exact `X-Resilience-Run-Id` path

The run ID is created by the parent controller or launcher, stored as `RUN_ID` in ConfigMap `resilience-k6-run-config`, injected into every k6 runner environment, required by the JavaScript script, and used as a k6 scenario tag and User-Agent suffix.[5] [6] [7]

| Flow | Header and persistence behavior |
|---|---|
| Matching ingress request | `matchTrip()` sends `X-Internal-Service-Token` and `X-Resilience-Run-Id: <RUN_ID>` to `POST /matches/attempts`; it also tags metrics with `run_id`.[7] |
| Go matching ingress | Middleware validates the identifier against a bounded format, generates an `X-Request-Id` if absent, echoes `X-Request-Id`, echoes a valid resilience-run header, and emits structured completion/domain logs containing both IDs.[8] |
| Payment webhook ingress request | `acceptPaymentWebhook()` signs the exact JSON bytes using `X-Paystack-Signature` and sends `X-Resilience-Run-Id: <RUN_ID>` to `POST /webhooks/payments`; its k6 metrics are tagged with the same run ID.[7] |
| Python payment ingress | FastAPI normalizes/generates the request ID, echoes both headers when the run ID is valid, and passes both values to durable webhook ingestion.[9] |
| Durable payment worker | The webhook insert persists `resilience_run_id` and `request_id`; the worker claims those values, restores the request context and logs subsequent verification actions with the same correlation fields.[10] [11] |

### 2.2 Correlation limitations that must be closed

The script does **not** send `X-Request-Id`; Go and Python each generate one. This is valid for per-request tracing but does not provide a deterministic client-generated request ID across ingress/proxy/service boundaries. The script also does not assert that either response echoes the exact run ID or request ID.

The Go matching code propagates the resilience run to response headers and structured logs. It does not persist the run ID in `mobility.match_attempt`, `mobility.driver_offer`, `mobility.trip_event`, or `mobility.outbox_event`; the `trip_event.correlation_id` is a UUID field independent of the incoming resilience header. In contrast, the Python webhook queue durably stores both IDs. Consequently, a database-only investigation can reliably correlate payment webhook rows but cannot isolate matching facts by resilience run without joining to logs and synthetic ID prefixes.[8] [10]

The k6 template does not seed trips, provider-payment rows or eligible drivers. The matching and webhook body assertions assume that synthetic prerequisites matching the configured ID/reference prefixes were created by a separate protected-staging fixture process. This prerequisite is not represented in the launcher or TestRun manifest.[5] [7]

## 3. Existing payment schema relevant to settlement reconciliation

The current payment path is already built around immutable provider references, integer kobo amounts, a payment-state enum, verified timestamps, an internal double-entry ledger and payout instructions. `mobility.provider_payment` has a unique `(provider, provider_reference)` identity and retains `amount_kobo`, `currency`, payment state, captured/settled/verified timestamps and provider event ID. `mobility.trip_settlement` preserves gross fare, driver earnings, commission, statutory amount and provider fee. `mobility.ledger_transaction` has an immutable idempotency key, and its postings use strictly positive integer `amount_kobo` values with debit/credit direction.[12]

The webhook worker verifies provider collections before moving a payment to `captured`, posts a balanced capture ledger transaction keyed as `ride:<trip_id>:capture`, and makes payout instructions only after those checks. Its payout ledger transaction is keyed as `ride:<trip_id>:payout:<payout_id>`. Signed inbound callbacks are retained in `mobility.provider_webhook_event`, including processing/verification state and the optional resilience/request identifiers added by migration 0039.[10] [11]

The mobility payment tables do **not** currently contain a `tenant_id` or merchant-account foreign key. The independent `billing` schema has `tenant_id`, but it does not establish a key relationship to `mobility.provider_payment`.[13] It would be unsafe to declare a fabricated `NOT NULL tenant_id` backfill against existing payment facts. The design below therefore introduces a tenant/provider/merchant mapping table and an explicit one-to-one payment scope, which must be written transactionally when a provider payment is created.

## 4. Proposed PostgreSQL migration: settlement report ingestion and exception register

The following is a migration specification for `drizzle/0040_payment_settlement_reconciliation.sql`. It is written for PostgreSQL 16+ and uses the existing `pgcrypto` extension installed by migration 0026. It stores no raw payment instrument, raw callback signature or provider credential. The restricted object reference points to an immutable encrypted report artifact held outside PostgreSQL.

```sql
-- 0040_payment_settlement_reconciliation.sql
-- Immutable source records and reconciliation facts. This migration does not alter
-- mobility.ledger_transaction, mobility.ledger_posting, mobility.provider_payment,
-- or mobility.driver_payout_instruction financial facts.

CREATE SCHEMA IF NOT EXISTS mobility;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE mobility.settlement_import_state AS ENUM (
    'acquired', 'normalizing', 'staged', 'reconciling', 'reconciled', 'failed', 'rejected'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mobility.settlement_entry_kind AS ENUM (
    'collection', 'payout', 'refund', 'chargeback', 'adjustment'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mobility.settlement_provider_state AS ENUM (
    'pending', 'settled', 'failed', 'reversed', 'unknown'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mobility.settlement_exception_class AS ENUM (
    'internal_only', 'provider_only', 'amount_mismatch', 'currency_mismatch',
    'fee_mismatch', 'net_mismatch', 'duplicate_reference',
    'unverified_financial_state', 'ledger_imbalance', 'illegal_state_transition',
    'timing_difference', 'expected_held_payout', 'expected_provider_pending',
    'internal_scope_missing', 'unsupported_provider_entry'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mobility.settlement_review_action AS ENUM (
    'acknowledged', 'assigned', 'evidence_attached', 'escalated_to_provider',
    'resolved', 'waived', 'reopened'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS mobility.settlement_merchant_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  provider text NOT NULL CHECK (length(provider) BETWEEN 2 AND 80),
  merchant_reference text NOT NULL CHECK (length(merchant_reference) BETWEEN 4 AND 160),
  settlement_currency char(3) NOT NULL CHECK (settlement_currency ~ '^[A-Z]{3}$'),
  settlement_grace interval NOT NULL DEFAULT interval '72 hours'
    CHECK (settlement_grace >= interval '0 hours' AND settlement_grace <= interval '14 days'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE (tenant_id, provider, merchant_reference),
  CHECK ((active AND retired_at IS NULL) OR NOT active)
);

-- The existing mobility payment schema has no tenant/merchant key. Each payment must
-- receive exactly one scope before it can be reconciled; no guessed historic backfill.
CREATE TABLE IF NOT EXISTS mobility.provider_payment_settlement_scope (
  provider_payment_id uuid PRIMARY KEY
    REFERENCES mobility.provider_payment(id) ON DELETE RESTRICT,
  merchant_account_id uuid NOT NULL
    REFERENCES mobility.settlement_merchant_account(id) ON DELETE RESTRICT,
  scoped_at timestamptz NOT NULL DEFAULT now(),
  scoped_by integer REFERENCES public.users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS provider_payment_settlement_scope_account_idx
  ON mobility.provider_payment_settlement_scope (merchant_account_id, scoped_at DESC);

-- Immutable source-report metadata; the report bytes live only in restricted,
-- write-once object storage identified by source_object_ref.
CREATE TABLE IF NOT EXISTS mobility.settlement_report_source (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_account_id uuid NOT NULL
    REFERENCES mobility.settlement_merchant_account(id) ON DELETE RESTRICT,
  provider_report_id text NOT NULL CHECK (length(provider_report_id) BETWEEN 8 AND 200),
  report_kind text NOT NULL CHECK (report_kind IN ('settlement_cycle', 'daily_statement')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  retrieved_at timestamptz NOT NULL,
  source_object_ref text NOT NULL CHECK (length(source_object_ref) BETWEEN 16 AND 512),
  source_content_type text NOT NULL CHECK (source_content_type IN ('text/csv', 'application/json')),
  source_bytes bigint NOT NULL CHECK (source_bytes > 0 AND source_bytes <= 104857600),
  source_sha256 bytea NOT NULL CHECK (octet_length(source_sha256) = 32),
  retrieval_actor text NOT NULL CHECK (length(retrieval_actor) BETWEEN 3 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_account_id, provider_report_id),
  UNIQUE (merchant_account_id, source_sha256),
  CHECK (period_end > period_start)
);

CREATE TABLE IF NOT EXISTS mobility.settlement_import (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES mobility.settlement_report_source(id) ON DELETE RESTRICT,
  normalizer_version text NOT NULL CHECK (normalizer_version ~ '^[a-z0-9][a-z0-9_.-]{2,80}$'),
  import_key text NOT NULL CHECK (length(import_key) BETWEEN 16 AND 200),
  state mobility.settlement_import_state NOT NULL DEFAULT 'acquired',
  started_at timestamptz,
  completed_at timestamptz,
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  rejected_row_count integer NOT NULL DEFAULT 0 CHECK (rejected_row_count >= 0),
  failure_code text CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 3 AND 128),
  resilience_run_id varchar(81),
  requested_by integer REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (import_key),
  UNIQUE (source_id, normalizer_version),
  CHECK ((state IN ('staged', 'reconciling', 'reconciled')) = (completed_at IS NOT NULL)),
  CHECK (rejected_row_count <= row_count)
);
CREATE INDEX IF NOT EXISTS settlement_import_state_idx
  ON mobility.settlement_import (state, created_at);

-- One row per normalized source line. Amounts use one documented sign convention:
-- collections are positive; outgoing payouts/refunds are negative; net=gross-fee.
CREATE TABLE IF NOT EXISTS mobility.settlement_report_row (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES mobility.settlement_import(id) ON DELETE RESTRICT,
  source_line_no integer NOT NULL CHECK (source_line_no > 0),
  source_record_key text NOT NULL CHECK (length(source_record_key) BETWEEN 1 AND 200),
  entry_kind mobility.settlement_entry_kind NOT NULL,
  provider_reference text NOT NULL CHECK (length(provider_reference) BETWEEN 4 AND 200),
  related_provider_reference text,
  provider_final_state mobility.settlement_provider_state NOT NULL,
  provider_final_status text NOT NULL CHECK (length(provider_final_status) BETWEEN 1 AND 160),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  gross_minor bigint NOT NULL,
  fee_minor bigint NOT NULL,
  net_minor bigint NOT NULL,
  occurred_at timestamptz,
  settled_at timestamptz,
  source_row_sha256 bytea NOT NULL CHECK (octet_length(source_row_sha256) = 32),
  normalized_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (import_id, source_line_no),
  UNIQUE (import_id, source_record_key),
  CHECK (net_minor = gross_minor - fee_minor),
  CHECK (gross_minor <> 0 OR fee_minor <> 0 OR net_minor <> 0),
  CHECK (jsonb_typeof(normalized_metadata) = 'object')
);
CREATE INDEX IF NOT EXISTS settlement_report_row_reference_idx
  ON mobility.settlement_report_row (import_id, entry_kind, provider_reference);

CREATE TABLE IF NOT EXISTS mobility.settlement_reconciliation_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES mobility.settlement_import(id) ON DELETE RESTRICT,
  classifier_version text NOT NULL CHECK (classifier_version ~ '^[a-z0-9][a-z0-9_.-]{2,80}$'),
  as_of timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  result_digest bytea CHECK (result_digest IS NULL OR octet_length(result_digest) = 32),
  failure_code text CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 3 AND 128),
  requested_by integer REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (import_id, classifier_version),
  CHECK ((completed_at IS NOT NULL) = (result_digest IS NOT NULL))
);

-- Detected facts are append-only. Resolution/ownership belongs in an append-only review
-- event table rather than mutating a detected exception.
CREATE TABLE IF NOT EXISTS mobility.settlement_reconciliation_exception (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_run_id uuid NOT NULL
    REFERENCES mobility.settlement_reconciliation_run(id) ON DELETE RESTRICT,
  exception_fingerprint bytea NOT NULL CHECK (octet_length(exception_fingerprint) = 32),
  exception_class mobility.settlement_exception_class NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  provider_row_id uuid REFERENCES mobility.settlement_report_row(id) ON DELETE RESTRICT,
  provider_payment_id uuid REFERENCES mobility.provider_payment(id) ON DELETE RESTRICT,
  payout_instruction_id uuid REFERENCES mobility.driver_payout_instruction(id) ON DELETE RESTRICT,
  provider_reference text NOT NULL CHECK (length(provider_reference) BETWEEN 4 AND 200),
  currency char(3),
  expected_gross_minor bigint,
  reported_gross_minor bigint,
  expected_fee_minor bigint,
  reported_fee_minor bigint,
  expected_net_minor bigint,
  reported_net_minor bigint,
  detected_facts jsonb NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reconciliation_run_id, exception_fingerprint),
  CHECK (jsonb_typeof(detected_facts) = 'object')
);
CREATE INDEX IF NOT EXISTS settlement_exception_class_idx
  ON mobility.settlement_reconciliation_exception (reconciliation_run_id, exception_class, detected_at);

CREATE TABLE IF NOT EXISTS mobility.settlement_reconciliation_review_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exception_id uuid NOT NULL
    REFERENCES mobility.settlement_reconciliation_exception(id) ON DELETE RESTRICT,
  action mobility.settlement_review_action NOT NULL,
  assigned_to integer REFERENCES public.users(id) ON DELETE RESTRICT,
  due_at timestamptz,
  evidence_ref text CHECK (evidence_ref IS NULL OR length(evidence_ref) BETWEEN 16 AND 512),
  rationale text NOT NULL CHECK (length(rationale) BETWEEN 8 AND 2000),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((action = 'assigned') = (assigned_to IS NOT NULL AND due_at IS NOT NULL)),
  CHECK (due_at IS NULL OR due_at > created_at),
  CHECK (action NOT IN ('resolved', 'waived') OR evidence_ref IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS settlement_review_event_exception_idx
  ON mobility.settlement_reconciliation_review_event (exception_id, created_at DESC);

CREATE OR REPLACE FUNCTION mobility.reject_immutable_settlement_fact_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'settlement reconciliation evidence is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION mobility.require_settlement_resolution_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action IN ('resolved', 'waived') AND NOT EXISTS (
    SELECT 1
    FROM mobility.settlement_reconciliation_review_event existing
    WHERE existing.exception_id = NEW.exception_id
      AND existing.action IN ('evidence_attached', 'escalated_to_provider')
  ) THEN
    RAISE EXCEPTION 'a settlement exception requires evidence before resolution or waiver'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS settlement_source_append_only ON mobility.settlement_report_source;
CREATE TRIGGER settlement_source_append_only
  BEFORE UPDATE OR DELETE ON mobility.settlement_report_source
  FOR EACH ROW EXECUTE FUNCTION mobility.reject_immutable_settlement_fact_mutation();

DROP TRIGGER IF EXISTS settlement_row_append_only ON mobility.settlement_report_row;
CREATE TRIGGER settlement_row_append_only
  BEFORE UPDATE OR DELETE ON mobility.settlement_report_row
  FOR EACH ROW EXECUTE FUNCTION mobility.reject_immutable_settlement_fact_mutation();

DROP TRIGGER IF EXISTS settlement_exception_append_only ON mobility.settlement_reconciliation_exception;
CREATE TRIGGER settlement_exception_append_only
  BEFORE UPDATE OR DELETE ON mobility.settlement_reconciliation_exception
  FOR EACH ROW EXECUTE FUNCTION mobility.reject_immutable_settlement_fact_mutation();

DROP TRIGGER IF EXISTS settlement_review_append_only ON mobility.settlement_reconciliation_review_event;
CREATE TRIGGER settlement_review_append_only
  BEFORE UPDATE OR DELETE ON mobility.settlement_reconciliation_review_event
  FOR EACH ROW EXECUTE FUNCTION mobility.reject_immutable_settlement_fact_mutation();

DROP TRIGGER IF EXISTS settlement_review_evidence_required ON mobility.settlement_reconciliation_review_event;
CREATE TRIGGER settlement_review_evidence_required
  BEFORE INSERT ON mobility.settlement_reconciliation_review_event
  FOR EACH ROW EXECUTE FUNCTION mobility.require_settlement_resolution_evidence();

REVOKE UPDATE, DELETE ON mobility.settlement_report_source,
  mobility.settlement_report_row,
  mobility.settlement_reconciliation_exception,
  mobility.settlement_reconciliation_review_event FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'settlement_reconciliation_ingestor') THEN
    GRANT USAGE ON SCHEMA mobility TO settlement_reconciliation_ingestor;
    GRANT SELECT ON mobility.settlement_merchant_account,
      mobility.provider_payment_settlement_scope, mobility.provider_payment,
      mobility.trip_settlement, mobility.driver_payout_instruction,
      mobility.provider_webhook_event, mobility.ledger_transaction,
      mobility.ledger_posting, mobility.ledger_account TO settlement_reconciliation_ingestor;
    GRANT INSERT, SELECT ON mobility.settlement_report_source,
      mobility.settlement_report_row, mobility.settlement_reconciliation_run,
      mobility.settlement_reconciliation_exception TO settlement_reconciliation_ingestor;
    GRANT INSERT, SELECT, UPDATE ON mobility.settlement_import TO settlement_reconciliation_ingestor;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'settlement_reconciliation_reviewer') THEN
    GRANT USAGE ON SCHEMA mobility TO settlement_reconciliation_reviewer;
    GRANT SELECT ON mobility.settlement_reconciliation_exception,
      mobility.settlement_reconciliation_run, mobility.settlement_import,
      mobility.settlement_report_source, mobility.settlement_report_row TO settlement_reconciliation_reviewer;
    GRANT INSERT, SELECT ON mobility.settlement_reconciliation_review_event
      TO settlement_reconciliation_reviewer;
  END IF;
END;
$$;
```

The database-owner role can bypass ordinary table privileges, as it can for any PostgreSQL table. Operations must therefore use separate migration-owner, ingestor and reviewer roles, deny application use of the owner role, and protect the object store with write-once retention and a distinct audit trail.

## 5. Parameterized reconciliation classifier query

The following query is an exact query template for a reconciliation runner. Bind `$1` to an immutable `settlement_import.id` and `$2` to the fixed `as_of` value saved in `mobility.settlement_reconciliation_run`. It applies the source sign convention: collection net is positive `gross - fee`; provider payout net is negative and must equal the negative internal payout amount.

```sql
WITH import_context AS (
  SELECT si.id AS import_id, src.merchant_account_id, src.period_start, src.period_end,
         account.provider, account.settlement_grace
  FROM mobility.settlement_import si
  JOIN mobility.settlement_report_source src ON src.id = si.source_id
  JOIN mobility.settlement_merchant_account account ON account.id = src.merchant_account_id
  WHERE si.id = $1::uuid AND si.state = 'staged' AND account.active
),
provider_rows AS (
  SELECT context.import_id, context.merchant_account_id, context.period_start,
         context.period_end, context.settlement_grace, row.id AS provider_row_id,
         row.entry_kind, row.provider_reference, row.currency, row.gross_minor,
         row.fee_minor, row.net_minor, row.provider_final_state,
         row.provider_final_status, row.occurred_at, row.settled_at,
         COUNT(*) OVER (
           PARTITION BY context.import_id, row.entry_kind, row.provider_reference
         ) AS duplicate_reference_count
  FROM import_context context
  JOIN mobility.settlement_report_row row ON row.import_id = context.import_id
),
collection_ledger AS (
  SELECT pp.id AS provider_payment_id,
         COALESCE(SUM(posting.amount_kobo) FILTER (WHERE posting.direction = 'debit'), 0) AS debit_minor,
         COALESCE(SUM(posting.amount_kobo) FILTER (WHERE posting.direction = 'credit'), 0) AS credit_minor,
         COUNT(posting.id) > 0 AS has_postings
  FROM mobility.provider_payment pp
  JOIN mobility.ledger_transaction transaction
    ON transaction.trip_id = pp.trip_id
   AND transaction.transaction_type = 'fare_capture'
   AND transaction.idempotency_key = 'ride:' || pp.trip_id::text || ':capture'
  LEFT JOIN mobility.ledger_posting posting ON posting.transaction_id = transaction.id
  GROUP BY pp.id
),
payout_ledger AS (
  SELECT payout.id AS payout_instruction_id,
         COALESCE(SUM(posting.amount_kobo) FILTER (WHERE posting.direction = 'debit'), 0) AS debit_minor,
         COALESCE(SUM(posting.amount_kobo) FILTER (WHERE posting.direction = 'credit'), 0) AS credit_minor,
         COUNT(posting.id) > 0 AS has_postings
  FROM mobility.driver_payout_instruction payout
  JOIN mobility.ledger_transaction transaction
    ON transaction.trip_id = payout.trip_id
   AND transaction.transaction_type = 'payout_settlement'
   AND transaction.idempotency_key = 'ride:' || payout.trip_id::text || ':payout:' || payout.id::text
  LEFT JOIN mobility.ledger_posting posting ON posting.transaction_id = transaction.id
  GROUP BY payout.id
),
internal_items AS (
  SELECT context.import_id, context.merchant_account_id, context.period_end,
         context.settlement_grace, 'collection'::mobility.settlement_entry_kind AS entry_kind,
         pp.provider_reference, pp.id AS provider_payment_id, NULL::uuid AS payout_instruction_id,
         pp.currency, pp.amount_kobo AS expected_gross_minor,
         settlement.provider_fee_kobo AS expected_fee_minor,
         pp.amount_kobo - settlement.provider_fee_kobo AS expected_net_minor,
         pp.state::text AS internal_state,
         COALESCE(pp.settled_at, pp.captured_at, pp.created_at) AS internal_occurred_at,
         pp.verified_at IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM mobility.provider_webhook_event event
             WHERE event.provider = pp.provider
               AND event.provider_reference = pp.provider_reference
               AND event.signature_valid
               AND event.processed_at IS NOT NULL
               AND event.processing_error IS NULL
           ) AS verification_evidenced,
         COALESCE(ledger.has_postings, false)
           AND ledger.debit_minor = ledger.credit_minor
           AND ledger.debit_minor > 0 AS ledger_balanced,
         true AS scope_present
  FROM import_context context
  JOIN mobility.provider_payment_settlement_scope scope
    ON scope.merchant_account_id = context.merchant_account_id
  JOIN mobility.provider_payment pp ON pp.id = scope.provider_payment_id
  JOIN mobility.trip_settlement settlement ON settlement.trip_id = pp.trip_id
  LEFT JOIN collection_ledger ledger ON ledger.provider_payment_id = pp.id

  UNION ALL

  SELECT context.import_id, context.merchant_account_id, context.period_end,
         context.settlement_grace, 'payout'::mobility.settlement_entry_kind,
         payout.provider_transfer_reference, pp.id, payout.id, payout.currency,
         -payout.amount_kobo, 0::bigint, -payout.amount_kobo,
         payout.state::text, COALESCE(payout.settled_at, payout.submitted_at, payout.created_at),
         EXISTS (
           SELECT 1 FROM mobility.provider_webhook_event event
           WHERE event.provider = payout.provider
             AND event.provider_reference = payout.provider_transfer_reference
             AND event.signature_valid
             AND event.processed_at IS NOT NULL
             AND event.processing_error IS NULL
         ) AS verification_evidenced,
         COALESCE(ledger.has_postings, false)
           AND ledger.debit_minor = ledger.credit_minor
           AND ledger.debit_minor > 0 AS ledger_balanced,
         true
  FROM import_context context
  JOIN mobility.provider_payment_settlement_scope scope
    ON scope.merchant_account_id = context.merchant_account_id
  JOIN mobility.provider_payment pp ON pp.id = scope.provider_payment_id
  JOIN mobility.driver_payout_instruction payout ON payout.trip_id = pp.trip_id
  LEFT JOIN payout_ledger ledger ON ledger.payout_instruction_id = payout.id
),
joined AS (
  SELECT COALESCE(provider.import_id, internal.import_id) AS import_id,
         provider.provider_row_id, internal.provider_payment_id, internal.payout_instruction_id,
         COALESCE(provider.entry_kind, internal.entry_kind) AS entry_kind,
         COALESCE(provider.provider_reference, internal.provider_reference) AS provider_reference,
         provider.currency AS reported_currency, internal.currency AS expected_currency,
         provider.gross_minor AS reported_gross_minor, internal.expected_gross_minor,
         provider.fee_minor AS reported_fee_minor, internal.expected_fee_minor,
         provider.net_minor AS reported_net_minor, internal.expected_net_minor,
         provider.provider_final_state, provider.provider_final_status,
         provider.duplicate_reference_count, internal.internal_state,
         internal.internal_occurred_at, internal.verification_evidenced,
         internal.ledger_balanced, internal.period_end, internal.settlement_grace
  FROM provider_rows provider
  FULL OUTER JOIN internal_items internal
    ON internal.import_id = provider.import_id
   AND internal.entry_kind = provider.entry_kind
   AND internal.provider_reference = provider.provider_reference
),
classified AS (
  SELECT *,
    CASE
      WHEN provider_row_id IS NOT NULL AND duplicate_reference_count > 1 THEN 'duplicate_reference'
      WHEN provider_row_id IS NOT NULL AND provider_payment_id IS NULL AND payout_instruction_id IS NULL
        AND entry_kind IN ('collection', 'payout') THEN 'provider_only'
      WHEN provider_row_id IS NOT NULL AND entry_kind IN ('refund', 'chargeback', 'adjustment')
        THEN 'unsupported_provider_entry'
      WHEN provider_row_id IS NULL AND entry_kind = 'payout'
        AND internal_state IN ('held', 'queued') THEN 'expected_held_payout'
      WHEN provider_row_id IS NULL AND entry_kind = 'collection'
        AND internal_state IN ('created', 'authorisation_pending', 'authorised', 'capture_pending')
        THEN 'expected_provider_pending'
      WHEN provider_row_id IS NULL
        AND internal_occurred_at >= period_end - settlement_grace
        AND $2::timestamptz <= period_end + settlement_grace THEN 'timing_difference'
      WHEN provider_row_id IS NULL THEN 'internal_only'
      WHEN NOT verification_evidenced
        AND internal_state IN ('captured', 'settlement_pending', 'settled') THEN 'unverified_financial_state'
      WHEN NOT ledger_balanced
        AND internal_state IN ('captured', 'settlement_pending', 'settled') THEN 'ledger_imbalance'
      WHEN reported_currency <> expected_currency THEN 'currency_mismatch'
      WHEN reported_gross_minor <> expected_gross_minor THEN 'amount_mismatch'
      WHEN reported_fee_minor <> expected_fee_minor THEN 'fee_mismatch'
      WHEN reported_net_minor <> expected_net_minor THEN 'net_mismatch'
      WHEN entry_kind = 'collection'
        AND provider_final_state = 'settled'
        AND internal_state NOT IN ('captured', 'settlement_pending', 'settled')
        THEN 'illegal_state_transition'
      WHEN entry_kind = 'payout'
        AND provider_final_state = 'settled'
        AND internal_state <> 'settled'
        THEN 'illegal_state_transition'
      WHEN provider_final_state = 'pending'
        AND internal_state IN ('captured', 'settlement_pending') THEN 'expected_provider_pending'
      ELSE 'matched'
    END AS classification
  FROM joined
)
SELECT classification, COUNT(*) AS reference_count,
       COALESCE(SUM(expected_net_minor), 0) AS expected_net_minor,
       COALESCE(SUM(reported_net_minor), 0) AS reported_net_minor
FROM classified
GROUP BY classification
ORDER BY classification;
```

The runner must snapshot all non-`matched` classifications, including the explicitly expected states, into `settlement_reconciliation_exception` with a SHA-256 fingerprint based on the reconciliation run, entry kind, reference, classification, relevant row/payment/payout IDs and integer values. This preserves the facts that justified a certification decision and makes a repeated run idempotent through `UNIQUE (reconciliation_run_id, exception_fingerprint)`.

The classifier must treat the following as **unexplained** until reviewed: `internal_only`, `provider_only`, `amount_mismatch`, `currency_mismatch`, `fee_mismatch`, `net_mismatch`, `duplicate_reference`, `unverified_financial_state`, `ledger_imbalance`, `illegal_state_transition`, `internal_scope_missing`, and `unsupported_provider_entry`. `timing_difference` is acceptable only after append-only assignment to a named owner with due date, finance rationale and provider/settlement evidence. `expected_held_payout` and `expected_provider_pending` are observable states, not automatic approval of a complete settlement cycle.

## 6. Controlled report ingestion and reconciliation pipeline

Reconciliation is a scheduled or operator-triggered **read-only reporting workflow**, independent of webhook processing. It never calls the payment mutation paths and never posts an automatic ledger adjustment.

| Phase | Required behavior | Failure behavior |
|---|---|---|
| 1. Authorization and target selection | Require an internal authenticated reconciliation role, a configured active merchant account, test-only/sandbox target scope, a bounded date/cycle and a new correlation/run ID. Select only an approved adapter by provider configuration; do not accept a caller-supplied report URL. | Reject before external request; create no report source or financial record. |
| 2. Report retrieval | Use a read-only provider reporting credential. Require HTTPS, configured hostname allowlist, certificate validation, short connect/read deadlines, no credential logging, redirect refusal or revalidation, content type `text/csv` or `application/json`, declared and streamed size no greater than 100 MiB. | Mark the import request failed/retryable according to transport policy; do not write partial rows. |
| 3. Artifact preservation | Stream bytes once while calculating SHA-256. Write the exact raw report to encrypted immutable object storage with a tenant/account-restricted object reference; then create `settlement_report_source` containing period, digest, byte count and retrieval metadata. | Digest/size/content-type mismatch rejects the artifact and prevents normalization. |
| 4. Normalization transaction | Parse row-by-row with fixed column/schema/version rules. Enforce reference, currency, signed minor-unit amount, fee/net equation, UTC timestamp, provider state mapping and duplicate source-line rules. Insert the source and every normalized row in one PostgreSQL transaction, then set import state `staged`. Retain only redacted operational metadata in PostgreSQL. | Any malformed or ambiguous row rolls back the entire staging transaction and marks the import `rejected` or `failed`; it does not silently omit a financial row. |
| 5. Reconciliation snapshot | Lock the staged import, create one `(import_id, classifier_version)` run with a fixed `as_of`, execute the parameterized classifier, insert append-only exception facts and aggregate totals/digest. | Mark only the reconciliation run/import as failed; leave source rows immutable for forensic retry with a new normalizer/classifier version. |
| 6. Review and escalation | Finance/SRE/reconciliation reviewers append assignment, evidence, provider-case and resolution events. A resolution/waiver requires earlier evidence; timing differences require an owner/due date and later closure. | No reviewer action mutates report rows, payment state, payout state, ledger transaction or ledger posting. |
| 7. Release gate | Certification requires zero unexplained exceptions, balanced ledger/verified payment invariants, archived redacted counts/totals/digests, and named financial-owner sign-off. | Do not advance a release gate; preserve artifacts and follow incident/escalation policy. |

### 6.1 Mandatory safeguards in application code

The Python service needs a distinct `SettlementReportAdapter` contract, not a reuse of the webhook `ProviderClient` callback path. The adapter should expose only bounded report retrieval/normalization behavior. It must not expose transfer submission, collection capture, payout state changes or ledger-writing methods.

A separate reconciliation worker should use a dedicated database role that can read existing financial tables and insert into the reconciliation tables, but cannot `INSERT`, `UPDATE` or `DELETE` `mobility.provider_payment`, `mobility.ledger_transaction`, `mobility.ledger_posting` or `mobility.driver_payout_instruction`. This database permission boundary is the durable enforcement of the rule that a discrepancy never auto-corrects money state.

The worker must retain a redacted report summary and the source SHA-256 in its logs/metrics. It must never include report bytes, full callback payloads, authorization headers, payment instruments or raw webhook signatures. A deterministic test-only adapter fixture may be used in integration tests, but it must not be reachable as a production provider adapter.

## 7. Acceptance queries and tests required before implementation completion

The reconciliation runner should produce a classification count and exact signed-minor-unit totals, then test for outstanding exceptions. The following release-gate query is intentionally conservative.

```sql
WITH latest_review AS (
  SELECT DISTINCT ON (event.exception_id)
         event.exception_id, event.action, event.assigned_to, event.due_at, event.created_at
  FROM mobility.settlement_reconciliation_review_event event
  ORDER BY event.exception_id, event.created_at DESC
)
SELECT exception.exception_class, COUNT(*) AS open_or_unexplained_count
FROM mobility.settlement_reconciliation_exception exception
LEFT JOIN latest_review review ON review.exception_id = exception.id
WHERE exception.reconciliation_run_id = $1::uuid
  AND (
    exception.exception_class NOT IN ('expected_held_payout', 'expected_provider_pending')
    AND NOT (
      exception.exception_class = 'timing_difference'
      AND review.action = 'assigned'
      AND review.assigned_to IS NOT NULL
      AND review.due_at > now()
    )
    AND COALESCE(review.action::text, '') NOT IN ('resolved', 'waived')
  )
GROUP BY exception.exception_class
ORDER BY exception.exception_class;
```

An implementation test suite must exercise at least the following independent cases using PostgreSQL and a deterministic report fixture: fully matched collection; internal-only collection; provider-only collection; amount, fee, net and currency mismatch; duplicate provider reference; captured/settled internal payment without verification evidence; unbalanced capture/payout ledger; illegal reported settlement state; expected held payout; bounded timing difference; idempotent repeat import; invalid report digest/type/size; immutable-row mutation rejection; resolution without evidence rejection; and an assertion that reconciliation inserts no ledger transaction, ledger posting, provider-payment update or payout-instruction update.

## 8. Evidence-based conclusion

The source contains robust **gateway-provider simulator** fault automation and a distributed k6 ingress template that propagates `X-Resilience-Run-Id` through HTTP, metrics, Go logs and the durable payment queue. It does not yet contain Redis chaos automation, result archival adequate for a multi-pod evidence package, client-generated request-ID assertion, matching-side durable run-ID persistence, or a payment settlement-reconciliation implementation.

The DDL, query and ingestion design above provide a concrete path for the missing reconciliation workflow while preserving the core safety invariant: **a provider-report difference is evidence for investigation, never a trigger for autonomous financial mutation.** The components remain protected-staging work until the migration, adapter, internal route/worker, test suite and provider-sandbox evidence are implemented and observed.

## References

[1]: multipod_redis_recovery_and_payment_certification_playbook_20260904.md
[2]: ../scripts/testing/resilience/run-staging-chaos-validation.sh
[3]: ../scripts/testing/resilience/toxiproxy-payment-faults.sh
[4]: ../deploy/kubernetes/resilience-test/toxiproxy/toxiproxy.yaml
[5]: ../scripts/testing/resilience/run-k6-ride-payment-ingress.sh
[6]: ../deploy/kubernetes/resilience-test/k6/ride-payment-ingress-testrun.yaml
[7]: ../deploy/kubernetes/resilience-test/k6/ride_payment_ingress.js
[8]: ../services/go/ride-matching-worker/main.go
[9]: ../services/python/payment-webhook/main.py
[10]: ../services/python/payment-webhook/service.py
[11]: ../drizzle/0038_payment_webhook_verification_queue.sql
[12]: ../drizzle/0026_ride_hailing_dispatch.sql
[13]: ../drizzle/0037_financial_operations_extensions.sql
