-- Read-only financial outbox readiness for operational metrics and autoscaling.
-- It deliberately returns aggregate work classes only: no FSP, workflow, transfer,
-- payment, recipient, or financial amount leaves PostgreSQL through this function.

CREATE OR REPLACE FUNCTION public.mojaloop_outbox_autoscaling_metrics(
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE(
  work_class text,
  ready_units bigint,
  oldest_ready_seconds bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH classes(work_class) AS (
    VALUES
      ('general_workflow'::text),
      ('ledger_transfer_lane'::text),
      ('ledger_refund'::text)
  ),
  general_ready AS (
    SELECT o.created_at,
      CASE
        WHEN o.destination = 'tigerbeetle' AND o.workflow_type = 'refund'
          THEN 'ledger_refund'::text
        ELSE 'general_workflow'::text
      END AS work_class
    FROM public.mojaloop_funds_outbox AS o
    WHERE o.status = 'pending'
      AND o.next_attempt_at <= p_now
      AND NOT (o.destination = 'tigerbeetle' AND o.workflow_type = 'transfer')
      AND NOT EXISTS (
        SELECT 1
        FROM public.mojaloop_funds_outbox AS predecessor
        WHERE predecessor.workflow_id = o.workflow_id
          AND predecessor.dispatch_order < o.dispatch_order
          AND predecessor.status <> 'delivered'
      )
  ),
  -- One ready unit is one eligible debit/FSP lane, rather than every transfer
  -- in that lane. Later transfers remain blocked by ordered settlement.
  ledger_ready AS (
    SELECT o.created_at, 'ledger_transfer_lane'::text AS work_class
    FROM public.mojaloop_funds_outbox AS o
    WHERE o.destination = 'tigerbeetle'
      AND o.workflow_type = 'transfer'
      AND (
        (o.status = 'pending' AND o.next_attempt_at <= p_now)
        OR (o.status = 'processing' AND o.claim_expires_at <= p_now)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.mojaloop_funds_outbox AS earlier
        WHERE earlier.destination = 'tigerbeetle'
          AND earlier.workflow_type = 'transfer'
          AND earlier.ledger_debit_fsp = o.ledger_debit_fsp
          AND earlier.id < o.id
          AND earlier.status <> 'delivered'
      )
  ),
  ready AS (
    SELECT * FROM general_ready
    UNION ALL
    SELECT * FROM ledger_ready
  ),
  aggregate_ready AS (
    SELECT
      work_class,
      count(*)::bigint AS ready_units,
      coalesce(greatest(0, extract(epoch FROM p_now - min(created_at)))::bigint, 0)
        AS oldest_ready_seconds
    FROM ready
    GROUP BY work_class
  )
  SELECT
    classes.work_class,
    coalesce(aggregate_ready.ready_units, 0)::bigint,
    coalesce(aggregate_ready.oldest_ready_seconds, 0)::bigint
  FROM classes
  LEFT JOIN aggregate_ready USING (work_class)
  ORDER BY classes.work_class;
$$;

REVOKE ALL ON FUNCTION public.mojaloop_outbox_autoscaling_metrics(timestamptz) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'switchos_service') THEN
    GRANT EXECUTE ON FUNCTION public.mojaloop_outbox_autoscaling_metrics(timestamptz)
      TO switchos_service;
  END IF;
END $$;
