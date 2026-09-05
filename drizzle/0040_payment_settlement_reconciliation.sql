-- Settlement report staging and reconciliation evidence.
-- This migration does not modify payment, ledger, or payout facts.

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
  CHECK (rejected_row_count <= row_count),
  CHECK (resilience_run_id IS NULL OR resilience_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$')
);
CREATE INDEX IF NOT EXISTS settlement_import_state_idx
  ON mobility.settlement_import (state, created_at);

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
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result_summary) = 'object'),
  failure_code text CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 3 AND 128),
  requested_by integer REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (import_id, classifier_version),
  CHECK ((completed_at IS NOT NULL) = (result_digest IS NOT NULL))
);

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
  detected_facts jsonb NOT NULL CHECK (jsonb_typeof(detected_facts) = 'object'),
  detected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reconciliation_run_id, exception_fingerprint)
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
  CHECK (action NOT IN ('evidence_attached', 'escalated_to_provider', 'resolved', 'waived') OR evidence_ref IS NOT NULL)
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
    RAISE EXCEPTION 'settlement exception requires evidence before resolution or waiver'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS provider_payment_settlement_scope_append_only ON mobility.provider_payment_settlement_scope;
CREATE TRIGGER provider_payment_settlement_scope_append_only
  BEFORE UPDATE OR DELETE ON mobility.provider_payment_settlement_scope
  FOR EACH ROW EXECUTE FUNCTION mobility.reject_immutable_settlement_fact_mutation();

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

REVOKE UPDATE, DELETE ON mobility.provider_payment_settlement_scope,
  mobility.settlement_report_source,
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
      mobility.settlement_report_row, mobility.settlement_reconciliation_exception TO settlement_reconciliation_ingestor;
    GRANT INSERT, SELECT, UPDATE ON mobility.settlement_import,
      mobility.settlement_reconciliation_run TO settlement_reconciliation_ingestor;
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
