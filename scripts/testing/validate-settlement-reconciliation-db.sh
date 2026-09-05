#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PG_BIN="/usr/lib/postgresql/16/bin"
MIGRATIONS=(
  "$ROOT/drizzle/0000_jittery_pride.sql"
  "$ROOT/drizzle/0026_ride_hailing_dispatch.sql"
  "$ROOT/drizzle/0038_payment_webhook_verification_queue.sql"
  "$ROOT/drizzle/0039_payment_webhook_correlation.sql"
  "$ROOT/drizzle/0040_payment_settlement_reconciliation.sql"
)
RUN_TOKEN="$(date -u +%Y%m%d%H%M%S)-$$"
TEST_DB="deliveryplatform_settlement_validation_${RUN_TOKEN//-/}"
INGESTOR_ROLE="settlement_reconciliation_ingestor"
REVIEWER_ROLE="settlement_reconciliation_reviewer"
created_ingestor_role=false
created_reviewer_role=false
fixture_dir=""

require_command() {
  command -v "$1" >/dev/null 2>&1 || { printf 'missing required command: %s\n' "$1" >&2; exit 1; }
}

cleanup() {
  local exit_code=$?
  set +e
  sudo -u postgres dropdb --if-exists "$TEST_DB" >/dev/null 2>&1
  if [[ -n "$fixture_dir" ]]; then
    sudo rm -rf "$fixture_dir"
  fi
  if [[ "$created_ingestor_role" == true ]]; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres -c "DROP ROLE IF EXISTS ${INGESTOR_ROLE}" >/dev/null 2>&1
  fi
  if [[ "$created_reviewer_role" == true ]]; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres -c "DROP ROLE IF EXISTS ${REVIEWER_ROLE}" >/dev/null 2>&1
  fi
  exit "$exit_code"
}
trap cleanup EXIT

require_command psql
require_command createdb
require_command dropdb
require_command python3
require_command sudo
[[ -x "$PG_BIN/pg_isready" ]] || { printf 'PostgreSQL 16 server binaries are unavailable\n' >&2; exit 1; }
"$PG_BIN/pg_isready" -q || { printf 'local PostgreSQL server is unavailable\n' >&2; exit 1; }

for role in "$INGESTOR_ROLE" "$REVIEWER_ROLE"; do
  present="$(sudo -u postgres psql -X -At -v ON_ERROR_STOP=1 -d postgres -c "SELECT 1 FROM pg_roles WHERE rolname = '${role}'" || true)"
  if [[ -z "$present" ]]; then
    sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d postgres -c "CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT" >/dev/null
    if [[ "$role" == "$INGESTOR_ROLE" ]]; then
      created_ingestor_role=true
    else
      created_reviewer_role=true
    fi
  else
    unsafe_attributes="$(sudo -u postgres psql -X -At -v ON_ERROR_STOP=1 -d postgres -c "SELECT COUNT(*) FROM pg_roles WHERE rolname = '${role}' AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)")"
    [[ "$unsafe_attributes" == "0" ]] || { printf 'existing settlement role has unsafe attributes: %s\n' "$role" >&2; exit 1; }
    role_memberships="$(sudo -u postgres psql -X -At -v ON_ERROR_STOP=1 -d postgres -c "SELECT COUNT(*) FROM pg_auth_members AS membership JOIN pg_roles AS member_role ON member_role.oid = membership.member JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid WHERE member_role.rolname = '${role}' OR granted_role.rolname = '${role}'")"
    [[ "$role_memberships" == "0" ]] || { printf 'existing settlement role has unexpected membership: %s\n' "$role" >&2; exit 1; }
  fi
done

sudo -u postgres createdb "$TEST_DB"
for migration in "${MIGRATIONS[@]}"; do
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d "$TEST_DB" -f - < "$migration" >/dev/null
done

printf '%s\n' '=== Settlement migration structural verification ==='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d "$TEST_DB" -P pager=off -c "
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'mobility'
  AND table_name IN (
    'settlement_merchant_account', 'provider_payment_settlement_scope',
    'settlement_report_source', 'settlement_import', 'settlement_report_row',
    'settlement_reconciliation_run', 'settlement_reconciliation_exception',
    'settlement_reconciliation_review_event'
  )
ORDER BY table_name;
"

