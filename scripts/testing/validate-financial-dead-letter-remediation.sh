#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="${$}_$(date +%s)"
DB_NAME="financial_dead_letter_${STAMP}"
OWNER_ROLE="financial_dead_letter_owner_${STAMP}"
RUNTIME_ROLE="financial_dead_letter_runtime_${STAMP}"
OWNER_PASSWORD="owner_${STAMP}_local_only"
RUNTIME_PASSWORD="runtime_${STAMP}_local_only"
OWNER_URL="postgresql://${OWNER_ROLE}:${OWNER_PASSWORD}@127.0.0.1:5432/${DB_NAME}?sslmode=disable"
RUNTIME_URL="postgresql://${RUNTIME_ROLE}:${RUNTIME_PASSWORD}@127.0.0.1:5432/${DB_NAME}?sslmode=disable"

cleanup() {
  set +e
  sudo -u postgres dropdb --if-exists "$DB_NAME" >/dev/null 2>&1
  sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${RUNTIME_ROLE}" >/dev/null 2>&1
  sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${OWNER_ROLE}" >/dev/null 2>&1
}
trap cleanup EXIT

sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${OWNER_ROLE} LOGIN PASSWORD '${OWNER_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS" >/dev/null
sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${RUNTIME_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS" >/dev/null
sudo -u postgres createdb -O "$OWNER_ROLE" "$DB_NAME"

PGPASSWORD="$OWNER_PASSWORD" psql "$OWNER_URL" -X -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE EXTENSION pgcrypto;
CREATE TABLE public.users (id integer PRIMARY KEY, role text NOT NULL);
INSERT INTO public.users(id, role) VALUES (100, 'admin'), (101, 'admin'), (102, 'admin');
SQL

for migration in \
  "$ROOT_DIR/drizzle/0006_mojaloop_exact_money_and_outbox.sql" \
  "$ROOT_DIR/drizzle/0007_mojaloop_schema_contract.sql" \
  "$ROOT_DIR/drizzle/0055_tigerbeetle_batch_outbox.sql" \
  "$ROOT_DIR/drizzle/0056_financial_dead_letter_remediation.sql"; do
  PGPASSWORD="$OWNER_PASSWORD" psql "$OWNER_URL" -X -v ON_ERROR_STOP=1 < "$migration" >/dev/null
done

PGPASSWORD="$OWNER_PASSWORD" psql "$OWNER_URL" -X -v ON_ERROR_STOP=1 <<SQL >/dev/null
GRANT CONNECT ON DATABASE ${DB_NAME} TO ${RUNTIME_ROLE};
GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE};
GRANT EXECUTE ON FUNCTION mojaloop_open_dead_letter_case(integer,bigint,text,text,text,timestamptz) TO ${RUNTIME_ROLE};
GRANT EXECUTE ON FUNCTION mojaloop_request_dead_letter_remediation(integer,uuid,text,text,text,text,text,text,text,timestamptz,text,timestamptz) TO ${RUNTIME_ROLE};
GRANT EXECUTE ON FUNCTION mojaloop_approve_dead_letter_remediation(integer,uuid,text,text,timestamptz) TO ${RUNTIME_ROLE};
GRANT EXECUTE ON FUNCTION mojaloop_reject_dead_letter_remediation(integer,uuid,text,text,timestamptz) TO ${RUNTIME_ROLE};
GRANT EXECUTE ON FUNCTION mojaloop_list_dead_letter_cases(integer,integer) TO ${RUNTIME_ROLE};
SQL

printf '%s\n' '=== Financial dead-letter two-person remediation validation ==='
printf 'database=%s\n' "$DB_NAME"
printf '%s\n' 'mode=disposable_postgresql_runtime_functions_only'

