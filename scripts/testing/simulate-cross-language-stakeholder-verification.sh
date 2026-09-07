#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="${$}_$(date +%s)"
DB="verification_e2e_${STAMP}"
ROLE="verification_e2e_${STAMP}"
PASSWORD="verification-e2e-password-${STAMP}"
TOKEN="0123456789abcdef0123456789abcdef"
PROVIDER_SECRET="abcdef0123456789abcdef0123456789"
PY_PORT=8120
GO_PORT=8121
RUST_PORT=8122
GO_BINARY="/tmp/verification-orchestrator-${STAMP}"
LOG="$ROOT/validation/cross_language_stakeholder_verification_20260907.txt"
SYNTHETIC_PNG_BASE64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9dQAAAABJRU5ErkJggg=="
SYNTHETIC_PNG_SHA256="$(printf '%s' "$SYNTHETIC_PNG_BASE64" | base64 --decode | sha256sum | awk '{print $1}')"

cleanup() {
  for pid in "${GO_PID:-}" "${RUST_PID:-}" "${PY_PID:-}"; do
    [[ -n "$pid" ]] && kill "$pid" >/dev/null 2>&1 || true
  done
  for pid in "${GO_PID:-}" "${RUST_PID:-}" "${PY_PID:-}"; do
    [[ -n "$pid" ]] && wait "$pid" >/dev/null 2>&1 || true
  done
  rm -f "$GO_BINARY"
  sudo -n -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB}' AND pid<>pg_backend_pid();" >/dev/null 2>&1 || true
  sudo -n -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${DB}\";" >/dev/null 2>&1 || true
  sudo -n -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS \"${ROLE}\";" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_health() {
  local url="$1"
  for _ in $(seq 1 45); do
    curl --silent --fail "$url" >/dev/null && return 0
    sleep 1
  done
  echo "health check failed: $url" >&2
  return 1
}

sudo -n -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE \"${ROLE}\" LOGIN PASSWORD '${PASSWORD}' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;" >/dev/null
sudo -n -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${DB}\" OWNER \"${ROLE}\";" >/dev/null
sudo -n -u postgres psql -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION postgis;
CREATE TYPE public.user_role AS ENUM ('user','admin');
CREATE TABLE public.users (id serial PRIMARY KEY, open_id varchar(64) NOT NULL UNIQUE, name text, role public.user_role NOT NULL DEFAULT 'user', created_at timestamptz NOT NULL DEFAULT now());
SQL
for migration in "$ROOT/drizzle/0026_ride_hailing_dispatch.sql" "$ROOT/drizzle/0053_stakeholder_verification_engine.sql" "$ROOT/drizzle/0054_document_forensics_processor.sql"; do
  cp "$migration" "/tmp/$(basename "$migration")-${STAMP}"
  chmod 0644 "/tmp/$(basename "$migration")-${STAMP}"
  sudo -n -u postgres psql -d "$DB" -v ON_ERROR_STOP=1 -f "/tmp/$(basename "$migration")-${STAMP}" >/dev/null
  rm -f "/tmp/$(basename "$migration")-${STAMP}"
done
sudo -n -u postgres psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL
INSERT INTO public.users(id,open_id,name,role) VALUES (9001,'verification-operator','Verification Operator','admin'),(9002,'verification-subject','Verification Subject','user');
GRANT USAGE ON SCHEMA verification TO "${ROLE}";
GRANT EXECUTE ON FUNCTION verification.claim_processing_jobs(integer,timestamptz) TO "${ROLE}";
GRANT EXECUTE ON FUNCTION verification.complete_processing_job(uuid,uuid,verification.job_state,text,text,text,timestamptz) TO "${ROLE}";
GRANT EXECUTE ON FUNCTION verification.record_provider_check(integer,uuid,verification.check_type,text,verification.check_state,text,text,timestamptz,text,text,timestamptz) TO "${ROLE}";
SQL

(cd "$ROOT/services/rust/verification-policy" && cargo build --quiet)
(cd "$ROOT/services/go/verification-orchestrator" && go build -o "$GO_BINARY" .)
(
  cd "$ROOT/services/python/verification-intelligence"
  INTERNAL_SERVICE_TOKEN="$TOKEN" VERIFICATION_SYNTHETIC_MODE=false python3 -m uvicorn main:app --host 127.0.0.1 --port "$PY_PORT"
) >"/tmp/verification-intelligence-${STAMP}.log" 2>&1 & PY_PID=$!
INTERNAL_SERVICE_TOKEN="$TOKEN" BIND_ADDR="127.0.0.1:${RUST_PORT}" "$ROOT/services/rust/verification-policy/target/debug/switchos-verification-policy" >"/tmp/verification-policy-${STAMP}.log" 2>&1 & RUST_PID=$!
DATABASE_URL="postgresql://${ROLE}:${PASSWORD}@127.0.0.1:5432/${DB}?sslmode=disable" INTERNAL_SERVICE_TOKEN="$TOKEN" VERIFICATION_INTELLIGENCE_URL="http://127.0.0.1:${PY_PORT}" VERIFICATION_POLICY_URL="http://127.0.0.1:${RUST_PORT}" VERIFICATION_ALLOW_SYNTHETIC_OBJECTS=true VERIFICATION_SYNTHETIC_OBJECTS_JSON="{\"verification/subject-9002/id.png\":\"${SYNTHETIC_PNG_BASE64}\"}" VERIFICATION_PROVIDER_WEBHOOK_SECRETS_JSON="{\"local_simulator\":\"${PROVIDER_SECRET}\"}" VERIFICATION_PROVIDER_ACTOR_ID=9001 BIND_ADDR="127.0.0.1:${GO_PORT}" "$GO_BINARY" >"/tmp/verification-orchestrator-${STAMP}.log" 2>&1 & GO_PID=$!
wait_health "http://127.0.0.1:${PY_PORT}/health"
wait_health "http://127.0.0.1:${RUST_PORT}/health"
wait_health "http://127.0.0.1:${GO_PORT}/health"

