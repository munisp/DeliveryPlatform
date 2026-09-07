\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  deadline_at timestamptz := clock_timestamp() + interval '30 minutes';
  pending_webhooks bigint;
BEGIN
  LOOP
    SELECT COUNT(*)
      INTO pending_webhooks
      FROM mobility.provider_webhook_event
     WHERE signature_valid = true
       AND processed_at IS NULL;

    EXIT WHEN pending_webhooks = 0;
    IF clock_timestamp() >= deadline_at THEN
      RAISE EXCEPTION 'webhook verification queue did not drain within 30 minutes; pending=%', pending_webhooks;
    END IF;
    PERFORM pg_sleep(5);
  END LOOP;
END;
$$;

DO $$
DECLARE
  duplicate_pending_offers bigint;
  duplicate_live_assignments bigint;
  unbalanced_ledger_transactions bigint;
  unverified_money_transitions bigint;
  webhook_processing_errors bigint;
BEGIN
  SELECT COUNT(*)
    INTO duplicate_pending_offers
    FROM (
      SELECT driver_user_id
        FROM mobility.driver_offer
       WHERE state = 'pending'
       GROUP BY driver_user_id
      HAVING COUNT(*) > 1
    ) AS duplicate_offer_driver;

  SELECT COUNT(*)
    INTO duplicate_live_assignments
    FROM (
      SELECT driver_user_id
        FROM mobility.driver_assignment_guard
       WHERE state IN ('reserved', 'en_route', 'arrived', 'on_trip')
       GROUP BY driver_user_id
      HAVING COUNT(*) > 1
    ) AS duplicate_assignment_driver;

  SELECT COUNT(*)
    INTO unbalanced_ledger_transactions
    FROM (
      SELECT transaction_id
        FROM mobility.ledger_posting
       GROUP BY transaction_id
      HAVING COALESCE(SUM(amount_kobo) FILTER (WHERE direction = 'debit'), 0) = 0
          OR COALESCE(SUM(amount_kobo) FILTER (WHERE direction = 'debit'), 0)
             <> COALESCE(SUM(amount_kobo) FILTER (WHERE direction = 'credit'), 0)
    ) AS unbalanced_transaction;

  SELECT COUNT(*)
    INTO unverified_money_transitions
    FROM mobility.provider_payment
   WHERE state IN ('captured', 'settled')
     AND verified_at IS NULL;

  SELECT COUNT(*)
    INTO webhook_processing_errors
    FROM mobility.provider_webhook_event
   WHERE signature_valid = true
     AND processing_error IS NOT NULL;

  IF duplicate_pending_offers <> 0
     OR duplicate_live_assignments <> 0
     OR unbalanced_ledger_transactions <> 0
     OR unverified_money_transitions <> 0
     OR webhook_processing_errors <> 0 THEN
    RAISE EXCEPTION
      'resilience invariants failed: duplicate_pending_offers=%, duplicate_live_assignments=%, unbalanced_ledger_transactions=%, unverified_money_transitions=%, webhook_processing_errors=%',
      duplicate_pending_offers,
      duplicate_live_assignments,
      unbalanced_ledger_transactions,
      unverified_money_transitions,
      webhook_processing_errors;
  END IF;
END;
$$;

SELECT 'resilience_invariant_probe=PASS' AS result;
COMMIT;
