BEGIN;

-- The forensic processor emits bounded risk evidence only. It never changes a case
-- state directly and is not a substitute for issuer verification or human review.
ALTER TABLE verification.processing_job
  DROP CONSTRAINT IF EXISTS processing_job_processor_check;
ALTER TABLE verification.processing_job
  ADD CONSTRAINT processing_job_processor_check
  CHECK (processor IN ('paddleocr','docling','vlm_document','liveness','document_forensics'));

CREATE OR REPLACE FUNCTION verification.enqueue_processing(
  p_actor integer,
  p_case uuid,
  p_evidence uuid,
  p_processor text,
  p_key text,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,verification
AS $$
DECLARE
  v_case verification.verification_case%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO v_case
  FROM verification.verification_case
  WHERE id=p_case;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'verification case not found' USING ERRCODE='P0002';
  END IF;
  IF v_case.subject_user_id IS NULL
     OR (p_actor<>v_case.subject_user_id AND NOT verification.is_operator(p_actor)) THEN
    RAISE EXCEPTION 'case subject or operator required' USING ERRCODE='42501';
  END IF;
  IF p_processor NOT IN ('paddleocr','docling','vlm_document','liveness','document_forensics')
     OR NOT EXISTS (
       SELECT 1 FROM verification.evidence
       WHERE id=p_evidence AND case_id=p_case
     ) THEN
    RAISE EXCEPTION 'invalid processor job' USING ERRCODE='22023';
  END IF;

  INSERT INTO verification.processing_job(
    case_id,evidence_id,processor,state,next_attempt_at,idempotency_key,created_at,updated_at
  )
  VALUES(p_case,p_evidence,p_processor,'pending',p_now,p_key,p_now,p_now)
  ON CONFLICT(case_id,evidence_id,processor,idempotency_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id
    FROM verification.processing_job
    WHERE case_id=p_case
      AND evidence_id=p_evidence
      AND processor=p_processor
      AND idempotency_key=p_key;
  END IF;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION verification.enqueue_processing(integer,uuid,uuid,text,text,timestamptz) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='switchos_service') THEN
    GRANT EXECUTE ON FUNCTION verification.enqueue_processing(integer,uuid,uuid,text,text,timestamptz)
      TO switchos_service;
  END IF;
END
$$;

COMMIT;
