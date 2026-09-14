-- Merchant GA onboarding checklist completion signal. PostgreSQL remains the
-- authority: the server records onboarding_completed_at the first time the
-- derived checklist observes every item done. Idempotent via IF NOT EXISTS.
ALTER TABLE commerce.merchant_portal
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;

CREATE INDEX IF NOT EXISTS merchant_portal_onboarding_pending_idx
  ON commerce.merchant_portal (provider_id)
  WHERE onboarding_completed_at IS NULL;
