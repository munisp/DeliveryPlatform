BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS verification;

DO $$ BEGIN
  CREATE TYPE verification.subject_type AS ENUM (
    'driver','vehicle_asset','field_technician','merchant','fleet_provider','operator'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE verification.case_state AS ENUM (
    'initiated','evidence_pending','processing','manual_review','verified','rejected','expired','suspended'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE verification.check_type AS ENUM (
    'identity_document','liveness','driving_licence','criminal_record','sanctions',
    'vehicle_registry','commercial_insurance','technician_credential','beneficial_owner','operator_recertification'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE verification.check_state AS ENUM (
    'required','pending','passed','failed','manual_review','unavailable','expired'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE verification.job_state AS ENUM ('pending','claimed','completed','failed','manual_review');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE verification.decision AS ENUM ('verify','reject','suspend','expire');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS verification.verification_case (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type verification.subject_type NOT NULL,
  subject_key text NOT NULL CHECK (subject_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$'),
  subject_user_id integer REFERENCES public.users(id) ON DELETE RESTRICT,
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,12})?$'),
  purpose text NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  state verification.case_state NOT NULL DEFAULT 'initiated',
  request_key text NOT NULL CHECK (request_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  decided_by_user_id integer REFERENCES public.users(id) ON DELETE RESTRICT,
  decision_reason text,
  verified_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (subject_type, subject_key, purpose, request_key),
  CHECK (length(decision_reason) <= 1000),
  CHECK ((state = 'verified') = (verified_at IS NOT NULL)),
  CHECK (expires_at IS NULL OR verified_at IS NULL OR expires_at > verified_at)
);
CREATE INDEX IF NOT EXISTS verification_case_subject_state_idx
  ON verification.verification_case (subject_type, subject_key, state, expires_at DESC);
CREATE INDEX IF NOT EXISTS verification_case_subject_user_idx
  ON verification.verification_case (subject_user_id, updated_at DESC) WHERE subject_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS verification.consent_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES verification.verification_case(id) ON DELETE RESTRICT,
  subject_user_id integer REFERENCES public.users(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  consent_version text NOT NULL CHECK (consent_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  disclosure_digest_hex text NOT NULL CHECK (disclosure_digest_hex ~ '^[a-f0-9]{64}$'),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  withdrawn_at timestamptz,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  UNIQUE (case_id, idempotency_key),
  CHECK (expires_at > granted_at),
  CHECK (withdrawn_at IS NULL OR withdrawn_at >= granted_at)
);
CREATE INDEX IF NOT EXISTS verification_consent_case_active_idx
  ON verification.consent_receipt (case_id, expires_at) WHERE withdrawn_at IS NULL;

CREATE TABLE IF NOT EXISTS verification.evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES verification.verification_case(id) ON DELETE RESTRICT,
  evidence_kind text NOT NULL CHECK (evidence_kind ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 3 AND 512 AND object_key ~ '^[A-Za-z0-9][A-Za-z0-9._/-]+$'),
  content_type text NOT NULL CHECK (content_type IN ('application/pdf','image/jpeg','image/png','image/heic','video/mp4')),
  sha256_hex text NOT NULL CHECK (sha256_hex ~ '^[a-f0-9]{64}$'),
  capture_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capture_metadata) = 'object'),
  supplied_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (case_id, idempotency_key),
  UNIQUE (case_id, evidence_kind, sha256_hex)
);
CREATE INDEX IF NOT EXISTS verification_evidence_case_idx ON verification.evidence (case_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS verification.processing_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES verification.verification_case(id) ON DELETE RESTRICT,
  evidence_id uuid NOT NULL REFERENCES verification.evidence(id) ON DELETE RESTRICT,
  processor text NOT NULL CHECK (processor IN ('paddleocr','docling','vlm_document','liveness')),
  state verification.job_state NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claim_token uuid,
  claim_expires_at timestamptz,
  output_digest_hex text CHECK (output_digest_hex IS NULL OR output_digest_hex ~ '^[a-f0-9]{64}$'),
  outcome_code text CHECK (outcome_code IS NULL OR outcome_code ~ '^[a-z][a-z0-9_.-]{2,95}$'),
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 1000),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (case_id, evidence_id, processor, idempotency_key),
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL))
);
CREATE INDEX IF NOT EXISTS verification_job_claim_idx
  ON verification.processing_job (next_attempt_at, created_at)
  WHERE state IN ('pending','claimed') AND attempts < 8;

