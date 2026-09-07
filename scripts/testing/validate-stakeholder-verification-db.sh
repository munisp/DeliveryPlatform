#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB="stakeholder_verification_validation_$$_$(date +%s)"
ADMIN="verification_admin_$$_$(date +%s)"
RUNTIME="switchos_service"
cleanup() {
  sudo -n -u postgres -- psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${DB}\";" >/dev/null 2>&1 || true
  sudo -n -u postgres -- psql -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS \"${ADMIN}\";" >/dev/null 2>&1 || true
}
trap cleanup EXIT

sudo -n -u postgres -- psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${DB}\";" >/dev/null
sudo -n -u postgres -- psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${DB}\";" >/dev/null
sudo -n -u postgres -- psql -d postgres -v ON_ERROR_STOP=1 -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${RUNTIME}') THEN CREATE ROLE ${RUNTIME} LOGIN; END IF; END \$\$; CREATE ROLE \"${ADMIN}\" LOGIN;" >/dev/null
sudo -n -u postgres -- psql -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TYPE public.user_role AS ENUM ('user', 'admin');
CREATE TABLE public.users (
  id serial PRIMARY KEY,
  open_id varchar(64) NOT NULL UNIQUE,
  name text,
  role public.user_role NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now()
);
SQL
for migration in \
  "$ROOT/drizzle/0026_ride_hailing_dispatch.sql" \
  "$ROOT/drizzle/0053_stakeholder_verification_engine.sql" \
  "$ROOT/drizzle/0054_document_forensics_processor.sql"; do
  cat "$migration" | sudo -n -u postgres -- psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null
done

sudo -n -u postgres -- psql -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO public.users(id, open_id, role, name) VALUES
  (9001,'verification-operator','admin','Verification Operator'),
  (9002,'synthetic-driver','user','Synthetic Driver');
SQL

sudo -n -u postgres -- psql -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE switchos_service;
DO $$
DECLARE
  v_case uuid;
  v_evidence uuid;
  v_job uuid;
  v_forensics_job uuid;
  v_token uuid;
  v_new_token uuid;
  v_claims integer;
  v_state verification.job_state;
  v_case_state verification.case_state;
  v_error text;
  v_now timestamptz := timestamptz '2026-09-07 14:00:00+00';
  v_digest text := repeat('a',64);
BEGIN
  v_case := verification.start_case(9002,'driver','user:9002',9002,'NG-LA','gig_worker_onboarding','case-9002-0001',v_now);
  PERFORM verification.record_consent(9002,v_case,'2026.09',repeat('b',64),v_now+interval '30 days','consent-9002-0001',v_now);
  v_evidence := verification.record_evidence(9002,v_case,'identity_document','verification/user-9002/id-front.jpg','image/jpeg',v_digest,'{"source":"synthetic"}'::jsonb,'evidence-9002-0001',v_now);
  v_job := verification.enqueue_processing(9002,v_case,v_evidence,'paddleocr','job-9002-ocr-0001',v_now);
  SELECT claim_token INTO v_token FROM verification.claim_processing_jobs(1,v_now);
  IF v_token IS NULL THEN RAISE EXCEPTION 'expected one claimed processing job'; END IF;
  SELECT count(*) INTO v_claims FROM verification.claim_processing_jobs(10,v_now);
  IF v_claims <> 0 THEN RAISE EXCEPTION 'active processor lease claimed twice'; END IF;
  v_state := verification.complete_processing_job(v_job,v_token,'failed',NULL,'processor_temporarily_unavailable','synthetic retry',v_now+interval '1 second');
  IF v_state <> 'pending' THEN RAISE EXCEPTION 'transient processor failure should retry, got %',v_state; END IF;
  SELECT claim_token INTO v_new_token FROM verification.claim_processing_jobs(10,v_now+interval '3 seconds');
  IF v_new_token IS NULL OR v_new_token=v_token THEN RAISE EXCEPTION 'fresh processor claim token required'; END IF;
  BEGIN
    PERFORM verification.complete_processing_job(v_job,v_token,'completed',repeat('c',64),'stale_result',NULL,v_now+interval '3 seconds');
    RAISE EXCEPTION 'stale processor token was accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  v_state := verification.complete_processing_job(v_job,v_new_token,'manual_review',repeat('c',64),'document_extracted_review_required',NULL,v_now+interval '3 seconds');
  IF v_state <> 'manual_review' THEN RAISE EXCEPTION 'manual review completion mismatch'; END IF;
  v_forensics_job := verification.enqueue_processing(9002,v_case,v_evidence,'document_forensics','job-9002-forensics-0001',v_now+interval '4 seconds');
  IF v_forensics_job IS NULL THEN RAISE EXCEPTION 'document forensics job was not queued'; END IF;
  BEGIN
    PERFORM verification.decide_case(9001,v_case,'verify','synthetic approval',v_now+interval '180 days','decision-before-checks-0001',v_now+interval '4 seconds');
    RAISE EXCEPTION 'verification without required provider checks was accepted';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
  PERFORM verification.record_provider_check(9001,v_case,'identity_document','local_simulator','passed','sim-id-0001',repeat('d',64),v_now+interval '180 days','synthetic_pass','provider-id-0001',v_now+interval '5 seconds');
  PERFORM verification.record_provider_check(9001,v_case,'liveness','local_simulator','passed','sim-live-0001',repeat('e',64),v_now+interval '180 days','synthetic_pass','provider-live-0001',v_now+interval '5 seconds');
  PERFORM verification.record_provider_check(9001,v_case,'driving_licence','local_simulator','passed','sim-license-0001',repeat('f',64),v_now+interval '180 days','synthetic_pass','provider-license-0001',v_now+interval '5 seconds');
  PERFORM verification.record_provider_check(9001,v_case,'criminal_record','local_simulator','passed','sim-criminal-0001',repeat('1',64),v_now+interval '180 days','synthetic_pass','provider-criminal-0001',v_now+interval '5 seconds');
  PERFORM verification.record_provider_check(9001,v_case,'sanctions','local_simulator','passed','sim-sanctions-0001',repeat('2',64),v_now+interval '180 days','synthetic_pass','provider-sanctions-0001',v_now+interval '5 seconds');
  v_case_state := verification.decide_case(9001,v_case,'verify','all synthetic checks complete',v_now+interval '180 days','decision-after-checks-0001',v_now+interval '6 seconds');
  IF v_case_state <> 'verified' THEN RAISE EXCEPTION 'expected verified case, got %',v_case_state; END IF;
  v_case_state := verification.withdraw_consent(9002,v_case,'withdraw-consent-9002-0001',v_now+interval '7 seconds');
  IF v_case_state <> 'suspended' THEN RAISE EXCEPTION 'verified case was not suspended on consent withdrawal, got %',v_case_state; END IF;
END $$;
RESET ROLE;
DO $$
BEGIN
  BEGIN
    UPDATE verification.evidence SET object_key='verification/tampered.jpg'
    WHERE evidence_kind='identity_document';
    RAISE EXCEPTION 'append-only evidence mutation was accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END $$;
SELECT c.state, count(*) AS count FROM verification.verification_case c GROUP BY c.state ORDER BY c.state;
SELECT check_type,state FROM verification.provider_check ORDER BY check_type;
SQL

echo "stakeholder_verification_result=PASS database=${DB} evidence=synthetic_only"
