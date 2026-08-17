-- Reversible teardown for an isolated rollback rehearsal only.
DROP TABLE IF EXISTS account_lifecycle_tokens;
DROP TABLE IF EXISTS organization_memberships;
DROP TABLE IF EXISTS platform_tenants;
DROP TABLE IF EXISTS organizations;
ALTER TABLE operator_credentials
  DROP COLUMN IF EXISTS onboarding_completed_at,
  DROP COLUMN IF EXISTS email_verified_at;
