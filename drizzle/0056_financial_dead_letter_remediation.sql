-- Financial dead-letter remediation is a new intent, never a replay or mutation
-- of a terminal outbox row. Apply after 0055_tigerbeetle_batch_outbox.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS public.mojaloop_dead_letter_case (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id bigint NOT NULL UNIQUE REFERENCES public.mojaloop_funds_outbox(id) ON DELETE RESTRICT,
  original_workflow_id text NOT NULL,
  original_transfer_id text NOT NULL REFERENCES public.mojaloop_transfers(transfer_id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('open','approval_pending','rejected','replacement_intent_created')),
  opened_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  opened_reason text NOT NULL CHECK (length(btrim(opened_reason)) BETWEEN 3 AND 1000),
  investigation_digest_hex text NOT NULL CHECK (investigation_digest_hex ~ '^[a-f0-9]{64}$'),
  opened_idempotency_key text NOT NULL CHECK (opened_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  requested_by_user_id integer REFERENCES public.users(id) ON DELETE RESTRICT,
  requested_at timestamptz,
  request_reason text CHECK (request_reason IS NULL OR length(btrim(request_reason)) BETWEEN 3 AND 1000),
  reconciliation_reference text CHECK (reconciliation_reference IS NULL OR reconciliation_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/.-]{2,199}$'),
  reconciliation_digest_hex text CHECK (reconciliation_digest_hex IS NULL OR reconciliation_digest_hex ~ '^[a-f0-9]{64}$'),
  ledger_disposition text CHECK (ledger_disposition IS NULL OR ledger_disposition IN ('confirmed_not_committed','committed','uncertain','unavailable')),
  replacement_transfer_id text UNIQUE,
  replacement_ilp_packet text,
  replacement_condition text,
  replacement_expiration timestamptz,
  request_idempotency_key text UNIQUE,
  approval_idempotency_key text UNIQUE,
  approved_by_user_id integer REFERENCES public.users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  rejected_by_user_id integer REFERENCES public.users(id) ON DELETE RESTRICT,
  rejected_at timestamptz,
  rejection_reason text CHECK (rejection_reason IS NULL OR length(btrim(rejection_reason)) BETWEEN 3 AND 1000),
  remediation_outbox_id bigint UNIQUE REFERENCES public.mojaloop_funds_outbox(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (state IN ('approval_pending','replacement_intent_created') AND requested_by_user_id IS NOT NULL
      AND requested_at IS NOT NULL AND request_reason IS NOT NULL
      AND reconciliation_reference IS NOT NULL AND reconciliation_digest_hex IS NOT NULL
      AND ledger_disposition IS NOT NULL AND replacement_transfer_id IS NOT NULL
      AND request_idempotency_key IS NOT NULL
      AND replacement_ilp_packet IS NOT NULL AND replacement_condition IS NOT NULL
      AND replacement_expiration IS NOT NULL)
    OR state IN ('open','rejected')
  ),
  CHECK (
    (state = 'replacement_intent_created' AND approved_by_user_id IS NOT NULL
      AND approved_at IS NOT NULL AND approval_idempotency_key IS NOT NULL
      AND approved_by_user_id IS DISTINCT FROM requested_by_user_id
      AND ledger_disposition = 'confirmed_not_committed')
    OR state <> 'replacement_intent_created'
  ),
  CHECK (
    (state = 'rejected' AND rejected_by_user_id IS NOT NULL AND rejected_at IS NOT NULL
      AND rejection_reason IS NOT NULL)
    OR state <> 'rejected'
  ),
  CHECK (
    (state = 'replacement_intent_created' AND remediation_outbox_id IS NOT NULL)
    OR state <> 'replacement_intent_created'
  )
);

CREATE INDEX IF NOT EXISTS idx_mojaloop_dead_letter_case_state_updated
  ON public.mojaloop_dead_letter_case (state, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.mojaloop_dead_letter_case_event (
  id bigserial PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES public.mojaloop_dead_letter_case(id) ON DELETE RESTRICT,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{2,95}$'),
  previous_state text,
  next_state text NOT NULL,
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object'),
  detail_digest bytea NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (case_id, sequence_no),
  UNIQUE (case_id, idempotency_key)
);

CREATE OR REPLACE FUNCTION public.mojaloop_prevent_dead_letter_case_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'financial dead-letter evidence is append only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS mojaloop_dead_letter_case_event_append_only ON public.mojaloop_dead_letter_case_event;
CREATE TRIGGER mojaloop_dead_letter_case_event_append_only
  BEFORE UPDATE OR DELETE ON public.mojaloop_dead_letter_case_event
  FOR EACH ROW EXECUTE FUNCTION public.mojaloop_prevent_dead_letter_case_event_mutation();

CREATE OR REPLACE FUNCTION public.mojaloop_is_financial_administrator(p_user_id integer)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users
    WHERE id = p_user_id
      AND role::text IN ('admin','platform_admin','super_admin')
  );
$$;

CREATE OR REPLACE FUNCTION public.mojaloop_append_dead_letter_case_event(
  p_case uuid,
  p_actor integer,
  p_action text,
  p_previous_state text,
  p_next_state text,
  p_detail jsonb,
  p_idempotency_key text,
  p_now timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_sequence integer;
BEGIN
  SELECT coalesce(max(sequence_no), 0) + 1
    INTO v_sequence
    FROM public.mojaloop_dead_letter_case_event
   WHERE case_id = p_case;

  INSERT INTO public.mojaloop_dead_letter_case_event (
    case_id, sequence_no, actor_user_id, action, previous_state, next_state,
    detail, detail_digest, idempotency_key, created_at
  ) VALUES (
    p_case, v_sequence, p_actor, p_action, p_previous_state, p_next_state,
    p_detail,
    public.digest(convert_to(p_detail::text, 'UTF8'), 'sha256'),
    p_idempotency_key, p_now
  ) ON CONFLICT (case_id, idempotency_key) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.mojaloop_open_dead_letter_case(
  p_actor integer,
  p_outbox_id bigint,
  p_reason text,
  p_investigation_digest_hex text,
  p_idempotency_key text,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_outbox public.mojaloop_funds_outbox%ROWTYPE;
  v_case_id uuid;
  v_existing_open_idempotency_key text;
BEGIN
  IF NOT public.mojaloop_is_financial_administrator(p_actor) THEN
    RAISE EXCEPTION 'financial administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000
     OR p_investigation_digest_hex !~ '^[a-f0-9]{64}$'
     OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN
    RAISE EXCEPTION 'invalid dead-letter case input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_outbox
    FROM public.mojaloop_funds_outbox
   WHERE id = p_outbox_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dead-letter outbox row not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_outbox.status <> 'dead_letter'
     OR v_outbox.destination <> 'tigerbeetle'
     OR v_outbox.workflow_type <> 'transfer' THEN
    RAISE EXCEPTION 'only TigerBeetle transfer dead-letter rows are remediable' USING ERRCODE = '23514';
  END IF;

  SELECT id, opened_idempotency_key
    INTO v_case_id, v_existing_open_idempotency_key
    FROM public.mojaloop_dead_letter_case
   WHERE outbox_id = v_outbox.id
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing_open_idempotency_key = p_idempotency_key THEN
      RETURN v_case_id;
    END IF;
    RAISE EXCEPTION 'a dead-letter case already exists for this outbox row' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.mojaloop_dead_letter_case (
    outbox_id, original_workflow_id, original_transfer_id, state,
    opened_by_user_id, opened_reason, investigation_digest_hex,
    opened_idempotency_key, created_at, updated_at
  ) VALUES (
    v_outbox.id, v_outbox.workflow_id, v_outbox.resource_id, 'open',
    p_actor, p_reason, p_investigation_digest_hex, p_idempotency_key, p_now, p_now
  ) RETURNING id INTO v_case_id;

  PERFORM public.mojaloop_append_dead_letter_case_event(
    v_case_id, p_actor, 'financial.dead_letter.opened', NULL, 'open',
    jsonb_build_object('outbox_id', v_outbox.id, 'workflow_id', v_outbox.workflow_id,
      'investigation_digest_hex', p_investigation_digest_hex),
    p_idempotency_key, p_now
  );
  INSERT INTO public.mojaloop_workflow_events (
    workflow_id, workflow_type, resource_id, step, status, payload, created_at
  ) VALUES (
    v_outbox.workflow_id, v_outbox.workflow_type, v_outbox.resource_id,
    'ledger_dead_letter_review_opened', 'PENDING',
    jsonb_build_object('case_id', v_case_id, 'outbox_id', v_outbox.id), p_now
  );
  RETURN v_case_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.mojaloop_request_dead_letter_remediation(
  p_actor integer,
  p_case uuid,
  p_reason text,
  p_ledger_disposition text,
  p_reconciliation_reference text,
  p_reconciliation_digest_hex text,
  p_replacement_transfer_id text,
  p_replacement_ilp_packet text,
  p_replacement_condition text,
  p_replacement_expiration timestamptz,
  p_idempotency_key text,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_case public.mojaloop_dead_letter_case%ROWTYPE;
  v_outbox public.mojaloop_funds_outbox%ROWTYPE;
BEGIN
  IF NOT public.mojaloop_is_financial_administrator(p_actor) THEN
    RAISE EXCEPTION 'financial administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000
     OR p_ledger_disposition NOT IN ('confirmed_not_committed','committed','uncertain','unavailable')
     OR p_reconciliation_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:/.-]{2,199}$'
     OR p_reconciliation_digest_hex !~ '^[a-f0-9]{64}$'
     OR p_replacement_transfer_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$'
     OR p_replacement_ilp_packet IS NULL OR length(p_replacement_ilp_packet) NOT BETWEEN 3 AND 16384
     OR p_replacement_condition !~ '^[A-Za-z0-9_-]{16,255}$'
     OR p_replacement_expiration <= p_now + interval '60 seconds'
     OR p_replacement_expiration > p_now + interval '24 hours'
     OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN
    RAISE EXCEPTION 'invalid remediation request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_case
    FROM public.mojaloop_dead_letter_case
   WHERE id = p_case
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dead-letter case not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_case.state NOT IN ('open','rejected') THEN
    IF v_case.requested_by_user_id = p_actor AND v_case.request_idempotency_key = p_idempotency_key THEN
      RETURN v_case.state;
    END IF;
    RAISE EXCEPTION 'dead-letter case is not requestable' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_outbox
    FROM public.mojaloop_funds_outbox
   WHERE id = v_case.outbox_id
   FOR UPDATE;
  IF v_outbox.status <> 'dead_letter' THEN
    RAISE EXCEPTION 'original outbox row is no longer terminal' USING ERRCODE = '23514';
  END IF;
  IF p_ledger_disposition <> 'confirmed_not_committed' THEN
    RAISE EXCEPTION 'only confirmed-not-committed transfers may request a replacement' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mojaloop_transfers WHERE transfer_id = p_replacement_transfer_id) THEN
    RAISE EXCEPTION 'replacement transfer identity already exists' USING ERRCODE = '23505';
  END IF;

  UPDATE public.mojaloop_dead_letter_case
     SET state = 'approval_pending',
         requested_by_user_id = p_actor,
         requested_at = p_now,
         request_reason = p_reason,
         reconciliation_reference = p_reconciliation_reference,
         reconciliation_digest_hex = p_reconciliation_digest_hex,
         ledger_disposition = p_ledger_disposition,
         replacement_transfer_id = p_replacement_transfer_id,
         replacement_ilp_packet = p_replacement_ilp_packet,
         replacement_condition = p_replacement_condition,
         replacement_expiration = p_replacement_expiration,
         request_idempotency_key = p_idempotency_key,
         approved_by_user_id = NULL,
         approved_at = NULL,
         approval_idempotency_key = NULL,
         rejected_by_user_id = NULL,
         rejected_at = NULL,
         rejection_reason = NULL,
         updated_at = p_now
   WHERE id = p_case;

  PERFORM public.mojaloop_append_dead_letter_case_event(
    p_case, p_actor, 'financial.dead_letter.remediation_requested',
    v_case.state, 'approval_pending',
    jsonb_build_object('ledger_disposition', p_ledger_disposition,
      'reconciliation_reference', p_reconciliation_reference,
      'reconciliation_digest_hex', p_reconciliation_digest_hex,
      'replacement_transfer_id', p_replacement_transfer_id),
    p_idempotency_key, p_now
  );
  INSERT INTO public.mojaloop_workflow_events (
    workflow_id, workflow_type, resource_id, step, status, payload, created_at
  ) VALUES (
    v_case.original_workflow_id, 'transfer', v_case.original_transfer_id,
    'ledger_remediation_approval_pending', 'PENDING',
    jsonb_build_object('case_id', p_case, 'replacement_transfer_id', p_replacement_transfer_id), p_now
  );
  RETURN 'approval_pending';
END;
$$;

CREATE OR REPLACE FUNCTION public.mojaloop_approve_dead_letter_remediation(
  p_actor integer,
  p_case uuid,
  p_approval_reason text,
  p_idempotency_key text,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (case_id uuid, replacement_transfer_id text, remediation_outbox_id bigint, state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_case public.mojaloop_dead_letter_case%ROWTYPE;
  v_outbox public.mojaloop_funds_outbox%ROWTYPE;
  v_original public.mojaloop_transfers%ROWTYPE;
  v_new_outbox_id bigint;
BEGIN
  IF NOT public.mojaloop_is_financial_administrator(p_actor) THEN
    RAISE EXCEPTION 'financial administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_approval_reason IS NULL OR length(btrim(p_approval_reason)) NOT BETWEEN 3 AND 1000
     OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN
    RAISE EXCEPTION 'invalid remediation approval' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_case
    FROM public.mojaloop_dead_letter_case
   WHERE id = p_case
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dead-letter case not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_case.state = 'replacement_intent_created' AND v_case.approval_idempotency_key = p_idempotency_key THEN
    RETURN QUERY SELECT v_case.id, v_case.replacement_transfer_id, v_case.remediation_outbox_id, v_case.state;
    RETURN;
  END IF;
  IF v_case.state <> 'approval_pending'
     OR v_case.requested_by_user_id IS NULL
     OR v_case.requested_by_user_id = p_actor
     OR v_case.ledger_disposition <> 'confirmed_not_committed' THEN
    RAISE EXCEPTION 'independent second approval required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_outbox
    FROM public.mojaloop_funds_outbox
   WHERE id = v_case.outbox_id
   FOR UPDATE;
  SELECT * INTO v_original
    FROM public.mojaloop_transfers
   WHERE transfer_id = v_case.original_transfer_id
   FOR UPDATE;
  IF v_outbox.status <> 'dead_letter'
     OR v_original.state = 'COMMITTED'
     OR EXISTS (SELECT 1 FROM public.mojaloop_transfers WHERE transfer_id = v_case.replacement_transfer_id) THEN
    RAISE EXCEPTION 'replacement preconditions failed' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.mojaloop_transfers (
    transfer_id, payer_fsp, payee_fsp, amount, currency, ilp_packet,
    condition, expiration, state, amount_minor, created_at, updated_at
  ) VALUES (
    v_case.replacement_transfer_id, v_original.payer_fsp, v_original.payee_fsp,
    v_original.amount, v_original.currency, v_case.replacement_ilp_packet,
    v_case.replacement_condition, v_case.replacement_expiration, 'PENDING',
    v_original.amount_minor, p_now, p_now
  );
  INSERT INTO public.mojaloop_workflows (
    workflow_id, workflow_type, resource_id, current_step, status, created_at, updated_at
  ) VALUES (
    v_case.replacement_transfer_id, 'transfer', v_case.replacement_transfer_id,
    'remediation_requested', 'PENDING', p_now, p_now
  );
  INSERT INTO public.mojaloop_workflow_events (
    workflow_id, workflow_type, resource_id, step, status, payload, created_at
  ) VALUES (
    v_case.replacement_transfer_id, 'transfer', v_case.replacement_transfer_id,
    'remediation_intent_created', 'PENDING',
    jsonb_build_object('case_id', p_case, 'original_transfer_id', v_case.original_transfer_id,
      'approver_user_id', p_actor), p_now
  );
  INSERT INTO public.mojaloop_funds_outbox (
    event_id, destination, idempotency_key, workflow_id, workflow_type, resource_id,
    step, workflow_status, payload, dispatch_order, status, attempt_count,
    next_attempt_at, ledger_debit_fsp, created_at, updated_at
  ) VALUES (
    'ledger-remediation:' || p_case::text,
    'tigerbeetle',
    'ledger-remediation:' || p_case::text,
    v_case.replacement_transfer_id, 'transfer', v_case.replacement_transfer_id,
    'transfer_prepare', 'PENDING',
    jsonb_build_object('amountMinor', v_original.amount_minor,
      'payerFsp', v_original.payer_fsp, 'payeeFsp', v_original.payee_fsp,
      'originalTransferId', v_case.original_transfer_id, 'remediationCaseId', p_case),
    10, 'pending', 0, p_now, v_original.payer_fsp, p_now, p_now
  ) RETURNING id INTO v_new_outbox_id;

  UPDATE public.mojaloop_dead_letter_case
     SET state = 'replacement_intent_created', approved_by_user_id = p_actor, approved_at = p_now,
         approval_idempotency_key = p_idempotency_key,
         remediation_outbox_id = v_new_outbox_id, updated_at = p_now
   WHERE id = p_case;
  PERFORM public.mojaloop_append_dead_letter_case_event(
    p_case, p_actor, 'financial.dead_letter.remediation_approved',
    'approval_pending', 'replacement_intent_created',
    jsonb_build_object('replacement_transfer_id', v_case.replacement_transfer_id,
      'remediation_outbox_id', v_new_outbox_id, 'approval_reason', p_approval_reason),
    p_idempotency_key, p_now
  );
  INSERT INTO public.mojaloop_workflow_events (
    workflow_id, workflow_type, resource_id, step, status, payload, created_at
  ) VALUES (
    v_case.original_workflow_id, 'transfer', v_case.original_transfer_id,
    'ledger_remediation_approved', 'PENDING',
    jsonb_build_object('case_id', p_case, 'replacement_transfer_id', v_case.replacement_transfer_id,
      'remediation_outbox_id', v_new_outbox_id), p_now
  );
  RETURN QUERY SELECT p_case, v_case.replacement_transfer_id, v_new_outbox_id, 'replacement_intent_created'::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.mojaloop_reject_dead_letter_remediation(
  p_actor integer,
  p_case uuid,
  p_reason text,
  p_idempotency_key text,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE v_case public.mojaloop_dead_letter_case%ROWTYPE;
BEGIN
  IF NOT public.mojaloop_is_financial_administrator(p_actor) THEN
    RAISE EXCEPTION 'financial administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000
     OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN
    RAISE EXCEPTION 'invalid remediation rejection' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_case FROM public.mojaloop_dead_letter_case WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dead-letter case not found' USING ERRCODE = 'P0002'; END IF;
  IF v_case.state <> 'approval_pending' THEN RAISE EXCEPTION 'dead-letter case is not pending approval' USING ERRCODE = '55000'; END IF;
  IF v_case.requested_by_user_id = p_actor THEN RAISE EXCEPTION 'requester cannot reject own remediation' USING ERRCODE = '42501'; END IF;
  UPDATE public.mojaloop_dead_letter_case
     SET state='rejected', rejected_by_user_id=p_actor, rejected_at=p_now,
         rejection_reason=p_reason, updated_at=p_now
   WHERE id=p_case;
  PERFORM public.mojaloop_append_dead_letter_case_event(
    p_case,p_actor,'financial.dead_letter.remediation_rejected','approval_pending','rejected',
    jsonb_build_object('reason',p_reason),p_idempotency_key,p_now
  );
  RETURN 'rejected';
END;
$$;

CREATE OR REPLACE FUNCTION public.mojaloop_list_dead_letter_cases(p_actor integer,p_limit integer DEFAULT 50)
RETURNS TABLE (
  case_id uuid, outbox_id bigint, original_transfer_id text, state text,
  opened_by_user_id integer, requested_by_user_id integer, approved_by_user_id integer,
  ledger_disposition text, replacement_transfer_id text, remediation_outbox_id bigint,
  last_error text, attempt_count integer, created_at timestamptz, updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT c.id,c.outbox_id,c.original_transfer_id,c.state,c.opened_by_user_id,
         c.requested_by_user_id,c.approved_by_user_id,c.ledger_disposition,
         c.replacement_transfer_id,c.remediation_outbox_id,o.last_error,o.attempt_count,
         c.created_at,c.updated_at
  FROM public.mojaloop_dead_letter_case c
  JOIN public.mojaloop_funds_outbox o ON o.id=c.outbox_id
  WHERE public.mojaloop_is_financial_administrator(p_actor)
  ORDER BY c.updated_at DESC
  LIMIT LEAST(GREATEST(p_limit,1),100);
$$;

REVOKE ALL ON public.mojaloop_dead_letter_case FROM PUBLIC;
REVOKE ALL ON public.mojaloop_dead_letter_case_event FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mojaloop_prevent_dead_letter_case_event_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mojaloop_is_financial_administrator(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mojaloop_append_dead_letter_case_event(uuid,integer,text,text,text,jsonb,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mojaloop_open_dead_letter_case(integer,bigint,text,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mojaloop_request_dead_letter_remediation(integer,uuid,text,text,text,text,text,text,text,timestamptz,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mojaloop_approve_dead_letter_remediation(integer,uuid,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mojaloop_reject_dead_letter_remediation(integer,uuid,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mojaloop_list_dead_letter_cases(integer,integer) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'switchos_service') THEN
    GRANT EXECUTE ON FUNCTION public.mojaloop_open_dead_letter_case(integer,bigint,text,text,text,timestamptz) TO switchos_service;
    GRANT EXECUTE ON FUNCTION public.mojaloop_request_dead_letter_remediation(integer,uuid,text,text,text,text,text,text,text,timestamptz,text,timestamptz) TO switchos_service;
    GRANT EXECUTE ON FUNCTION public.mojaloop_approve_dead_letter_remediation(integer,uuid,text,text,timestamptz) TO switchos_service;
    GRANT EXECUTE ON FUNCTION public.mojaloop_reject_dead_letter_remediation(integer,uuid,text,text,timestamptz) TO switchos_service;
    GRANT EXECUTE ON FUNCTION public.mojaloop_list_dead_letter_cases(integer,integer) TO switchos_service;
  END IF;
END;
$$;

INSERT INTO public.platform_schema_contracts (component, version)
VALUES ('mojaloop_funds', 9)
ON CONFLICT (component) DO UPDATE
SET version = GREATEST(public.platform_schema_contracts.version, EXCLUDED.version),
    applied_at = NOW();

COMMIT;
