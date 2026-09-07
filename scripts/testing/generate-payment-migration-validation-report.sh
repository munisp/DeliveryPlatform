#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS=(
  "$ROOT/drizzle/0026_ride_hailing_dispatch.sql"
  "$ROOT/drizzle/0027_h3_dispatch_spatial_index.sql"
  "$ROOT/drizzle/0038_payment_webhook_verification_queue.sql"
  "$ROOT/drizzle/0039_payment_webhook_correlation.sql"
  "$ROOT/drizzle/0040_payment_settlement_reconciliation.sql"
)
DATABASE_URL="${MIGRATION_VALIDATION_DATABASE_URL:-}"

for migration in "${MIGRATIONS[@]}"; do
  [[ -f "$migration" ]] || {
    printf 'required migration is absent: %s\n' "$migration" >&2
    exit 1
  }
done

if [[ -n "$DATABASE_URL" ]]; then
  case "$DATABASE_URL" in
    postgresql://*|postgres://*) ;;
    *)
      printf '%s\n' 'MIGRATION_VALIDATION_DATABASE_URL must use a PostgreSQL URL' >&2
      exit 1
      ;;
  esac
  command -v psql >/dev/null 2>&1 || {
    printf '%s\n' 'psql is required when MIGRATION_VALIDATION_DATABASE_URL is set' >&2
    exit 1
  }
fi

printf '%s\n' '# Payment and Settlement Migration Validation Report'
printf '\n**Scope:** `0026` through `0040`, including the ordered migration dependency chain used by ride matching, payment verification, correlation, and settlement reconciliation.\n'
printf '\n**Generation mode:** '
if [[ -n "$DATABASE_URL" ]]; then
  printf '%s\n' 'migration source plus live PostgreSQL catalog.'
else
  printf '%s\n' 'migration source only; set `MIGRATION_VALIDATION_DATABASE_URL` for live catalog evidence.'
fi

printf '\n## Ordered Migration Inventory\n\n'
printf '| Migration | Tables | Enum Types | Functions | Triggers | Grants/Revoke Statements |\n'
printf '|---|---:|---:|---:|---:|---:|\n'
for migration in "${MIGRATIONS[@]}"; do
  filename="$(basename "$migration")"
  tables="$(grep -Ec '^CREATE TABLE' "$migration" || true)"
  types="$(grep -Ec '^CREATE TYPE' "$migration" || true)"
  functions="$(grep -Ec '^CREATE( OR REPLACE)? FUNCTION' "$migration" || true)"
  triggers="$(grep -Ec '^CREATE TRIGGER' "$migration" || true)"
  grants="$(grep -Ec '^(GRANT|REVOKE) ' "$migration" || true)"
  printf '| `%s` | %s | %s | %s | %s | %s |\n' "$filename" "$tables" "$types" "$functions" "$triggers" "$grants"
done

printf '\n## Source-Defined Tables and Constraints\n\n'
for migration in "${MIGRATIONS[@]}"; do
  filename="$(basename "$migration")"
  printf '### `%s`\n\n' "$filename"
  printf '#### Tables\n\n'
  if grep -q '^CREATE TABLE' "$migration"; then
    printf '```text\n'
    grep '^CREATE TABLE' "$migration" | sed -E 's/^CREATE TABLE( IF NOT EXISTS)? //; s/ \($//'
    printf '```\n\n'
  else
    printf 'No tables are created by this migration.\n\n'
  fi

  printf '#### Constraint Expressions\n\n'
  if grep -qE 'CONSTRAINT | CHECK \(| UNIQUE \(| REFERENCES ' "$migration"; then
    printf '```sql\n'
    grep -E 'CONSTRAINT | CHECK \(| UNIQUE \(| REFERENCES ' "$migration"
    printf '```\n\n'
  else
    printf 'No inline constraints are defined by this migration.\n\n'
  fi
done

