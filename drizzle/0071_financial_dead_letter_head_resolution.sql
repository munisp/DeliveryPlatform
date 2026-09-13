-- Maker-checker resolution authority for dead-letter head-of-line barriers.
--
-- This migration does not rewrite the original dead_letter row. It records an
-- append-only, evidence-bound approval that the predecessor gate may recognize
-- for one specific dead-letter outbox row. Apply after 0055, 0056, and 0070.

BEGIN;

CREATE TABLE IF NOT EXISTS public.mojaloop_dead_letter_head_resolution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL UNIQUE REFERENCES public.mojaloop_dead_letter_case(id) ON DELETE RESTRICT,
  original_outbox_id bigint NOT NULL UNIQUE REFERENCES public.mojaloop_funds_outbox(id) ON DELETE RESTRICT,
  resolution_disposition text NOT NULL CHECK (
    resolution_disposition IN (
      'original_confirmed_committed_resolved',
      'original_confirmed_not_committed_superseded'
    )
  ),
  state text NOT NULL CHECK (state IN ('approval_pending','approved','rejected')),
  requested_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL,
  request_reason text NOT NULL CHECK (length(btrim(request_reason)) BETWEEN 3 AND 1000),
  reconciliation_reference text NOT NULL CHECK (reconciliation_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/.-]{2,199}$'),
  reconciliation_digest_hex text NOT NULL CHECK (reconciliation_digest_hex ~ '^[a-f0-9]{64}$'),
  request_idempotency_key text NOT NULL UNIQUE CHECK (request_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  approved_by_user_id integer REFERENCES public.users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  approval_reason text CHECK (approval_reason IS NULL OR length(btrim(approval_reason)) BETWEEN 3 AND 1000),
  approval_idempotency_key text UNIQUE CHECK (approval_idempotency_key IS NULL OR approval_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  rejected_by_user_id integer REFERENCES public.users(id) ON DELETE RESTRICT,
  rejected_at timestamptz,
  rejection_reason text CHECK (rejection_reason IS NULL OR length(btrim(rejection_reason)) BETWEEN 3 AND 1000),
  rejection_idempotency_key text UNIQUE CHECK (rejection_idempotency_key IS NULL OR rejection_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (state = 'approved'
      AND approved_by_user_id IS NOT NULL
      AND approved_at IS NOT NULL
      AND approval_reason IS NOT NULL
      AND approval_idempotency_key IS NOT NULL
      AND approved_by_user_id IS DISTINCT FROM requested_by_user_id)
    OR state <> 'approved'
  ),
  CHECK (
    (state = 'rejected'
      AND rejected_by_user_id IS NOT NULL
      AND rejected_at IS NOT NULL
      AND rejection_reason IS NOT NULL
      AND rejection_idempotency_key IS NOT NULL
      AND rejected_by_user_id IS DISTINCT FROM requested_by_user_id)
    OR state <> 'rejected'
  ),
  CHECK (
    state = 'approval_pending'
    OR (approved_by_user_id IS NOT NULL) <> (rejected_by_user_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_mojaloop_dead_letter_head_resolution_approved
  ON public.mojaloop_dead_letter_head_resolution (original_outbox_id)
  WHERE state = 'approved';

CREATE UNIQUE INDEX IF NOT EXISTS idx_mojaloop_dead_letter_case_remediation_outbox
  ON public.mojaloop_dead_letter_case (remediation_outbox_id)
  WHERE remediation_outbox_id IS NOT NULL;

-- The predecessor claimant may use only this authority function. It returns
-- true only for an approved resolution for the precise original outbox row.
CREATE OR REPLACE FUNCTION public.mojaloop_dead_letter_head_is_resolved(p_outbox_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.mojaloop_dead_letter_head_resolution AS resolution
    WHERE resolution.original_outbox_id = p_outbox_id
      AND resolution.state = 'approved'
  );
$$;

-- A committed original may release successors after approval. A superseded
-- original may release only its approved replacement; later ordinary rows stay
-- blocked until that replacement is delivered. Absence of an approved authority
-- is always a blocker.
CREATE OR REPLACE FUNCTION public.mojaloop_dead_letter_predecessor_blocks(
  p_earlier_outbox_id bigint,
  p_candidate_outbox_id bigint
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_resolution public.mojaloop_dead_letter_head_resolution%ROWTYPE;
  v_case public.mojaloop_dead_letter_case%ROWTYPE;
  v_replacement_status text;
BEGIN
  -- A specifically approved replacement logically occupies the original head's
  -- place. It may pass physical rows created after that head, but it can never
  -- pass an unresolved row that predates the original dead-letter record.
  SELECT dead_letter_case.* INTO v_case
  FROM public.mojaloop_dead_letter_head_resolution AS candidate_resolution
  JOIN public.mojaloop_dead_letter_case AS dead_letter_case
    ON dead_letter_case.id = candidate_resolution.case_id
  WHERE candidate_resolution.state = 'approved'
    AND candidate_resolution.resolution_disposition = 'original_confirmed_not_committed_superseded'
    AND dead_letter_case.remediation_outbox_id = p_candidate_outbox_id;
  IF FOUND AND p_earlier_outbox_id > v_case.outbox_id THEN
    RETURN false;
  END IF;

  SELECT * INTO v_resolution
  FROM public.mojaloop_dead_letter_head_resolution
  WHERE original_outbox_id = p_earlier_outbox_id
    AND state = 'approved';
  IF NOT FOUND THEN
    RETURN true;
  END IF;
  IF v_resolution.resolution_disposition = 'original_confirmed_committed_resolved' THEN
    RETURN false;
  END IF;
  IF v_resolution.resolution_disposition <> 'original_confirmed_not_committed_superseded' THEN
    RETURN true;
  END IF;

  SELECT * INTO v_case FROM public.mojaloop_dead_letter_case WHERE id = v_resolution.case_id;
  IF NOT FOUND OR v_case.remediation_outbox_id IS NULL THEN
    RETURN true;
  END IF;
  IF v_case.remediation_outbox_id = p_candidate_outbox_id THEN
    RETURN false;
  END IF;
  SELECT status INTO v_replacement_status
  FROM public.mojaloop_funds_outbox
  WHERE id = v_case.remediation_outbox_id;
  RETURN v_replacement_status IS DISTINCT FROM 'delivered';
END;
$$;

CREATE OR REPLACE FUNCTION public.mojaloop_request_dead_letter_head_resolution(
  p_actor integer,
  p_case uuid,
  p_resolution_disposition text,
  p_reason text,
  p_reconciliation_reference text,
  p_reconciliation_digest_hex text,
  p_idempotency_key text,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (resolution_id uuid, state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_case public.mojaloop_dead_letter_case%ROWTYPE;
  v_outbox public.mojaloop_funds_outbox%ROWTYPE;
  v_resolution public.mojaloop_dead_letter_head_resolution%ROWTYPE;
BEGIN
  IF NOT public.mojaloop_is_financial_administrator(p_actor) THEN
    RAISE EXCEPTION 'financial administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_resolution_disposition NOT IN ('original_confirmed_committed_resolved','original_confirmed_not_committed_superseded')
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000
     OR p_reconciliation_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:/.-]{2,199}$'
     OR p_reconciliation_digest_hex !~ '^[a-f0-9]{64}$'
     OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN
    RAISE EXCEPTION 'invalid dead-letter head resolution request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_case FROM public.mojaloop_dead_letter_case WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dead-letter case not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_outbox FROM public.mojaloop_funds_outbox WHERE id = v_case.outbox_id FOR UPDATE;
  IF NOT FOUND OR v_outbox.status <> 'dead_letter'
     OR v_outbox.destination <> 'tigerbeetle' OR v_outbox.workflow_type <> 'transfer' THEN
    RAISE EXCEPTION 'head resolution requires original TigerBeetle transfer dead letter' USING ERRCODE = '23514';
  END IF;

  IF p_resolution_disposition = 'original_confirmed_not_committed_superseded'
     AND (v_case.state <> 'replacement_intent_created'
       OR v_case.ledger_disposition <> 'confirmed_not_committed'
       OR v_case.remediation_outbox_id IS NULL) THEN
    RAISE EXCEPTION 'supersession requires approved confirmed-not-committed replacement intent' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_resolution
  FROM public.mojaloop_dead_letter_head_resolution
  WHERE case_id = p_case
  FOR UPDATE;
  IF FOUND THEN
    IF v_resolution.state = 'approved' THEN
      IF v_resolution.requested_by_user_id = p_actor
         AND v_resolution.request_idempotency_key = p_idempotency_key THEN
        RETURN QUERY SELECT v_resolution.id, v_resolution.state;
        RETURN;
      END IF;
      RAISE EXCEPTION 'dead-letter head is already resolved' USING ERRCODE = '55000';
    END IF;
    IF v_resolution.state = 'approval_pending' THEN
      IF v_resolution.requested_by_user_id = p_actor
         AND v_resolution.request_idempotency_key = p_idempotency_key THEN
        RETURN QUERY SELECT v_resolution.id, v_resolution.state;
        RETURN;
      END IF;
      RAISE EXCEPTION 'dead-letter head resolution is already pending approval' USING ERRCODE = '55000';
    END IF;

    UPDATE public.mojaloop_dead_letter_head_resolution
       SET resolution_disposition = p_resolution_disposition,
           state = 'approval_pending',
           requested_by_user_id = p_actor,
           requested_at = p_now,
           request_reason = p_reason,
           reconciliation_reference = p_reconciliation_reference,
           reconciliation_digest_hex = p_reconciliation_digest_hex,
           request_idempotency_key = p_idempotency_key,
           approved_by_user_id = NULL,
           approved_at = NULL,
           approval_reason = NULL,
           approval_idempotency_key = NULL,
           rejected_by_user_id = NULL,
           rejected_at = NULL,
           rejection_reason = NULL,
           rejection_idempotency_key = NULL,
           updated_at = p_now
     WHERE id = v_resolution.id
     RETURNING * INTO v_resolution;
  ELSE
    INSERT INTO public.mojaloop_dead_letter_head_resolution (
      case_id, original_outbox_id, resolution_disposition, state,
      requested_by_user_id, requested_at, request_reason,
      reconciliation_reference, reconciliation_digest_hex,
      request_idempotency_key, created_at, updated_at
    ) VALUES (
      p_case, v_case.outbox_id, p_resolution_disposition, 'approval_pending',
      p_actor, p_now, p_reason, p_reconciliation_reference,
      p_reconciliation_digest_hex, p_idempotency_key, p_now, p_now
    ) RETURNING * INTO v_resolution;
  END IF;

  PERFORM public.mojaloop_append_dead_letter_case_event(
    p_case, p_actor, 'financial.dead_letter.head_resolution_requested',
    v_case.state, v_case.state,
    jsonb_build_object(
      'resolution_id', v_resolution.id,
      'resolution_disposition', p_resolution_disposition,
      'reconciliation_reference', p_reconciliation_reference,
      'reconciliation_digest_hex', p_reconciliation_digest_hex
    ),
    p_idempotency_key, p_now
  );
  INSERT INTO public.mojaloop_workflow_events (
    workflow_id, workflow_type, resource_id, step, status, payload, created_at
  ) VALUES (
    v_case.original_workflow_id, 'transfer', v_case.original_transfer_id,
    'ledger_dead_letter_head_resolution_pending', 'PENDING',
    jsonb_build_object('case_id', p_case, 'resolution_id', v_resolution.id,
      'resolution_disposition', p_resolution_disposition), p_now
  );
  RETURN QUERY SELECT v_resolution.id, v_resolution.state;
END;
$$;

CREATE OR REPLACE FUNCTION public.mojaloop_approve_dead_letter_head_resolution(
  p_actor integer,
  p_case uuid,
  p_reason text,
  p_idempotency_key text,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (resolution_id uuid, state text, resolution_disposition text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_case public.mojaloop_dead_letter_case%ROWTYPE;
  v_outbox public.mojaloop_funds_outbox%ROWTYPE;
  v_resolution public.mojaloop_dead_letter_head_resolution%ROWTYPE;
BEGIN
  IF NOT public.mojaloop_is_financial_administrator(p_actor) THEN
    RAISE EXCEPTION 'financial administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000
     OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN
    RAISE EXCEPTION 'invalid dead-letter head resolution approval' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_case FROM public.mojaloop_dead_letter_case WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dead-letter case not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_resolution
  FROM public.mojaloop_dead_letter_head_resolution
  WHERE case_id = p_case
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dead-letter head resolution not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_resolution.state = 'approved'
     AND v_resolution.approved_by_user_id = p_actor
     AND v_resolution.approval_idempotency_key = p_idempotency_key THEN
    RETURN QUERY SELECT v_resolution.id, v_resolution.state, v_resolution.resolution_disposition;
    RETURN;
  END IF;
  IF v_resolution.state <> 'approval_pending'
     OR v_resolution.requested_by_user_id = p_actor THEN
    RAISE EXCEPTION 'independent second approval required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_outbox FROM public.mojaloop_funds_outbox WHERE id = v_case.outbox_id FOR UPDATE;
  IF NOT FOUND OR v_outbox.status <> 'dead_letter' THEN
    RAISE EXCEPTION 'original dead-letter outbox row is no longer terminal' USING ERRCODE = '23514';
  END IF;
  IF v_resolution.resolution_disposition = 'original_confirmed_not_committed_superseded'
     AND (v_case.ledger_disposition <> 'confirmed_not_committed'
       OR v_case.state <> 'replacement_intent_created'
       OR v_case.remediation_outbox_id IS NULL) THEN
    RAISE EXCEPTION 'head resolution preconditions changed' USING ERRCODE = '23514';
  END IF;

  UPDATE public.mojaloop_dead_letter_head_resolution
     SET state = 'approved', approved_by_user_id = p_actor, approved_at = p_now,
         approval_reason = p_reason, approval_idempotency_key = p_idempotency_key,
         updated_at = p_now
   WHERE id = v_resolution.id
   RETURNING * INTO v_resolution;
  PERFORM public.mojaloop_append_dead_letter_case_event(
    p_case, p_actor, 'financial.dead_letter.head_resolution_approved',
    v_case.state, v_case.state,
    jsonb_build_object('resolution_id', v_resolution.id,
      'resolution_disposition', v_resolution.resolution_disposition,
      'approval_reason', p_reason),
    p_idempotency_key, p_now
  );
  INSERT INTO public.mojaloop_workflow_events (
    workflow_id, workflow_type, resource_id, step, status, payload, created_at
  ) VALUES (
    v_case.original_workflow_id, 'transfer', v_case.original_transfer_id,
    'ledger_dead_letter_head_resolution_approved', 'PENDING',
    jsonb_build_object('case_id', p_case, 'resolution_id', v_resolution.id,
      'resolution_disposition', v_resolution.resolution_disposition), p_now
  );
  RETURN QUERY SELECT v_resolution.id, v_resolution.state, v_resolution.resolution_disposition;
END;
$$;

CREATE OR REPLACE FUNCTION public.mojaloop_reject_dead_letter_head_resolution(
  p_actor integer,
  p_case uuid,
  p_reason text,
  p_idempotency_key text,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (resolution_id uuid, state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_case public.mojaloop_dead_letter_case%ROWTYPE;
  v_resolution public.mojaloop_dead_letter_head_resolution%ROWTYPE;
BEGIN
  IF NOT public.mojaloop_is_financial_administrator(p_actor) THEN
    RAISE EXCEPTION 'financial administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000
     OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN
    RAISE EXCEPTION 'invalid dead-letter head resolution rejection' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_case FROM public.mojaloop_dead_letter_case WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dead-letter case not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_resolution FROM public.mojaloop_dead_letter_head_resolution WHERE case_id = p_case FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dead-letter head resolution not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_resolution.state = 'rejected'
     AND v_resolution.rejected_by_user_id = p_actor
     AND v_resolution.rejection_idempotency_key = p_idempotency_key THEN
    RETURN QUERY SELECT v_resolution.id, v_resolution.state;
    RETURN;
  END IF;
  IF v_resolution.state <> 'approval_pending'
     OR v_resolution.requested_by_user_id = p_actor THEN
    RAISE EXCEPTION 'independent second rejection required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.mojaloop_dead_letter_head_resolution
     SET state = 'rejected', rejected_by_user_id = p_actor, rejected_at = p_now,
         rejection_reason = p_reason, rejection_idempotency_key = p_idempotency_key,
         updated_at = p_now
   WHERE id = v_resolution.id
   RETURNING * INTO v_resolution;
  PERFORM public.mojaloop_append_dead_letter_case_event(
    p_case, p_actor, 'financial.dead_letter.head_resolution_rejected',
    v_case.state, v_case.state,
    jsonb_build_object('resolution_id', v_resolution.id, 'rejection_reason', p_reason),
    p_idempotency_key, p_now
  );
  RETURN QUERY SELECT v_resolution.id, v_resolution.state;
END;
$$;

CREATE OR REPLACE FUNCTION public.mojaloop_get_dead_letter_head_resolution(
  p_actor integer,
  p_case uuid
)
RETURNS TABLE (
  resolution_id uuid,
  original_outbox_id bigint,
  resolution_disposition text,
  state text,
  requested_by_user_id integer,
  requested_at timestamptz,
  approved_by_user_id integer,
  approved_at timestamptz,
  rejected_by_user_id integer,
  rejected_at timestamptz,
  reconciliation_reference text,
  reconciliation_digest_hex text,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT public.mojaloop_is_financial_administrator(p_actor) THEN
    RAISE EXCEPTION 'financial administrator required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT resolution.id, resolution.original_outbox_id,
         resolution.resolution_disposition, resolution.state,
         resolution.requested_by_user_id, resolution.requested_at,
         resolution.approved_by_user_id, resolution.approved_at,
         resolution.rejected_by_user_id, resolution.rejected_at,
         resolution.reconciliation_reference, resolution.reconciliation_digest_hex,
         resolution.updated_at
  FROM public.mojaloop_dead_letter_head_resolution AS resolution
  WHERE resolution.case_id = p_case;
END;
$$;

REVOKE ALL ON public.mojaloop_dead_letter_head_resolution FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mojaloop_dead_letter_head_is_resolved(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mojaloop_dead_letter_predecessor_blocks(bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mojaloop_get_dead_letter_head_resolution(integer,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mojaloop_request_dead_letter_head_resolution(integer,uuid,text,text,text,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mojaloop_approve_dead_letter_head_resolution(integer,uuid,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mojaloop_reject_dead_letter_head_resolution(integer,uuid,text,text,timestamptz) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'switchos_service') THEN
    GRANT EXECUTE ON FUNCTION public.mojaloop_dead_letter_head_is_resolved(bigint) TO switchos_service;
    GRANT EXECUTE ON FUNCTION public.mojaloop_dead_letter_predecessor_blocks(bigint,bigint) TO switchos_service;
    GRANT EXECUTE ON FUNCTION public.mojaloop_get_dead_letter_head_resolution(integer,uuid) TO switchos_service;
    GRANT EXECUTE ON FUNCTION public.mojaloop_request_dead_letter_head_resolution(integer,uuid,text,text,text,text,text,timestamptz) TO switchos_service;
    GRANT EXECUTE ON FUNCTION public.mojaloop_approve_dead_letter_head_resolution(integer,uuid,text,text,timestamptz) TO switchos_service;
    GRANT EXECUTE ON FUNCTION public.mojaloop_reject_dead_letter_head_resolution(integer,uuid,text,text,timestamptz) TO switchos_service;
  END IF;
END;
$$;

INSERT INTO public.platform_schema_contracts (component, version)
VALUES ('mojaloop_funds', 10)
ON CONFLICT (component) DO UPDATE
SET version = GREATEST(public.platform_schema_contracts.version, EXCLUDED.version),
    applied_at = NOW();

COMMIT;