PGPASSWORD="$OWNER_PASSWORD" psql "$OWNER_URL" -X -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO mojaloop_transfers (
  transfer_id,payer_fsp,payee_fsp,amount,currency,ilp_packet,condition,expiration,state,amount_minor
) VALUES (
  'transfer-original-0001','payer-a','payee-b',120.00,'NGN','ilp-original','condition-original-0001',
  clock_timestamp()+interval '2 hours','PREPARED',12000
);
INSERT INTO mojaloop_workflows(workflow_id,workflow_type,resource_id,current_step,status)
VALUES ('transfer-original-0001','transfer','transfer-original-0001','ledger_dead_lettered','FAILED');
INSERT INTO mojaloop_funds_outbox (
  event_id,destination,idempotency_key,workflow_id,workflow_type,resource_id,step,workflow_status,
  payload,dispatch_order,status,attempt_count,next_attempt_at,ledger_debit_fsp,last_error
) VALUES (
  'evt-dead-letter-0001','tigerbeetle','transfer-original-0001','transfer-original-0001','transfer',
  'transfer-original-0001','transfer_prepare','FAILED',
  '{"amountMinor":12000,"payerFsp":"payer-a","payeeFsp":"payee-b"}'::jsonb,
  10,'dead_letter',12,clock_timestamp(),'payer-a','simulated terminal ledger response'
);
SQL

CASE_ID="$(PGPASSWORD="$RUNTIME_PASSWORD" psql "$RUNTIME_URL" -X -A -t -v ON_ERROR_STOP=1 -c "SELECT mojaloop_open_dead_letter_case(100,1,'ledger response investigated','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','case-open-0001',clock_timestamp());")"
if [[ ! "$CASE_ID" =~ ^[0-9a-f-]{36}$ ]]; then
  echo 'expected a UUID case id' >&2
  exit 1
fi
CASE_ID_IDEMPOTENT="$(PGPASSWORD="$RUNTIME_PASSWORD" psql "$RUNTIME_URL" -X -A -t -v ON_ERROR_STOP=1 -c "SELECT mojaloop_open_dead_letter_case(100,1,'ledger response investigated','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','case-open-0001',clock_timestamp());")"
[[ "$CASE_ID_IDEMPOTENT" == "$CASE_ID" ]]

PGPASSWORD="$RUNTIME_PASSWORD" psql "$RUNTIME_URL" -X -v ON_ERROR_STOP=1 <<SQL >/dev/null
DO \$\$
BEGIN
  PERFORM mojaloop_request_dead_letter_remediation(
    100,'${CASE_ID}'::uuid,'unconfirmed ledger state','uncertain','recon://local/uncertain',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'replacement-transfer-0001','ilp-replacement','replacement-condition-0001',
    clock_timestamp()+interval '2 hours','request-uncertain-0001',clock_timestamp());
  RAISE EXCEPTION 'uncertain ledger disposition was accepted';
EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
END \$\$;
SQL