CREATE TABLE IF NOT EXISTS verification.provider_check (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES verification.verification_case(id) ON DELETE RESTRICT,
  check_type verification.check_type NOT NULL,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9_-]{2,63}$'),
  state verification.check_state NOT NULL DEFAULT 'required',
  provider_reference text CHECK (provider_reference IS NULL OR length(provider_reference) BETWEEN 3 AND 200),
  response_digest_hex text CHECK (response_digest_hex IS NULL OR response_digest_hex ~ '^[a-f0-9]{64}$'),
  checked_at timestamptz,
  expires_at timestamptz,
  detail_code text CHECK (detail_code IS NULL OR detail_code ~ '^[a-z][a-z0-9_.-]{2,95}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (case_id, check_type),
  UNIQUE (case_id, idempotency_key),
  CHECK ((state IN ('passed','failed','manual_review','unavailable','expired')) = (checked_at IS NOT NULL)),
  CHECK (expires_at IS NULL OR checked_at IS NULL OR expires_at > checked_at)
);
CREATE INDEX IF NOT EXISTS verification_check_case_state_idx ON verification.provider_check (case_id, state, expires_at);

CREATE TABLE IF NOT EXISTS verification.decision_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES verification.verification_case(id) ON DELETE RESTRICT,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{2,95}$'),
  previous_state verification.case_state,
  next_state verification.case_state NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  detail_digest bytea NOT NULL CHECK (octet_length(detail_digest) = 32),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (case_id, sequence_no),
  UNIQUE (case_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS verification.outbox_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES verification.verification_case(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.-]{2,95}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (case_id, event_type, idempotency_key)
);

CREATE OR REPLACE FUNCTION verification.prevent_append_only_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,verification AS $$
BEGIN RAISE EXCEPTION 'verification evidence is append only' USING ERRCODE='55000'; END; $$;
DROP TRIGGER IF EXISTS verification_evidence_append_only ON verification.evidence;
CREATE TRIGGER verification_evidence_append_only BEFORE UPDATE OR DELETE ON verification.evidence FOR EACH ROW EXECUTE FUNCTION verification.prevent_append_only_mutation();
DROP TRIGGER IF EXISTS verification_consent_append_only ON verification.consent_receipt;
CREATE TRIGGER verification_consent_append_only BEFORE DELETE ON verification.consent_receipt FOR EACH ROW EXECUTE FUNCTION verification.prevent_append_only_mutation();
DROP TRIGGER IF EXISTS verification_decision_event_append_only ON verification.decision_event;
CREATE TRIGGER verification_decision_event_append_only BEFORE UPDATE OR DELETE ON verification.decision_event FOR EACH ROW EXECUTE FUNCTION verification.prevent_append_only_mutation();

CREATE OR REPLACE FUNCTION verification.is_operator(p_user_id integer)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,verification AS $$
  SELECT EXISTS (SELECT 1 FROM public.users WHERE id=p_user_id AND role='admin');
$$;

CREATE OR REPLACE FUNCTION verification.required_checks(p_subject verification.subject_type)
RETURNS verification.check_type[] LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,verification AS $$
  SELECT CASE p_subject
    WHEN 'driver'::verification.subject_type THEN ARRAY['identity_document','liveness','driving_licence','criminal_record','sanctions']::verification.check_type[]
    WHEN 'vehicle_asset'::verification.subject_type THEN ARRAY['vehicle_registry','commercial_insurance']::verification.check_type[]
    WHEN 'field_technician'::verification.subject_type THEN ARRAY['identity_document','liveness','criminal_record','sanctions','technician_credential']::verification.check_type[]
    WHEN 'merchant'::verification.subject_type THEN ARRAY['beneficial_owner','sanctions']::verification.check_type[]
    WHEN 'fleet_provider'::verification.subject_type THEN ARRAY['beneficial_owner','sanctions','commercial_insurance']::verification.check_type[]
    WHEN 'operator'::verification.subject_type THEN ARRAY['identity_document','liveness','criminal_record','sanctions','operator_recertification']::verification.check_type[]
  END;
