#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ACKNOWLEDGEMENT="I_UNDERSTAND_THIS_RUNS_A_DISPOSABLE_FINANCIAL_LOAD_REHEARSAL"

fail() {
  printf 'financial_dispatcher_load_rehearsal=FAIL reason=%s\n' "$1" >&2
  exit 1
}

[[ "${ALLOW_FINANCIAL_DISPATCHER_LOAD_REHEARSAL:-}" == "$ACKNOWLEDGEMENT" ]] || \
  fail "set_ALLOW_FINANCIAL_DISPATCHER_LOAD_REHEARSAL_to_explicit_acknowledgement"

DATABASE_URL="${TEST_DATABASE_URL:-}"
[[ "$DATABASE_URL" =~ ^postgres(ql)?:// ]] || fail "TEST_DATABASE_URL_must_be_an_isolated_postgresql_URL"
[[ "$DATABASE_URL" != *"prod"* && "$DATABASE_URL" != *"production"* ]] || fail "TEST_DATABASE_URL_looks_like_production"

TRANSFERS="${FINANCIAL_LOAD_TRANSFERS:-4096}"
LANES="${FINANCIAL_LOAD_LANES:-4}"
BATCH_MAX="${FINANCIAL_LOAD_BATCH_MAX:-256}"
[[ "$TRANSFERS" =~ ^[0-9]+$ && "$TRANSFERS" -ge 1 && "$TRANSFERS" -le 50000 ]] || fail "invalid_FINANCIAL_LOAD_TRANSFERS"
[[ "$LANES" =~ ^[0-9]+$ && "$LANES" -ge 1 && "$LANES" -le 8 ]] || fail "invalid_FINANCIAL_LOAD_LANES"
[[ "$BATCH_MAX" =~ ^[0-9]+$ && "$BATCH_MAX" -ge 1 && "$BATCH_MAX" -le 8190 ]] || fail "invalid_FINANCIAL_LOAD_BATCH_MAX"

command -v psql >/dev/null 2>&1 || fail "psql_is_required"
command -v go >/dev/null 2>&1 || fail "go_is_required"

# The harness creates transfers and outbox rows in the nominated disposable
# database. These four migrations are the minimum reviewed contract required by
# the claim-token, lane-index, and exact-money code paths. Never point this at a
# shared or production database.
printf '%s\n' 'Applying financial rehearsal migrations to isolated database...'
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/drizzle/0006_mojaloop_exact_money_and_outbox.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/drizzle/0007_mojaloop_schema_contract.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/drizzle/0055_tigerbeetle_batch_outbox.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/drizzle/0070_financial_partitioned_tigerbeetle_dispatch.sql"

printf '%s\n' 'Running PostgreSQL outbox and deterministic TigerBeetle-contract simulation...'
(
  cd "$ROOT_DIR/services/go/mojaloop"
  TEST_DATABASE_URL="$DATABASE_URL" go test -count=1 -run '^TestFinancialDispatcherPartitionedLoad$' \
    -financial-load-transfers="$TRANSFERS" \
    -financial-load-lanes="$LANES" \
    -financial-load-batch-max="$BATCH_MAX" \
    -v
)

printf 'financial_dispatcher_load_rehearsal=PASS transfers=%s lanes=%s batch_max=%s ledger_mode=deterministic_contract_simulator\n' \
  "$TRANSFERS" "$LANES" "$BATCH_MAX"
