-- Financial identifiers are immutable once recorded. State and timestamps may
-- progress, but no path may rewrite a party, amount, currency, or linkage.
CREATE OR REPLACE FUNCTION mojaloop_reject_financial_identity_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_TABLE_NAME = 'mojaloop_transfers' THEN
	  IF OLD.payer_fsp IS DISTINCT FROM NEW.payer_fsp
	    OR OLD.payee_fsp IS DISTINCT FROM NEW.payee_fsp
	    OR OLD.amount IS DISTINCT FROM NEW.amount
	    OR OLD.amount_minor IS DISTINCT FROM NEW.amount_minor
      OR OLD.currency IS DISTINCT FROM NEW.currency
      OR OLD.ilp_packet IS DISTINCT FROM NEW.ilp_packet
      OR OLD.condition IS DISTINCT FROM NEW.condition
      OR OLD.expiration IS DISTINCT FROM NEW.expiration THEN
      RAISE EXCEPTION 'mojaloop transfer financial identity is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'mojaloop_quotes' THEN
	IF OLD.transaction_id IS DISTINCT FROM NEW.transaction_id
	  OR OLD.payer_fsp IS DISTINCT FROM NEW.payer_fsp
	  OR OLD.payee_fsp IS DISTINCT FROM NEW.payee_fsp
	  OR OLD.amount IS DISTINCT FROM NEW.amount
	  OR OLD.amount_minor IS DISTINCT FROM NEW.amount_minor
	  OR OLD.fees IS DISTINCT FROM NEW.fees
	  OR OLD.fees_minor IS DISTINCT FROM NEW.fees_minor
      OR OLD.currency IS DISTINCT FROM NEW.currency
      OR OLD.expiration IS DISTINCT FROM NEW.expiration THEN
      RAISE EXCEPTION 'mojaloop quote financial identity is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'mojaloop_refunds' THEN
	IF OLD.original_transfer_id IS DISTINCT FROM NEW.original_transfer_id
	  OR OLD.payer_fsp IS DISTINCT FROM NEW.payer_fsp
	  OR OLD.payee_fsp IS DISTINCT FROM NEW.payee_fsp
	  OR OLD.amount IS DISTINCT FROM NEW.amount
	  OR OLD.amount_minor IS DISTINCT FROM NEW.amount_minor
      OR OLD.currency IS DISTINCT FROM NEW.currency
      OR OLD.reason IS DISTINCT FROM NEW.reason THEN
      RAISE EXCEPTION 'mojaloop refund financial identity is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mojaloop_transfer_identity_immutable ON mojaloop_transfers;
CREATE TRIGGER trg_mojaloop_transfer_identity_immutable
  BEFORE UPDATE ON mojaloop_transfers
  FOR EACH ROW EXECUTE FUNCTION mojaloop_reject_financial_identity_rewrite();

DROP TRIGGER IF EXISTS trg_mojaloop_quote_identity_immutable ON mojaloop_quotes;
CREATE TRIGGER trg_mojaloop_quote_identity_immutable
  BEFORE UPDATE ON mojaloop_quotes
  FOR EACH ROW EXECUTE FUNCTION mojaloop_reject_financial_identity_rewrite();

DROP TRIGGER IF EXISTS trg_mojaloop_refund_identity_immutable ON mojaloop_refunds;
CREATE TRIGGER trg_mojaloop_refund_identity_immutable
  BEFORE UPDATE ON mojaloop_refunds
  FOR EACH ROW EXECUTE FUNCTION mojaloop_reject_financial_identity_rewrite();
