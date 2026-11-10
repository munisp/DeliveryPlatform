BEGIN;

CREATE TABLE IF NOT EXISTS verification.document_extraction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES verification.verification_case(id) ON DELETE RESTRICT,
  evidence_id uuid NOT NULL REFERENCES verification.evidence(id) ON DELETE RESTRICT,
  model text NOT NULL,
  jev_enabled boolean NOT NULL DEFAULT false,
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  extracted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, evidence_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS verification_document_extraction_case_idx
  ON verification.document_extraction (case_id, extracted_at DESC);

DROP TRIGGER IF EXISTS verification_document_extraction_append_only ON verification.document_extraction;
CREATE TRIGGER verification_document_extraction_append_only BEFORE UPDATE OR DELETE ON verification.document_extraction FOR EACH ROW EXECUTE FUNCTION verification.prevent_append_only_mutation();

CREATE OR REPLACE FUNCTION verification.record_document_extraction(p_actor integer,p_case uuid,p_evidence uuid,p_model text,p_jev_enabled boolean,p_fields jsonb,p_key text,p_now timestamptz DEFAULT clock_timestamp())
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,verification AS $$
DECLARE v_case verification.verification_case%ROWTYPE; v_evidence verification.evidence%ROWTYPE; v_id uuid; v_field jsonb;
BEGIN
  SELECT * INTO v_case FROM verification.verification_case WHERE id=p_case;
  IF NOT FOUND THEN RAISE EXCEPTION 'verification case not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_evidence FROM verification.evidence WHERE id=p_evidence AND case_id=p_case;
  IF NOT FOUND THEN RAISE EXCEPTION 'verification evidence not found' USING ERRCODE='P0002'; END IF;
  IF p_actor<>v_evidence.supplied_by_user_id AND (v_case.subject_user_id IS NULL OR p_actor<>v_case.subject_user_id) AND NOT verification.is_operator(p_actor) THEN RAISE EXCEPTION 'evidence supplier, case subject or operator required' USING ERRCODE='42501'; END IF;
  IF p_model IS NULL OR length(btrim(p_model)) NOT BETWEEN 1 AND 128 OR p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RAISE EXCEPTION 'invalid document extraction input' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p_fields)<>'array' THEN RAISE EXCEPTION 'document extraction fields must be a jsonb array' USING ERRCODE='22023'; END IF;
  FOR v_field IN SELECT element FROM jsonb_array_elements(p_fields) AS element LOOP
    IF jsonb_typeof(v_field)<>'object'
      OR NOT (v_field ? 'field') OR NOT (v_field ? 'value') OR NOT (v_field ? 'confidence') OR NOT (v_field ? 'needsReview')
      OR jsonb_typeof(v_field->'field')<>'string'
      OR length(v_field->>'field') NOT BETWEEN 1 AND 64
      OR (v_field->'value' IS NOT NULL AND jsonb_typeof(v_field->'value')<>'string')
      OR (v_field->'confidence' IS NOT NULL AND (jsonb_typeof(v_field->'confidence')<>'number' OR (v_field->>'confidence')::numeric NOT BETWEEN 0 AND 1))
      OR jsonb_typeof(v_field->'needsReview')<>'boolean'
    THEN RAISE EXCEPTION 'invalid document extraction field shape' USING ERRCODE='22023'; END IF;
  END LOOP;
  INSERT INTO verification.document_extraction(case_id,evidence_id,model,jev_enabled,fields,idempotency_key,extracted_at)
  VALUES(p_case,p_evidence,btrim(p_model),p_jev_enabled,p_fields,p_key,p_now)
  ON CONFLICT(case_id,evidence_id,idempotency_key) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN SELECT id INTO v_id FROM verification.document_extraction WHERE case_id=p_case AND evidence_id=p_evidence AND idempotency_key=p_key; END IF;
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION verification.get_case_extractions(p_actor integer,p_case uuid)
RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,verification AS $$
  SELECT jsonb_build_object(
    'id',d.id,
    'case_id',d.case_id,
    'evidence_id',d.evidence_id,
    'model',d.model,
    'jev_enabled',d.jev_enabled,
    'fields',d.fields,
    'extracted_at',d.extracted_at)
  FROM verification.document_extraction d
  JOIN verification.verification_case v ON v.id=d.case_id
  WHERE d.case_id=p_case
    AND (verification.is_operator(p_actor) OR v.subject_user_id=p_actor OR v.created_by_user_id=p_actor)
  ORDER BY d.extracted_at,d.id;
$$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='switchos_service') THEN
    GRANT EXECUTE ON FUNCTION verification.record_document_extraction(integer,uuid,uuid,text,boolean,jsonb,text,timestamptz) TO switchos_service;
    GRANT EXECUTE ON FUNCTION verification.get_case_extractions(integer,uuid) TO switchos_service;
  END IF;
END $$;

COMMIT;