CASE_ID="$(sudo -n -u postgres psql -d "$DB" -At -v ON_ERROR_STOP=1 -v image_sha="$SYNTHETIC_PNG_SHA256" <<'SQL'
SELECT verification.start_case(9002,'driver','user:9002',9002,'NG-LA','gig_worker_onboarding','cross-language-case-0001') AS case_id \gset
SELECT verification.record_consent(9002,:'case_id','2026.09',repeat('b',64),clock_timestamp()+interval '30 days','cross-language-consent-0001') AS consent_id \gset
SELECT verification.record_evidence(9002,:'case_id','identity_document','verification/subject-9002/id.png','image/png',:'image_sha','{"mrz_lines":["P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<","L898902C36UTO7408122F1204159ZE184226B<<<<<10"]}'::jsonb,'cross-language-evidence-0001') AS evidence_id \gset
SELECT verification.enqueue_processing(9002,:'case_id',:'evidence_id','paddleocr','cross-language-job-0001') AS job_id \gset
SELECT verification.enqueue_processing(9002,:'case_id',:'evidence_id','document_forensics','cross-language-forensics-0001') AS forensic_job_id \gset
SELECT :'case_id';
SQL
)"
RUN_RESPONSE="$(curl --silent --show-error --fail -X POST "http://127.0.0.1:${GO_PORT}/v1/jobs/run-once" -H "X-Internal-Service-Token: ${TOKEN}")"
JOB_MANUAL_REVIEW_COUNT="$(sudo -n -u postgres psql -d "$DB" -At -c "SELECT count(*) FROM verification.processing_job WHERE state='manual_review'")"
CASE_STATE_AFTER_PROCESS="$(sudo -n -u postgres psql -d "$DB" -At -c "SELECT state::text FROM verification.verification_case WHERE id='${CASE_ID}'::uuid")"
[[ "$RUN_RESPONSE" == *'"claimed":2'* && "$JOB_MANUAL_REVIEW_COUNT" == "2" && "$CASE_STATE_AFTER_PROCESS" == "manual_review" ]] || { echo "processor integration failed response=${RUN_RESPONSE} manual_jobs=${JOB_MANUAL_REVIEW_COUNT} case=${CASE_STATE_AFTER_PROCESS}" >&2; exit 1; }
MRZ_RESPONSE="$(curl --silent --show-error --fail -X POST "http://127.0.0.1:${RUST_PORT}/v1/forensics/mrz" -H "X-Internal-Service-Token: ${TOKEN}" -H 'Content-Type: application/json' --data '{"lines":["P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<","L898902C36UTO7408122F1204159ZE184226B<<<<<10"]}')"
[[ "$MRZ_RESPONSE" == *'"valid":true'* ]] || { echo "MRZ validation failed response=${MRZ_RESPONSE}" >&2; exit 1; }

for check in identity_document liveness driving_licence criminal_record sanctions; do
  BODY="{\"case_id\":\"${CASE_ID}\",\"check_type\":\"${check}\",\"state\":\"passed\",\"provider_reference\":\"synthetic-${check}\",\"response_digest_hex\":\"$(printf '%064d' 0 | tr '0' a)\",\"expires_at\":\"2027-09-07T14:00:00Z\",\"detail_code\":\"synthetic_pass\",\"idempotency_key\":\"callback-${check}-0001\"}"
  SIGNATURE="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$PROVIDER_SECRET" -hex | sed 's/^.* //')"
  STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' -X POST "http://127.0.0.1:${GO_PORT}/v1/providers/callback" -H 'Content-Type: application/json' -H 'X-Verification-Provider: local_simulator' -H "X-Verification-Signature-256: ${SIGNATURE}" --data "$BODY")"
  [[ "$STATUS" == "204" ]] || { echo "provider callback failed check=${check} status=${STATUS}" >&2; exit 1; }
done
FINAL_STATE="$(sudo -n -u postgres psql -d "$DB" -At -v ON_ERROR_STOP=1 -c "SELECT verification.decide_case(9001,'${CASE_ID}'::uuid,'verify','synthetic cross-language verification complete',clock_timestamp()+interval '180 days','cross-language-decision-0001')::text")"
CHECK_COUNT="$(sudo -n -u postgres psql -d "$DB" -At -c "SELECT count(*) FROM verification.provider_check WHERE case_id='${CASE_ID}'::uuid AND state='passed'")"
[[ "$FINAL_STATE" == "verified" && "$CHECK_COUNT" == "5" ]] || { echo "final decision failed state=${FINAL_STATE} checks=${CHECK_COUNT}" >&2; exit 1; }

{
  echo "python_intelligence=healthy synthetic_mode=false bounded_synthetic_object_source=true"
  echo "rust_policy=healthy manual_review_only=true"
  echo "go_orchestrator_run_once=${RUN_RESPONSE}"
  echo "processing_jobs_manual_review=${JOB_MANUAL_REVIEW_COUNT}"
  echo "rust_mrz_validation=${MRZ_RESPONSE}"
  echo "case_state_after_processor=${CASE_STATE_AFTER_PROCESS}"
  echo "signed_provider_callbacks_passed=${CHECK_COUNT}"
  echo "final_human_decision=${FINAL_STATE}"
  echo "cross_language_stakeholder_verification=PASS synthetic_only=true"
} | tee "$LOG"