$$;

CREATE OR REPLACE FUNCTION verification.append_event(p_case uuid,p_actor integer,p_action text,p_previous verification.case_state,p_next verification.case_state,p_detail jsonb,p_key text,p_now timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,verification AS $$
DECLARE v_sequence integer;
BEGIN
  SELECT COALESCE(MAX(sequence_no),0)+1 INTO v_sequence FROM verification.decision_event WHERE case_id=p_case;
  INSERT INTO verification.decision_event(case_id,sequence_no,actor_user_id,action,previous_state,next_state,detail,detail_digest,idempotency_key,created_at)
  VALUES(p_case,v_sequence,p_actor,p_action,p_previous,p_next,p_detail,public.digest(convert_to(p_detail::text,'UTF8'),'sha256'),p_key,p_now)
  ON CONFLICT (case_id,idempotency_key) DO NOTHING;
END; $$;

CREATE OR REPLACE FUNCTION verification.enqueue_event(p_case uuid,p_event text,p_key text,p_now timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,verification AS $$
DECLARE v_case verification.verification_case%ROWTYPE;
BEGIN
  SELECT * INTO v_case FROM verification.verification_case WHERE id=p_case;
  INSERT INTO verification.outbox_event(case_id,event_type,payload,idempotency_key,created_at)
  VALUES(p_case,p_event,jsonb_build_object('case_id',p_case,'subject_type',v_case.subject_type,'subject_key',v_case.subject_key,'state',v_case.state,'updated_at',v_case.updated_at),p_key,p_now)
  ON CONFLICT (case_id,event_type,idempotency_key) DO NOTHING;
END; $$;

CREATE OR REPLACE FUNCTION verification.start_case(p_actor integer,p_subject verification.subject_type,p_subject_key text,p_subject_user integer,p_jurisdiction text,p_purpose text,p_key text,p_now timestamptz DEFAULT clock_timestamp())
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,verification AS $$
DECLARE v_id uuid;
BEGIN
  IF p_subject_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$' OR p_jurisdiction !~ '^[A-Z]{2}(-[A-Z0-9]{1,12})?$' OR p_purpose !~ '^[a-z][a-z0-9_.-]{2,63}$' OR p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid verification case input' USING ERRCODE='22023'; END IF;
  IF p_subject_user IS NULL AND NOT verification.is_operator(p_actor) THEN RAISE EXCEPTION 'operator case creation required' USING ERRCODE='42501'; END IF;
  IF p_subject_user IS NOT NULL AND p_actor<>p_subject_user AND NOT verification.is_operator(p_actor) THEN RAISE EXCEPTION 'case subject or operator required' USING ERRCODE='42501'; END IF;
  INSERT INTO verification.verification_case(subject_type,subject_key,subject_user_id,jurisdiction,purpose,state,request_key,created_by_user_id,created_at,updated_at)
  VALUES(p_subject,p_subject_key,p_subject_user,p_jurisdiction,p_purpose,'initiated',p_key,p_actor,p_now,p_now)
  ON CONFLICT(subject_type,subject_key,purpose,request_key) DO UPDATE SET updated_at=verification.verification_case.updated_at
  RETURNING id INTO v_id;
  PERFORM verification.append_event(v_id,p_actor,'verification.case.initiated',NULL,'initiated',jsonb_build_object('purpose',p_purpose,'jurisdiction',p_jurisdiction),p_key,p_now);
  PERFORM verification.enqueue_event(v_id,'verification.case.initiated',p_key,p_now);
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION verification.record_consent(p_actor integer,p_case uuid,p_version text,p_disclosure_digest text,p_expires timestamptz,p_key text,p_now timestamptz DEFAULT clock_timestamp())
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,verification AS $$
DECLARE v_case verification.verification_case%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO v_case FROM verification.verification_case WHERE id=p_case FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'verification case not found' USING ERRCODE='P0002'; END IF;
  IF v_case.subject_user_id IS NULL OR (p_actor<>v_case.subject_user_id AND NOT verification.is_operator(p_actor)) THEN RAISE EXCEPTION 'case subject or operator required' USING ERRCODE='42501'; END IF;
  IF p_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' OR p_disclosure_digest !~ '^[a-f0-9]{64}$' OR p_expires<=p_now OR p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid consent input' USING ERRCODE='22023'; END IF;
  INSERT INTO verification.consent_receipt(case_id,subject_user_id,purpose,consent_version,disclosure_digest_hex,granted_at,expires_at,idempotency_key)
  VALUES(p_case,v_case.subject_user_id,v_case.purpose,p_version,p_disclosure_digest,p_now,p_expires,p_key)
  ON CONFLICT(case_id,idempotency_key) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN SELECT id INTO v_id FROM verification.consent_receipt WHERE case_id=p_case AND idempotency_key=p_key; END IF;
  UPDATE verification.verification_case SET state=CASE WHEN state='initiated' THEN 'evidence_pending'::verification.case_state ELSE state END,updated_at=p_now WHERE id=p_case;
  PERFORM verification.append_event(p_case,p_actor,'verification.consent.recorded',v_case.state,(SELECT state FROM verification.verification_case WHERE id=p_case),jsonb_build_object('consent_version',p_version),p_key,p_now);
  PERFORM verification.enqueue_event(p_case,'verification.consent.recorded',p_key,p_now);
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION verification.withdraw_consent(p_actor integer,p_case uuid,p_key text,p_now timestamptz DEFAULT clock_timestamp())
RETURNS verification.case_state LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,verification AS $$
DECLARE v_case verification.verification_case%ROWTYPE; v_next verification.case_state;
BEGIN
  SELECT * INTO v_case FROM verification.verification_case WHERE id=p_case FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'verification case not found' USING ERRCODE='P0002'; END IF;
  IF v_case.subject_user_id IS NULL OR (p_actor<>v_case.subject_user_id AND NOT verification.is_operator(p_actor)) THEN RAISE EXCEPTION 'case subject or operator required' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM verification.decision_event WHERE case_id=p_case AND idempotency_key=p_key) THEN RETURN v_case.state; END IF;
  IF NOT EXISTS(SELECT 1 FROM verification.consent_receipt WHERE case_id=p_case AND withdrawn_at IS NULL AND expires_at>p_now) THEN RAISE EXCEPTION 'active consent not found' USING ERRCODE='23514'; END IF;
  v_next := CASE WHEN v_case.state='verified' THEN 'suspended'::verification.case_state ELSE 'manual_review'::verification.case_state END;
  UPDATE verification.consent_receipt SET withdrawn_at=p_now WHERE case_id=p_case AND withdrawn_at IS NULL AND expires_at>p_now;
  UPDATE verification.verification_case SET state=v_next,verified_at=CASE WHEN v_next='verified'::verification.case_state THEN verified_at ELSE NULL END,updated_at=p_now WHERE id=p_case;
  PERFORM verification.append_event(p_case,p_actor,'verification.consent.withdrawn',v_case.state,v_next,'{}'::jsonb,p_key,p_now);
  PERFORM verification.enqueue_event(p_case,'verification.consent.withdrawn',p_key,p_now);
  RETURN v_next;
END; $$;

CREATE OR REPLACE FUNCTION verification.record_evidence(p_actor integer,p_case uuid,p_kind text,p_object_key text,p_content_type text,p_sha256 text,p_metadata jsonb,p_key text,p_now timestamptz DEFAULT clock_timestamp())
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,verification AS $$
DECLARE v_case verification.verification_case%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO v_case FROM verification.verification_case WHERE id=p_case FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'verification case not found' USING ERRCODE='P0002'; END IF;
  IF v_case.subject_user_id IS NULL OR (p_actor<>v_case.subject_user_id AND NOT verification.is_operator(p_actor)) THEN RAISE EXCEPTION 'case subject or operator required' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM verification.consent_receipt WHERE case_id=p_case AND withdrawn_at IS NULL AND expires_at>p_now) THEN RAISE EXCEPTION 'active consent required' USING ERRCODE='23514'; END IF;
  IF p_kind !~ '^[a-z][a-z0-9_.-]{2,63}$' OR p_object_key !~ '^[A-Za-z0-9][A-Za-z0-9._/-]+$' OR p_content_type NOT IN ('application/pdf','image/jpeg','image/png','image/heic','video/mp4') OR p_sha256 !~ '^[a-f0-9]{64}$' OR jsonb_typeof(p_metadata)<>'object' OR p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid evidence input' USING ERRCODE='22023'; END IF;
  INSERT INTO verification.evidence(case_id,evidence_kind,object_key,content_type,sha256_hex,capture_metadata,supplied_by_user_id,idempotency_key,captured_at)
  VALUES(p_case,p_kind,p_object_key,p_content_type,p_sha256,p_metadata,p_actor,p_key,p_now)
  ON CONFLICT(case_id,idempotency_key) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN SELECT id INTO v_id FROM verification.evidence WHERE case_id=p_case AND idempotency_key=p_key; END IF;
  UPDATE verification.verification_case SET state=CASE WHEN state IN ('initiated','evidence_pending') THEN 'processing'::verification.case_state ELSE state END,updated_at=p_now WHERE id=p_case;
  PERFORM verification.append_event(p_case,p_actor,'verification.evidence.recorded',v_case.state,(SELECT state FROM verification.verification_case WHERE id=p_case),jsonb_build_object('evidence_id',v_id,'kind',p_kind,'sha256_hex',p_sha256),p_key,p_now);
  PERFORM verification.enqueue_event(p_case,'verification.evidence.recorded',p_key,p_now);
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION verification.enqueue_processing(p_actor integer,p_case uuid,p_evidence uuid,p_processor text,p_key text,p_now timestamptz DEFAULT clock_timestamp())
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,verification AS $$
DECLARE v_case verification.verification_case%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO v_case FROM verification.verification_case WHERE id=p_case;
  IF NOT FOUND THEN RAISE EXCEPTION 'verification case not found' USING ERRCODE='P0002'; END IF;
  IF v_case.subject_user_id IS NULL OR (p_actor<>v_case.subject_user_id AND NOT verification.is_operator(p_actor)) THEN RAISE EXCEPTION 'case subject or operator required' USING ERRCODE='42501'; END IF;
  IF p_processor NOT IN ('paddleocr','docling','vlm_document','liveness') OR NOT EXISTS(SELECT 1 FROM verification.evidence WHERE id=p_evidence AND case_id=p_case) THEN RAISE EXCEPTION 'invalid processor job' USING ERRCODE='22023'; END IF;
  INSERT INTO verification.processing_job(case_id,evidence_id,processor,state,next_attempt_at,idempotency_key,created_at,updated_at)
  VALUES(p_case,p_evidence,p_processor,'pending',p_now,p_key,p_now,p_now)
  ON CONFLICT(case_id,evidence_id,processor,idempotency_key) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN SELECT id INTO v_id FROM verification.processing_job WHERE case_id=p_case AND evidence_id=p_evidence AND processor=p_processor AND idempotency_key=p_key; END IF;
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION verification.claim_processing_jobs(p_limit integer DEFAULT 20,p_now timestamptz DEFAULT clock_timestamp())
RETURNS TABLE(job_id uuid,case_id uuid,evidence_id uuid,processor text,evidence_kind text,object_key text,content_type text,sha256_hex text,capture_metadata jsonb,attempt_count integer,claim_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,verification AS $$
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid claim limit' USING ERRCODE='22023'; END IF;
  RETURN QUERY WITH candidates AS (
    SELECT j.id FROM verification.processing_job j
    WHERE ((j.state='pending' AND j.next_attempt_at<=p_now) OR (j.state='claimed' AND j.claim_expires_at<=p_now))
      AND j.attempts<8
    ORDER BY j.next_attempt_at,j.created_at
    FOR UPDATE SKIP LOCKED LIMIT p_limit
  ), claimed AS (
    UPDATE verification.processing_job j SET state='claimed',attempts=j.attempts+1,claim_token=gen_random_uuid(),claim_expires_at=p_now+interval '60 seconds',updated_at=p_now
    FROM candidates c WHERE j.id=c.id
    RETURNING j.*
  )
  SELECT j.id,j.case_id,j.evidence_id,j.processor,e.evidence_kind,e.object_key,e.content_type,e.sha256_hex,e.capture_metadata,j.attempts,j.claim_token
  FROM claimed j JOIN verification.evidence e ON e.id=j.evidence_id;
END; $$;

CREATE OR REPLACE FUNCTION verification.complete_processing_job(p_job uuid,p_token uuid,p_state verification.job_state,p_output_digest text,p_outcome text,p_error text,p_now timestamptz DEFAULT clock_timestamp())
RETURNS verification.job_state LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,verification AS $$
DECLARE v_job verification.processing_job%ROWTYPE; v_case verification.verification_case%ROWTYPE; v_next_attempt timestamptz;
BEGIN
  SELECT * INTO v_job FROM verification.processing_job WHERE id=p_job FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'processing job not found' USING ERRCODE='P0002'; END IF;
  IF v_job.state<>'claimed' OR v_job.claim_token IS DISTINCT FROM p_token OR v_job.claim_expires_at IS NULL OR v_job.claim_expires_at<p_now THEN RAISE EXCEPTION 'stale verification processor claim' USING ERRCODE='55000'; END IF;
  IF p_state NOT IN ('completed','failed','manual_review') OR (p_state IN ('completed','manual_review') AND p_output_digest !~ '^[a-f0-9]{64}$') OR p_outcome !~ '^[a-z][a-z0-9_.-]{2,95}$' OR (p_error IS NOT NULL AND length(p_error)>1000) THEN RAISE EXCEPTION 'invalid processing completion' USING ERRCODE='22023'; END IF;
  IF p_state='failed' AND v_job.attempts<8 THEN
    v_next_attempt:=p_now+make_interval(secs=>LEAST(3600,(2::numeric^v_job.attempts)::integer));
    UPDATE verification.processing_job SET state='pending',next_attempt_at=v_next_attempt,claim_token=NULL,claim_expires_at=NULL,outcome_code=p_outcome,last_error=p_error,updated_at=p_now WHERE id=p_job;
    RETURN 'pending';
  END IF;
  UPDATE verification.processing_job SET state=CASE WHEN p_state='failed' THEN 'manual_review'::verification.job_state ELSE p_state END,claim_token=NULL,claim_expires_at=NULL,output_digest_hex=p_output_digest,outcome_code=p_outcome,last_error=p_error,updated_at=p_now WHERE id=p_job;
  SELECT * INTO v_case FROM verification.verification_case WHERE id=v_job.case_id FOR UPDATE;
  IF p_state IN ('manual_review','failed') THEN
    UPDATE verification.verification_case SET state='manual_review',updated_at=p_now WHERE id=v_case.id AND state NOT IN ('verified','rejected','expired','suspended');
  END IF;
  RETURN CASE WHEN p_state='failed' THEN 'manual_review'::verification.job_state ELSE p_state END;
END; $$;

CREATE OR REPLACE FUNCTION verification.record_provider_check(p_actor integer,p_case uuid,p_check verification.check_type,p_provider text,p_state verification.check_state,p_reference text,p_response_digest text,p_expires timestamptz,p_detail text,p_key text,p_now timestamptz DEFAULT clock_timestamp())
RETURNS verification.check_state LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,verification AS $$
DECLARE v_case verification.verification_case%ROWTYPE;
BEGIN
  IF NOT verification.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_case FROM verification.verification_case WHERE id=p_case FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'verification case not found' USING ERRCODE='P0002'; END IF;
  IF p_provider !~ '^[a-z][a-z0-9_-]{2,63}$' OR p_state NOT IN ('passed','failed','manual_review','unavailable','expired') OR (p_response_digest IS NOT NULL AND p_response_digest !~ '^[a-f0-9]{64}$') OR (p_expires IS NOT NULL AND p_expires<=p_now) OR (p_reference IS NOT NULL AND length(p_reference) NOT BETWEEN 3 AND 200) OR (p_detail IS NOT NULL AND p_detail !~ '^[a-z][a-z0-9_.-]{2,95}$') THEN RAISE EXCEPTION 'invalid provider check' USING ERRCODE='22023'; END IF;
  INSERT INTO verification.provider_check(case_id,check_type,provider_key,state,provider_reference,response_digest_hex,checked_at,expires_at,detail_code,idempotency_key,created_at,updated_at)
  VALUES(p_case,p_check,p_provider,p_state,p_reference,p_response_digest,p_now,p_expires,p_detail,p_key,p_now,p_now)
  ON CONFLICT(case_id,check_type) DO UPDATE SET provider_key=EXCLUDED.provider_key,state=EXCLUDED.state,provider_reference=EXCLUDED.provider_reference,response_digest_hex=EXCLUDED.response_digest_hex,checked_at=EXCLUDED.checked_at,expires_at=EXCLUDED.expires_at,detail_code=EXCLUDED.detail_code,updated_at=EXCLUDED.updated_at;
  UPDATE verification.verification_case SET state=CASE WHEN p_state IN ('failed','manual_review','unavailable','expired') AND state NOT IN ('verified','rejected','expired','suspended') THEN 'manual_review'::verification.case_state ELSE state END,updated_at=p_now WHERE id=p_case;
  PERFORM verification.append_event(p_case,p_actor,'verification.provider_check.recorded',v_case.state,(SELECT state FROM verification.verification_case WHERE id=p_case),jsonb_build_object('check_type',p_check,'state',p_state,'provider_key',p_provider),p_key,p_now);
  PERFORM verification.enqueue_event(p_case,'verification.provider_check.recorded',p_key,p_now);
  RETURN p_state;
END; $$;

CREATE OR REPLACE FUNCTION verification.decide_case(p_actor integer,p_case uuid,p_decision verification.decision,p_reason text,p_expires timestamptz,p_key text,p_now timestamptz DEFAULT clock_timestamp())
RETURNS verification.case_state LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,verification AS $$
DECLARE v_case verification.verification_case%ROWTYPE; v_next verification.case_state;
BEGIN
  IF NOT verification.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_case FROM verification.verification_case WHERE id=p_case FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'verification case not found' USING ERRCODE='P0002'; END IF;
  IF EXISTS(SELECT 1 FROM verification.decision_event WHERE case_id=p_case AND idempotency_key=p_key) THEN RETURN v_case.state; END IF;
  IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'decision reason required' USING ERRCODE='22023'; END IF;
  IF p_decision='verify' THEN
    IF p_expires IS NULL OR p_expires<=p_now OR NOT EXISTS(SELECT 1 FROM verification.consent_receipt WHERE case_id=p_case AND withdrawn_at IS NULL AND expires_at>p_now) THEN RAISE EXCEPTION 'active consent and future expiry required' USING ERRCODE='23514'; END IF;
    IF EXISTS(SELECT 1 FROM unnest(verification.required_checks(v_case.subject_type)) required(check_type) WHERE NOT EXISTS(SELECT 1 FROM verification.provider_check c WHERE c.case_id=p_case AND c.check_type=required.check_type AND c.state='passed' AND (c.expires_at IS NULL OR c.expires_at>p_now))) THEN RAISE EXCEPTION 'required verification checks incomplete' USING ERRCODE='23514'; END IF;
    v_next='verified';
  ELSIF p_decision='reject' THEN v_next='rejected';
  ELSIF p_decision='suspend' THEN v_next='suspended';
  ELSIF p_decision='expire' THEN v_next='expired';
  ELSE RAISE EXCEPTION 'invalid verification decision' USING ERRCODE='22023'; END IF;
  UPDATE verification.verification_case SET state=v_next,decided_by_user_id=p_actor,decision_reason=p_reason,verified_at=CASE WHEN v_next='verified' THEN p_now ELSE NULL END,expires_at=CASE WHEN v_next='verified' THEN p_expires ELSE expires_at END,updated_at=p_now WHERE id=p_case;
  PERFORM verification.append_event(p_case,p_actor,'verification.case.'||v_next::text,v_case.state,v_next,jsonb_build_object('decision',p_decision,'reason',p_reason),p_key,p_now);
  PERFORM verification.enqueue_event(p_case,'verification.case.'||v_next::text,p_key,p_now);
  RETURN v_next;
END; $$;

CREATE OR REPLACE FUNCTION verification.list_cases_for_actor(p_actor integer,p_limit integer DEFAULT 50)
RETURNS TABLE(id uuid,subject_type verification.subject_type,subject_key text,jurisdiction text,purpose text,state verification.case_state,expires_at timestamptz,updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,verification AS $$
  SELECT c.id,c.subject_type,c.subject_key,c.jurisdiction,c.purpose,c.state,c.expires_at,c.updated_at
  FROM verification.verification_case c
  WHERE verification.is_operator(p_actor) OR c.subject_user_id=p_actor
  ORDER BY c.updated_at DESC LIMIT LEAST(GREATEST(p_limit,1),100);
$$;

CREATE OR REPLACE FUNCTION verification.get_case_checks_for_actor(p_actor integer,p_case uuid)
RETURNS TABLE(check_type verification.check_type,state verification.check_state,provider_key text,checked_at timestamptz,expires_at timestamptz,detail_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,verification AS $$
  SELECT c.check_type,c.state,c.provider_key,c.checked_at,c.expires_at,c.detail_code
  FROM verification.provider_check c JOIN verification.verification_case v ON v.id=c.case_id
  WHERE c.case_id=p_case AND (verification.is_operator(p_actor) OR v.subject_user_id=p_actor)
  ORDER BY c.check_type;
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA verification FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA verification FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='switchos_service') THEN
    GRANT USAGE ON SCHEMA verification TO switchos_service;
    GRANT EXECUTE ON FUNCTION verification.start_case(integer,verification.subject_type,text,integer,text,text,text,timestamptz) TO switchos_service;
    GRANT EXECUTE ON FUNCTION verification.record_consent(integer,uuid,text,text,timestamptz,text,timestamptz) TO switchos_service;
    GRANT EXECUTE ON FUNCTION verification.record_evidence(integer,uuid,text,text,text,text,jsonb,text,timestamptz) TO switchos_service;
    GRANT EXECUTE ON FUNCTION verification.withdraw_consent(integer,uuid,text,timestamptz) TO switchos_service;
    GRANT EXECUTE ON FUNCTION verification.enqueue_processing(integer,uuid,uuid,text,text,timestamptz) TO switchos_service;
    GRANT EXECUTE ON FUNCTION verification.claim_processing_jobs(integer,timestamptz) TO switchos_service;
    GRANT EXECUTE ON FUNCTION verification.complete_processing_job(uuid,uuid,verification.job_state,text,text,text,timestamptz) TO switchos_service;
    GRANT EXECUTE ON FUNCTION verification.record_provider_check(integer,uuid,verification.check_type,text,verification.check_state,text,text,timestamptz,text,text,timestamptz) TO switchos_service;
    GRANT EXECUTE ON FUNCTION verification.decide_case(integer,uuid,verification.decision,text,timestamptz,text,timestamptz) TO switchos_service;
    GRANT EXECUTE ON FUNCTION verification.list_cases_for_actor(integer,integer) TO switchos_service;
    GRANT EXECUTE ON FUNCTION verification.get_case_checks_for_actor(integer,uuid) TO switchos_service;
  END IF;
END $$;

COMMIT;