printf '%s\n' '=== Settlement trigger verification ==='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d "$TEST_DB" -P pager=off -c "
SELECT trigger_name, event_manipulation, event_object_table
FROM information_schema.triggers
WHERE trigger_schema = 'mobility'
  AND trigger_name IN (
    'provider_payment_settlement_scope_append_only', 'settlement_source_append_only',
    'settlement_row_append_only', 'settlement_exception_append_only',
    'settlement_review_append_only', 'settlement_review_evidence_required'
  )
ORDER BY event_object_table, trigger_name;
"

printf '%s\n' '=== Least-privilege verification ==='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d "$TEST_DB" -P pager=off -c "
SELECT role_name, table_name, can_select, can_insert, can_update, can_delete
FROM (
  VALUES
    ('settlement_reconciliation_ingestor', 'mobility.provider_payment'),
    ('settlement_reconciliation_ingestor', 'mobility.ledger_transaction'),
    ('settlement_reconciliation_ingestor', 'mobility.ledger_posting'),
    ('settlement_reconciliation_ingestor', 'mobility.driver_payout_instruction'),
    ('settlement_reconciliation_ingestor', 'mobility.settlement_import'),
    ('settlement_reconciliation_ingestor', 'mobility.settlement_reconciliation_run'),
    ('settlement_reconciliation_ingestor', 'mobility.settlement_reconciliation_exception'),
    ('settlement_reconciliation_reviewer', 'mobility.provider_payment'),
    ('settlement_reconciliation_reviewer', 'mobility.settlement_reconciliation_exception'),
    ('settlement_reconciliation_reviewer', 'mobility.settlement_reconciliation_review_event')
) AS required(role_name, table_name)
CROSS JOIN LATERAL (
  SELECT
    has_table_privilege(required.role_name, required.table_name, 'SELECT') AS can_select,
    has_table_privilege(required.role_name, required.table_name, 'INSERT') AS can_insert,
    has_table_privilege(required.role_name, required.table_name, 'UPDATE') AS can_update,
    has_table_privilege(required.role_name, required.table_name, 'DELETE') AS can_delete
) AS privileges
ORDER BY role_name, table_name;
"

printf '%s\n' '=== Runner database integration and financial immutability ==='
fixture_dir="$(mktemp -d /tmp/deliveryplatform-settlement-validation.XXXXXX)"
install -m 0644 "$ROOT/services/python/payment-webhook/settlement_reconciliation.py" "$fixture_dir/settlement_reconciliation.py"
printf '%s' '{"report":"test-settlement-cycle-0001"}' > "$fixture_dir/provider-report.json"
source_bytes="$(wc -c < "$fixture_dir/provider-report.json" | tr -d ' ')"
source_sha256="$(sha256sum "$fixture_dir/provider-report.json" | awk '{print $1}')"
merchant_account_id="$(sudo -u postgres psql -X -Atq -v ON_ERROR_STOP=1 -d "$TEST_DB" -c "INSERT INTO mobility.settlement_merchant_account (tenant_id, provider, merchant_reference, settlement_currency) VALUES ('test-tenant', 'testpay', 'test-merchant-0001', 'NGN') RETURNING id")"
cat > "$fixture_dir/report-manifest.json" <<EOF
{
  "merchant_account_id": "${merchant_account_id}",
  "provider_report_id": "test-report-0001",
  "report_kind": "settlement_cycle",
  "period_start": "2026-09-04T00:00:00Z",
  "period_end": "2026-09-05T00:00:00Z",
  "retrieved_at": "2026-09-05T01:00:00Z",
  "source_object_ref": "restricted/settlement/test-report-0001.json",
  "source_content_type": "application/json",
  "source_bytes": ${source_bytes},
  "source_sha256": "${source_sha256}",
  "retrieval_actor": "settlement-validation",
  "rows": [{
    "source_line_no": 1,
    "source_record_key": "test-line-0001",
    "entry_kind": "collection",
    "provider_reference": "test-provider-reference-0001",
    "provider_final_state": "settled",
    "provider_final_status": "success",
    "currency": "NGN",
    "gross_minor": 120000,
    "fee_minor": 5000,
    "net_minor": 115000,
    "occurred_at": "2026-09-04T00:30:00Z",
    "settled_at": "2026-09-04T01:00:00Z",
    "normalized_metadata": {"cycle": "test-cycle-0001"}
  }]
}
EOF
sudo chown -R postgres:postgres "$fixture_dir"
sudo install -o postgres -g postgres -m 0644 "$ROOT/scripts/testing/generate-settlement-benchmark-fixture.py" "$fixture_dir/generate-settlement-benchmark-fixture.py"
financial_before="$(sudo -u postgres psql -X -At -v ON_ERROR_STOP=1 -d "$TEST_DB" -c "SELECT (SELECT COUNT(*) FROM mobility.provider_payment), (SELECT COUNT(*) FROM mobility.driver_payout_instruction), (SELECT COUNT(*) FROM mobility.ledger_transaction), (SELECT COUNT(*) FROM mobility.ledger_posting)")"
sudo -u postgres env \
  "SETTLEMENT_RECONCILIATION_DATABASE_URL=postgresql:///${TEST_DB}?host=/var/run/postgresql" \
  "PGOPTIONS=-c role=settlement_reconciliation_ingestor" \
  python3 "$fixture_dir/settlement_reconciliation.py" \
    --resilience-run-id settlement-test-run-001 \
    --summary-file "$fixture_dir/summary.json" \
    run --manifest "$fixture_dir/report-manifest.json" --artifact-file "$fixture_dir/provider-report.json"
