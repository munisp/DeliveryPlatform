#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PG_BIN="/usr/lib/postgresql/16/bin"
ROW_COUNT="${ROW_COUNT:-5000}"
RUN_TOKEN="$(date -u +%Y%m%d%H%M%S)-$$"
TEST_DB="deliveryplatform_settlement_benchmark_${RUN_TOKEN//-/}"
INGESTOR_ROLE="settlement_reconciliation_ingestor"
REVIEWER_ROLE="settlement_reconciliation_reviewer"
created_ingestor_role=false
created_reviewer_role=false
fixture_dir=""
MIGRATIONS=(
  "$ROOT/drizzle/0000_jittery_pride.sql"
  "$ROOT/drizzle/0026_ride_hailing_dispatch.sql"
  "$ROOT/drizzle/0038_payment_webhook_verification_queue.sql"
  "$ROOT/drizzle/0039_payment_webhook_correlation.sql"
  "$ROOT/drizzle/0040_payment_settlement_reconciliation.sql"
)

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
    sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d postgres -c "DROP ROLE IF EXISTS ${INGESTOR_ROLE}" >/dev/null 2>&1
  fi
  if [[ "$created_reviewer_role" == true ]]; then
    sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d postgres -c "DROP ROLE IF EXISTS ${REVIEWER_ROLE}" >/dev/null 2>&1
  fi
  exit "$exit_code"
}
trap cleanup EXIT

if ! [[ "$ROW_COUNT" =~ ^[1-9][0-9]*$ ]] || (( ROW_COUNT > 50000 )); then
  printf 'ROW_COUNT must be an integer from 1 through 50000\n' >&2
  exit 1
fi
for required in psql createdb dropdb python3 sudo bc; do
  require_command "$required"
done
[[ -x "$PG_BIN/pg_isready" ]] || { printf 'PostgreSQL 16 server binaries are unavailable\n' >&2; exit 1; }
"$PG_BIN/pg_isready" -q || { printf 'local PostgreSQL server is unavailable\n' >&2; exit 1; }

for role in "$INGESTOR_ROLE" "$REVIEWER_ROLE"; do
  present="$(sudo -u postgres psql -Atq -d postgres -c "SELECT 1 FROM pg_roles WHERE rolname = '${role}'" || true)"
  if [[ -z "$present" ]]; then
    sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d postgres -c "CREATE ROLE ${role} NOLOGIN" >/dev/null
    if [[ "$role" == "$INGESTOR_ROLE" ]]; then
      created_ingestor_role=true
    else
      created_reviewer_role=true
    fi
  fi
done

sudo -u postgres createdb "$TEST_DB"
for migration in "${MIGRATIONS[@]}"; do
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d "$TEST_DB" -f - < "$migration" >/dev/null
done

fixture_dir="$(mktemp -d /tmp/deliveryplatform-settlement-benchmark.XXXXXX)"
merchant_account_id="$(sudo -u postgres psql -X -Atq -v ON_ERROR_STOP=1 -d "$TEST_DB" -c "INSERT INTO mobility.settlement_merchant_account (tenant_id, provider, merchant_reference, settlement_currency) VALUES ('benchmark-tenant', 'benchmarkpay', 'benchmark-merchant-0001', 'NGN') RETURNING id")"
report_id="benchmark-report-${RUN_TOKEN//-/}"
python3 "$ROOT/scripts/testing/generate-settlement-benchmark-fixture.py" \
  --artifact "$fixture_dir/provider-report.json" \
  --manifest "$fixture_dir/report-manifest.json" \
  --merchant-account-id "$merchant_account_id" \
  --row-count "$ROW_COUNT" \
  --report-id "$report_id"
install -m 0644 "$ROOT/services/python/payment-webhook/settlement_reconciliation.py" "$fixture_dir/settlement_reconciliation.py"
sudo chown -R postgres:postgres "$fixture_dir"

financial_before="$(sudo -u postgres psql -X -Atq -v ON_ERROR_STOP=1 -d "$TEST_DB" -c "SELECT (SELECT COUNT(*) FROM mobility.provider_payment), (SELECT COUNT(*) FROM mobility.driver_payout_instruction), (SELECT COUNT(*) FROM mobility.ledger_transaction), (SELECT COUNT(*) FROM mobility.ledger_posting)")"
started_ns="$(date +%s%N)"
sudo -u postgres env \
  "SETTLEMENT_RECONCILIATION_DATABASE_URL=postgresql:///${TEST_DB}?host=/var/run/postgresql" \
  "PGOPTIONS=-c role=settlement_reconciliation_ingestor" \
  python3 "$fixture_dir/settlement_reconciliation.py" \
    --resilience-run-id settlement-benchmark-001 \
    --summary-file "$fixture_dir/summary.json" \
    run --manifest "$fixture_dir/report-manifest.json" --artifact-file "$fixture_dir/provider-report.json"
completed_ns="$(date +%s%N)"
financial_after="$(sudo -u postgres psql -X -Atq -v ON_ERROR_STOP=1 -d "$TEST_DB" -c "SELECT (SELECT COUNT(*) FROM mobility.provider_payment), (SELECT COUNT(*) FROM mobility.driver_payout_instruction), (SELECT COUNT(*) FROM mobility.ledger_transaction), (SELECT COUNT(*) FROM mobility.ledger_posting)")"
[[ "$financial_before" == "$financial_after" ]] || { printf 'reconciliation changed a financial table: before=%s after=%s\n' "$financial_before" "$financial_after" >&2; exit 1; }

elapsed_ms="$(printf 'scale=3; (%s - %s) / 1000000\n' "$completed_ns" "$started_ns" | bc)"
rows_per_second="$(printf 'scale=2; (%s * 1000) / %s\n' "$ROW_COUNT" "${elapsed_ms%.*}" | bc)"
summary="$(sudo -u postgres cat "$fixture_dir/summary.json")"
exception_count="$(sudo -u postgres psql -X -Atq -v ON_ERROR_STOP=1 -d "$TEST_DB" -c "SELECT COUNT(*) FROM mobility.settlement_reconciliation_exception")"
class_counts="$(sudo -u postgres psql -X -Atq -v ON_ERROR_STOP=1 -d "$TEST_DB" -c "SELECT exception_class::text || ':' || COUNT(*) FROM mobility.settlement_reconciliation_exception GROUP BY exception_class ORDER BY exception_class")"

printf '%s\n' '=== Settlement reconciliation benchmark ==='
printf 'fixture_rows=%s\n' "$ROW_COUNT"
printf 'elapsed_ms=%s\n' "$elapsed_ms"
printf 'rows_per_second=%s\n' "$rows_per_second"
printf 'exception_count=%s\n' "$exception_count"
printf 'class_counts=%s\n' "${class_counts//$'\n'/,}"
printf 'runner_summary=%s\n' "$summary"
printf 'financial_table_counts_before_after=%s\n' "$financial_after"
artifact_bytes="$(sudo -u postgres sh -c 'wc -c < "$1"' sh "$fixture_dir/provider-report.json" | tr -d ' ')"
printf 'artifact_bytes=%s\n' "$artifact_bytes"