STATE="$(PGPASSWORD="$RUNTIME_PASSWORD" psql "$RUNTIME_URL" -X -A -t -v ON_ERROR_STOP=1 -c "SELECT mojaloop_request_dead_letter_remediation(100,'${CASE_ID}'::uuid,'reconciled as not committed','confirmed_not_committed','recon://local/confirmed', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','replacement-transfer-0001','ilp-replacement','replacement-condition-0001',clock_timestamp()+interval '2 hours','request-remediation-0001',clock_timestamp());")"
[[ "$STATE" == 'approval_pending' ]]

STATE_IDEMPOTENT="$(PGPASSWORD="$RUNTIME_PASSWORD" psql "$RUNTIME_URL" -X -A -t -v ON_ERROR_STOP=1 -c "SELECT mojaloop_request_dead_letter_remediation(100,'${CASE_ID}'::uuid,'reconciled as not committed','confirmed_not_committed','recon://local/confirmed','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','replacement-transfer-0001','ilp-replacement','replacement-condition-0001',clock_timestamp()+interval '2 hours','request-remediation-0001',clock_timestamp());")"
[[ "$STATE_IDEMPOTENT" == 'approval_pending' ]]

PGPASSWORD="$RUNTIME_PASSWORD" psql "$RUNTIME_URL" -X -v ON_ERROR_STOP=1 <<SQL >/dev/null
DO \$\$
BEGIN
  PERFORM mojaloop_approve_dead_letter_remediation(100,'${CASE_ID}'::uuid,'same operator attempt','approve-same-user-0001',clock_timestamp());
  RAISE EXCEPTION 'requester self-approval was accepted';
EXCEPTION WHEN SQLSTATE '42501' THEN
  RAISE NOTICE 'expected self-approval rejection observed: SQLSTATE 42501';
END \$\$;
SQL

APPROVAL="$(PGPASSWORD="$RUNTIME_PASSWORD" psql "$RUNTIME_URL" -X -A -F '|' -t -v ON_ERROR_STOP=1 -c "SELECT case_id,replacement_transfer_id,remediation_outbox_id,state FROM mojaloop_approve_dead_letter_remediation(101,'${CASE_ID}'::uuid,'independent reconciler approved','approve-independent-0001',clock_timestamp());")"
[[ "$APPROVAL" =~ ^${CASE_ID}\|replacement-transfer-0001\|[0-9]+\|replacement_intent_created$ ]]

PGPASSWORD="$OWNER_PASSWORD" psql "$OWNER_URL" -X -v ON_ERROR_STOP=1 <<SQL >/dev/null
DO \$\$
DECLARE
  v_status text;
  v_original_state text;
  v_replacement_state text;
  v_outbox_status text;
  v_case_events integer;
BEGIN
  SELECT status INTO v_status FROM mojaloop_funds_outbox WHERE id=1;
  SELECT state INTO v_original_state FROM mojaloop_transfers WHERE transfer_id='transfer-original-0001';
  SELECT state INTO v_replacement_state FROM mojaloop_transfers WHERE transfer_id='replacement-transfer-0001';
  SELECT status INTO v_outbox_status FROM mojaloop_funds_outbox WHERE workflow_id='replacement-transfer-0001';
  SELECT count(*) INTO v_case_events FROM mojaloop_dead_letter_case_event WHERE case_id='${CASE_ID}'::uuid;
  IF v_status <> 'dead_letter' OR v_original_state <> 'PREPARED' OR v_replacement_state <> 'PENDING' OR v_outbox_status <> 'pending' OR v_case_events <> 3 THEN
    RAISE EXCEPTION 'remediation state mismatch: old=% original=% replacement=% outbox=% events=%',v_status,v_original_state,v_replacement_state,v_outbox_status,v_case_events;
  END IF;
  BEGIN
    UPDATE mojaloop_dead_letter_case_event SET action='tampered' WHERE case_id='${CASE_ID}'::uuid;
    RAISE EXCEPTION 'append-only remediation event mutation was accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN
      RAISE NOTICE 'expected append-only event rejection observed: SQLSTATE 55000';
  END;
END \$\$;
SQL

PGPASSWORD="$RUNTIME_PASSWORD" psql "$RUNTIME_URL" -X -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $$
BEGIN
  PERFORM 1 FROM mojaloop_dead_letter_case;
  RAISE EXCEPTION 'runtime role read remediation table directly';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
SQL

printf '%s\n' "case_id=${CASE_ID}"
printf '%s\n' "approved_result=${APPROVAL}"
printf '%s\n' 'dead_letter_case_open_idempotency=PASS'
printf '%s\n' 'remediation_request_idempotency=PASS'
printf '%s\n' 'two_person_self_approval_rejected=PASS'
printf '%s\n' 'uncertain_ledger_disposition_rejected=PASS'
printf '%s\n' 'original_dead_letter_immutable=PASS'
printf '%s\n' 'replacement_intent_created_without_replaying_original=PASS'
printf '%s\n' 'append_only_case_evidence=PASS'
printf '%s\n' 'runtime_direct_table_read_denied=PASS'
printf '%s\n' 'financial_dead_letter_remediation_validation=PASS'