financial_after="$(sudo -u postgres psql -X -At -v ON_ERROR_STOP=1 -d "$TEST_DB" -c "SELECT (SELECT COUNT(*) FROM mobility.provider_payment), (SELECT COUNT(*) FROM mobility.driver_payout_instruction), (SELECT COUNT(*) FROM mobility.ledger_transaction), (SELECT COUNT(*) FROM mobility.ledger_posting)")"
[[ "$financial_before" == "$financial_after" ]] || { printf 'reconciliation changed a financial table: before=%s after=%s\\n' "$financial_before" "$financial_after" >&2; exit 1; }
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d "$TEST_DB" -P pager=off -c "SELECT exception_class, severity, provider_reference FROM mobility.settlement_reconciliation_exception"

printf '%s\n' '=== Reconciliation rollback verification ==='
failure_report_id="failure-report-${RUN_TOKEN//-/}"
sudo -u postgres python3 "$fixture_dir/generate-settlement-benchmark-fixture.py" \
  --artifact "$fixture_dir/failure-provider-report.json" \
  --manifest "$fixture_dir/failure-report-manifest.json" \
  --merchant-account-id "$merchant_account_id" \
  --row-count 2 \
  --report-id "$failure_report_id"
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d "$TEST_DB" <<'SQL' >/dev/null
CREATE OR REPLACE FUNCTION mobility.test_abort_second_settlement_exception()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM mobility.settlement_reconciliation_exception existing
    WHERE existing.reconciliation_run_id = NEW.reconciliation_run_id
  ) THEN
    RAISE EXCEPTION 'test-only induced reconciliation exception failure' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER test_abort_second_settlement_exception
BEFORE INSERT ON mobility.settlement_reconciliation_exception
FOR EACH ROW EXECUTE FUNCTION mobility.test_abort_second_settlement_exception();
SQL
set +e
sudo -u postgres env \
  "SETTLEMENT_RECONCILIATION_DATABASE_URL=postgresql:///${TEST_DB}?host=/var/run/postgresql" \
  "PGOPTIONS=-c role=settlement_reconciliation_ingestor" \
  python3 "$fixture_dir/settlement_reconciliation.py" \
    --resilience-run-id settlement-rollback-test-001 \
    run --manifest "$fixture_dir/failure-report-manifest.json" --artifact-file "$fixture_dir/failure-provider-report.json"
rollback_status=$?
set -e
[[ "$rollback_status" -ne 0 ]] || { printf 'induced reconciliation error unexpectedly succeeded\n' >&2; exit 1; }
rollback_result="$(sudo -u postgres psql -X -Atq -v ON_ERROR_STOP=1 -d "$TEST_DB" -c "
  SELECT si.state::text || '|' ||
         (SELECT COUNT(*) FROM mobility.settlement_reconciliation_run run WHERE run.import_id = si.id) || '|' ||
         (SELECT COUNT(*) FROM mobility.settlement_reconciliation_exception exception
          JOIN mobility.settlement_reconciliation_run run ON run.id = exception.reconciliation_run_id
          WHERE run.import_id = si.id) || '|' ||
         (SELECT COUNT(*) FROM mobility.settlement_report_row row WHERE row.import_id = si.id)
  FROM mobility.settlement_import si
  JOIN mobility.settlement_report_source source ON source.id = si.source_id
  WHERE source.provider_report_id = '${failure_report_id}'")"