printf '## Settlement Trigger Functions and Append-Only Controls\n\n'
printf '| Trigger | Table | Required function | Event boundary |\n'
printf '|---|---|---|---|\n'
printf '| `provider_payment_settlement_scope_append_only` | `mobility.provider_payment_settlement_scope` | `mobility.reject_immutable_settlement_fact_mutation()` | `BEFORE UPDATE OR DELETE` |\n'
printf '| `settlement_source_append_only` | `mobility.settlement_report_source` | `mobility.reject_immutable_settlement_fact_mutation()` | `BEFORE UPDATE OR DELETE` |\n'
printf '| `settlement_row_append_only` | `mobility.settlement_report_row` | `mobility.reject_immutable_settlement_fact_mutation()` | `BEFORE UPDATE OR DELETE` |\n'
printf '| `settlement_exception_append_only` | `mobility.settlement_reconciliation_exception` | `mobility.reject_immutable_settlement_fact_mutation()` | `BEFORE UPDATE OR DELETE` |\n'
printf '| `settlement_review_append_only` | `mobility.settlement_reconciliation_review_event` | `mobility.reject_immutable_settlement_fact_mutation()` | `BEFORE UPDATE OR DELETE` |\n'
printf '| `settlement_review_evidence_required` | `mobility.settlement_reconciliation_review_event` | `mobility.require_settlement_resolution_evidence()` | `BEFORE INSERT` |\n'

printf '\nThe immutable-fact function rejects update and delete attempts. The reviewer-event function requires direct immutable evidence references for evidence/escalation/resolution actions and requires an earlier evidence or provider-escalation event before `resolved` or `waived` is accepted.\n'

printf '\n## Least-Privilege Role Model\n\n'
printf '| Role | Permitted operations | Explicitly prohibited operations |\n'
printf '|---|---|---|\n'
printf '| `settlement_reconciliation_ingestor` | Read payment/payout/ledger facts; insert/read immutable reconciliation source, rows, and exceptions; insert/read/update import and reconciliation-run lifecycle records. | Insert, update, or delete payment, payout, ledger, source-row, normalized-row, and exception facts; delete import/run records. |\n'
printf '| `settlement_reconciliation_reviewer` | Read reconciliation evidence; append reviewer events. | Read or mutate provider-payment facts; insert/update/delete exceptions; update/delete review events; mutate financial facts. |\n'

printf '\n### Grant and Revoke Statements in `0040`\n\n```sql\n'
grep -E '^(GRANT|REVOKE) ' "$ROOT/drizzle/0040_payment_settlement_reconciliation.sql"
printf '```\n'

if [[ -n "$DATABASE_URL" ]]; then
  printf '\n## Live PostgreSQL Catalog Evidence\n\n'
  PGAPPNAME="deliveryplatform-migration-validation-report" \
    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -P pager=off <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';

\pset format aligned
\echo '### Live constraints'
SELECT con.conrelid::regclass AS table_name,
       con.conname AS constraint_name,
       pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
WHERE con.connamespace = 'mobility'::regnamespace
  AND con.conrelid IN (
    'mobility.settlement_merchant_account'::regclass,
    'mobility.provider_payment_settlement_scope'::regclass,
    'mobility.settlement_report_source'::regclass,
    'mobility.settlement_import'::regclass,
    'mobility.settlement_report_row'::regclass,
    'mobility.settlement_reconciliation_run'::regclass,
    'mobility.settlement_reconciliation_exception'::regclass,
    'mobility.settlement_reconciliation_review_event'::regclass
  )
ORDER BY table_name, constraint_name;

\echo '### Live trigger bindings'
SELECT trigger.tgname AS trigger_name,
       trigger.tgrelid::regclass AS table_name,
       trigger.tgenabled AS enabled_state,
       trigger.tgfoid::regprocedure AS function_name
FROM pg_trigger trigger
WHERE trigger.tgname IN (
  'provider_payment_settlement_scope_append_only',
  'settlement_source_append_only',
  'settlement_row_append_only',
  'settlement_exception_append_only',
  'settlement_review_append_only',
  'settlement_review_evidence_required'
)
ORDER BY table_name, trigger_name;

\echo '### Effective role privileges'
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
fi

printf '\n## Validation Interpretation\n\n'
printf '%s\n' 'A source-defined report confirms intended migration text. A report generated with `MIGRATION_VALIDATION_DATABASE_URL` additionally confirms that a specific PostgreSQL target exposes the expected constraints, enabled triggers, and effective privileges. Database owners and superusers can bypass ordinary grants and triggers, so runtime service identities must remain non-owner identities.'
