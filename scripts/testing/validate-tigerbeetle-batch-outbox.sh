#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="${$}_$(date +%s)"
DB_NAME="tigerbeetle_batch_outbox_${STAMP}"
ROLE_NAME="tigerbeetle_batch_runtime_${STAMP}"
ROLE_PASSWORD="local_batch_${STAMP}_only"
DATABASE_URL="postgresql://${ROLE_NAME}:${ROLE_PASSWORD}@127.0.0.1:5432/${DB_NAME}?sslmode=disable"

cleanup() {
  set +e
  sudo -u postgres dropdb --if-exists "$DB_NAME" >/dev/null 2>&1
  sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${ROLE_NAME}" >/dev/null 2>&1
}
trap cleanup EXIT

sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${ROLE_NAME} LOGIN PASSWORD '${ROLE_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS" >/dev/null
sudo -u postgres createdb -O "$ROLE_NAME" "$DB_NAME"
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION pgcrypto' >/dev/null

for migration in \
  "$ROOT_DIR/drizzle/0006_mojaloop_exact_money_and_outbox.sql" \
  "$ROOT_DIR/drizzle/0007_mojaloop_schema_contract.sql" \
  "$ROOT_DIR/drizzle/0055_tigerbeetle_batch_outbox.sql"; do
  PGPASSWORD="$ROLE_PASSWORD" psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 < "$migration" >/dev/null
done

printf '%s\n' '=== TigerBeetle multi-transfer outbox simulation ==='
printf 'database=%s\n' "$DB_NAME"
printf '%s\n' 'mode=disposable_postgresql_fake_ledger_no_tigerbeetle_server'
(
  cd "$ROOT_DIR/services/go/mojaloop"
  TEST_DATABASE_URL="$DATABASE_URL" go test -race -count=1 -v -run '^(TestTigerBeetleBatchDispatch.*|TestFundsOutboxAtomicPersistenceAndRecovery)$' ./...
)
printf '%s\n' 'tigerbeetle_multi_transfer_batch_simulation=PASS'