[[ "$rollback_result" == "failed|0|0|2" ]] || { printf 'rollback verification failed: %s\n' "$rollback_result" >&2; exit 1; }
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d "$TEST_DB" <<'SQL' >/dev/null
DROP TRIGGER test_abort_second_settlement_exception ON mobility.settlement_reconciliation_exception;
DROP FUNCTION mobility.test_abort_second_settlement_exception();
SQL

printf '%s\n' '=== Concurrent reconciliation isolation verification ==='
concurrent_report_id="concurrent-report-${RUN_TOKEN//-/}"
sudo -u postgres python3 "$fixture_dir/generate-settlement-benchmark-fixture.py" \
  --artifact "$fixture_dir/concurrent-provider-report.json" \
  --manifest "$fixture_dir/concurrent-report-manifest.json" \
  --merchant-account-id "$merchant_account_id" \
  --row-count 2 \
  --report-id "$concurrent_report_id"
sudo -u postgres env \
  "SETTLEMENT_RECONCILIATION_DATABASE_URL=postgresql:///${TEST_DB}?host=/var/run/postgresql" \
  "PGOPTIONS=-c role=settlement_reconciliation_ingestor" \
  python3 "$fixture_dir/settlement_reconciliation.py" \
    --resilience-run-id settlement-concurrent-test-001 \
    --summary-file "$fixture_dir/concurrent-first-summary.json" \
    run --manifest "$fixture_dir/concurrent-report-manifest.json" --artifact-file "$fixture_dir/concurrent-provider-report.json" &
first_runner_pid=$!
sudo -u postgres env \
  "SETTLEMENT_RECONCILIATION_DATABASE_URL=postgresql:///${TEST_DB}?host=/var/run/postgresql" \
  "PGOPTIONS=-c role=settlement_reconciliation_ingestor" \
  python3 "$fixture_dir/settlement_reconciliation.py" \
    --resilience-run-id settlement-concurrent-test-001 \
    --summary-file "$fixture_dir/concurrent-second-summary.json" \
    run --manifest "$fixture_dir/concurrent-report-manifest.json" --artifact-file "$fixture_dir/concurrent-provider-report.json" &
second_runner_pid=$!
wait "$first_runner_pid"
wait "$second_runner_pid"
concurrent_result="$(sudo -u postgres psql -X -Atq -v ON_ERROR_STOP=1 -d "$TEST_DB" -c "
  SELECT (SELECT COUNT(*) FROM mobility.settlement_reconciliation_run run
          JOIN mobility.settlement_import import ON import.id = run.import_id
          JOIN mobility.settlement_report_source source ON source.id = import.source_id
          WHERE source.provider_report_id = '${concurrent_report_id}') || '|' ||
         (SELECT COUNT(*) FROM mobility.settlement_reconciliation_exception exception
          JOIN mobility.settlement_reconciliation_run run ON run.id = exception.reconciliation_run_id
          JOIN mobility.settlement_import import ON import.id = run.import_id
          JOIN mobility.settlement_report_source source ON source.id = import.source_id
          WHERE source.provider_report_id = '${concurrent_report_id}') || '|' ||
         (SELECT state::text FROM mobility.settlement_import import
          JOIN mobility.settlement_report_source source ON source.id = import.source_id
          WHERE source.provider_report_id = '${concurrent_report_id}')")"
[[ "$concurrent_result" == "1|2|reconciled" ]] || { printf 'concurrent-run isolation verification failed: %s\n' "$concurrent_result" >&2; exit 1; }

printf '%s\n' '=== Settlement reconciliation unit tests ==='
python3 -m unittest -v "$ROOT/services/python/payment-webhook/test_settlement_reconciliation.py"

printf 'disposable PostgreSQL settlement validation passed database=%s\n' "$TEST_DB"
