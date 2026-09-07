#!/usr/bin/env bash
set -euo pipefail

DATABASE_URL="${SETTLEMENT_VALIDATION_DATABASE_URL:?SETTLEMENT_VALIDATION_DATABASE_URL must be a PostgreSQL staging database URL}"

case "$DATABASE_URL" in
  postgresql://*|postgres://*) ;;
  *)
    printf '%s\n' 'SETTLEMENT_VALIDATION_DATABASE_URL must use a PostgreSQL URL' >&2
    exit 1
    ;;
esac

command -v psql >/dev/null 2>&1 || {
  printf '%s\n' 'missing required command: psql' >&2
  exit 1
}

printf '%s\n' 'Running read-only settlement reconciliation staging validation.'
printf '%s\n' 'No payment, payout, ledger, reconciliation, or review records are created, updated, or deleted.'

PGAPPNAME="deliveryplatform-settlement-schema-validation" \
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -P pager=off <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  required_table text;
  required_trigger record;
  required_index_fragment text;
BEGIN
  FOREACH required_table IN ARRAY ARRAY[
    'mobility.settlement_merchant_account',
    'mobility.provider_payment_settlement_scope',
    'mobility.settlement_report_source',
    'mobility.settlement_import',
    'mobility.settlement_report_row',
    'mobility.settlement_reconciliation_run',
    'mobility.settlement_reconciliation_exception',
    'mobility.settlement_reconciliation_review_event',
    'mobility.provider_payment',
    'mobility.driver_payout_instruction',
    'mobility.trip_settlement',
    'mobility.provider_webhook_event',
    'mobility.ledger_transaction',
    'mobility.ledger_posting',
    'mobility.ledger_account'
  ] LOOP
    IF to_regclass(required_table) IS NULL THEN
      RAISE EXCEPTION 'required settlement dependency is absent: %', required_table;
    END IF;
  END LOOP;

  IF to_regtype('mobility.settlement_import_state') IS NULL
     OR to_regtype('mobility.settlement_entry_kind') IS NULL
     OR to_regtype('mobility.settlement_provider_state') IS NULL
     OR to_regtype('mobility.settlement_exception_class') IS NULL
     OR to_regtype('mobility.settlement_review_action') IS NULL THEN
    RAISE EXCEPTION 'one or more settlement reconciliation enum types are absent';
  END IF;

  FOR required_trigger IN
    SELECT *
    FROM (VALUES
      ('provider_payment_settlement_scope_append_only', 'mobility.provider_payment_settlement_scope'::regclass, 'mobility.reject_immutable_settlement_fact_mutation()'::regprocedure),
      ('settlement_source_append_only', 'mobility.settlement_report_source'::regclass, 'mobility.reject_immutable_settlement_fact_mutation()'::regprocedure),
      ('settlement_row_append_only', 'mobility.settlement_report_row'::regclass, 'mobility.reject_immutable_settlement_fact_mutation()'::regprocedure),
      ('settlement_exception_append_only', 'mobility.settlement_reconciliation_exception'::regclass, 'mobility.reject_immutable_settlement_fact_mutation()'::regprocedure),
      ('settlement_review_append_only', 'mobility.settlement_reconciliation_review_event'::regclass, 'mobility.reject_immutable_settlement_fact_mutation()'::regprocedure),
      ('settlement_review_evidence_required', 'mobility.settlement_reconciliation_review_event'::regclass, 'mobility.require_settlement_resolution_evidence()'::regprocedure)
    ) AS expected(trigger_name, table_oid, function_oid)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_trigger trigger
      WHERE trigger.tgname = required_trigger.trigger_name
        AND trigger.tgrelid = required_trigger.table_oid
        AND trigger.tgfoid = required_trigger.function_oid
        AND trigger.tgenabled <> 'D'
    ) THEN
      RAISE EXCEPTION 'required enabled trigger is absent or bound to the wrong function: %', required_trigger.trigger_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid = 'mobility.settlement_report_row'::regclass
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%net_minor = (gross_minor - fee_minor)%'
  ) THEN
    RAISE EXCEPTION 'settlement report row net-minor equation check is absent';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid = 'mobility.settlement_import'::regclass
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%resilience_run_id%'
  ) THEN
    RAISE EXCEPTION 'settlement import resilience-run identifier check is absent';
  END IF;

  FOREACH required_index_fragment IN ARRAY ARRAY[
    'UNIQUE (import_key)',
    'UNIQUE (source_id, normalizer_version)',
    'UNIQUE (import_id, source_line_no)',
    'UNIQUE (import_id, source_record_key)',
    'UNIQUE (reconciliation_run_id, exception_fingerprint)'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint con
      WHERE con.contype IN ('u', 'p')
        AND pg_get_constraintdef(con.oid) LIKE '%' || required_index_fragment || '%'
    ) THEN
      RAISE EXCEPTION 'required reconciliation uniqueness constraint is absent: %', required_index_fragment;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'settlement_reconciliation_ingestor')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'settlement_reconciliation_reviewer') THEN
    RAISE EXCEPTION 'required reconciliation database roles are absent';
  END IF;

  IF NOT has_schema_privilege('settlement_reconciliation_ingestor', 'mobility', 'USAGE')
     OR NOT has_schema_privilege('settlement_reconciliation_reviewer', 'mobility', 'USAGE') THEN
    RAISE EXCEPTION 'reconciliation role schema usage is missing';
  END IF;

  IF NOT has_table_privilege('settlement_reconciliation_ingestor', 'mobility.provider_payment', 'SELECT')
     OR NOT has_table_privilege('settlement_reconciliation_ingestor', 'mobility.driver_payout_instruction', 'SELECT')
     OR NOT has_table_privilege('settlement_reconciliation_ingestor', 'mobility.ledger_transaction', 'SELECT')
     OR NOT has_table_privilege('settlement_reconciliation_ingestor', 'mobility.ledger_posting', 'SELECT') THEN
    RAISE EXCEPTION 'ingestor lacks required read-only financial visibility';
  END IF;

  IF has_table_privilege('settlement_reconciliation_ingestor', 'mobility.provider_payment', 'INSERT, UPDATE, DELETE')
     OR has_table_privilege('settlement_reconciliation_ingestor', 'mobility.driver_payout_instruction', 'INSERT, UPDATE, DELETE')
     OR has_table_privilege('settlement_reconciliation_ingestor', 'mobility.ledger_transaction', 'INSERT, UPDATE, DELETE')
     OR has_table_privilege('settlement_reconciliation_ingestor', 'mobility.ledger_posting', 'INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'ingestor has forbidden financial write privilege';
  END IF;

  IF NOT has_table_privilege('settlement_reconciliation_ingestor', 'mobility.settlement_report_source', 'SELECT, INSERT')
     OR NOT has_table_privilege('settlement_reconciliation_ingestor', 'mobility.settlement_report_row', 'SELECT, INSERT')
     OR NOT has_table_privilege('settlement_reconciliation_ingestor', 'mobility.settlement_reconciliation_exception', 'SELECT, INSERT')
     OR NOT has_table_privilege('settlement_reconciliation_ingestor', 'mobility.settlement_import', 'SELECT, INSERT, UPDATE')
     OR NOT has_table_privilege('settlement_reconciliation_ingestor', 'mobility.settlement_reconciliation_run', 'SELECT, INSERT, UPDATE') THEN
    RAISE EXCEPTION 'ingestor lacks required reconciliation-table privileges';
  END IF;

  IF has_table_privilege('settlement_reconciliation_ingestor', 'mobility.settlement_report_source', 'UPDATE, DELETE')
     OR has_table_privilege('settlement_reconciliation_ingestor', 'mobility.settlement_report_row', 'UPDATE, DELETE')
     OR has_table_privilege('settlement_reconciliation_ingestor', 'mobility.settlement_reconciliation_exception', 'UPDATE, DELETE')
     OR has_table_privilege('settlement_reconciliation_ingestor', 'mobility.settlement_import', 'DELETE')
     OR has_table_privilege('settlement_reconciliation_ingestor', 'mobility.settlement_reconciliation_run', 'DELETE') THEN
    RAISE EXCEPTION 'ingestor has forbidden reconciliation evidence mutation privilege';
  END IF;

  IF has_table_privilege('settlement_reconciliation_reviewer', 'mobility.provider_payment', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'reviewer has forbidden provider-payment access';
  END IF;

  IF NOT has_table_privilege('settlement_reconciliation_reviewer', 'mobility.settlement_reconciliation_exception', 'SELECT')
     OR NOT has_table_privilege('settlement_reconciliation_reviewer', 'mobility.settlement_reconciliation_review_event', 'SELECT, INSERT') THEN
    RAISE EXCEPTION 'reviewer lacks required evidence read or append privilege';
  END IF;

  IF has_table_privilege('settlement_reconciliation_reviewer', 'mobility.settlement_reconciliation_exception', 'INSERT, UPDATE, DELETE')
     OR has_table_privilege('settlement_reconciliation_reviewer', 'mobility.settlement_reconciliation_review_event', 'UPDATE, DELETE') THEN
    RAISE EXCEPTION 'reviewer has forbidden evidence mutation privilege';
  END IF;
END;
$$;

\echo '=== Required reconciliation tables ==='
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'mobility'
  AND table_name IN (
    'settlement_merchant_account',
    'provider_payment_settlement_scope',
    'settlement_report_source',
    'settlement_import',
    'settlement_report_row',
    'settlement_reconciliation_run',
    'settlement_reconciliation_exception',
    'settlement_reconciliation_review_event'
  )
ORDER BY table_name;

\echo '=== Enabled immutability and evidence triggers ==='
SELECT trigger.tgname AS trigger_name,
       trigger.tgrelid::regclass AS table_name,
       pg_get_triggerdef(trigger.oid) AS definition
FROM pg_trigger trigger
WHERE trigger.tgname IN (
  'provider_payment_settlement_scope_append_only',
  'settlement_source_append_only',
  'settlement_row_append_only',
  'settlement_exception_append_only',
  'settlement_review_append_only',
  'settlement_review_evidence_required'
)
  AND trigger.tgenabled <> 'D'
ORDER BY table_name, trigger_name;

\echo '=== Effective reconciliation role privileges ==='
WITH expected(role_name, table_name) AS (
  VALUES
    ('settlement_reconciliation_ingestor', 'mobility.provider_payment'),
    ('settlement_reconciliation_ingestor', 'mobility.driver_payout_instruction'),
    ('settlement_reconciliation_ingestor', 'mobility.ledger_transaction'),
    ('settlement_reconciliation_ingestor', 'mobility.ledger_posting'),
    ('settlement_reconciliation_ingestor', 'mobility.settlement_report_source'),
    ('settlement_reconciliation_ingestor', 'mobility.settlement_report_row'),
    ('settlement_reconciliation_ingestor', 'mobility.settlement_import'),
    ('settlement_reconciliation_ingestor', 'mobility.settlement_reconciliation_run'),
    ('settlement_reconciliation_ingestor', 'mobility.settlement_reconciliation_exception'),
    ('settlement_reconciliation_reviewer', 'mobility.provider_payment'),
    ('settlement_reconciliation_reviewer', 'mobility.settlement_reconciliation_exception'),
    ('settlement_reconciliation_reviewer', 'mobility.settlement_reconciliation_review_event')
)
SELECT role_name,
       table_name,
       has_table_privilege(role_name, table_name, 'SELECT') AS can_select,
       has_table_privilege(role_name, table_name, 'INSERT') AS can_insert,
       has_table_privilege(role_name, table_name, 'UPDATE') AS can_update,
       has_table_privilege(role_name, table_name, 'DELETE') AS can_delete
FROM expected
ORDER BY role_name, table_name;

COMMIT;
SQL

printf '%s\n' 'Settlement reconciliation staging validation passed.'
