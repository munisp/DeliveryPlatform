DROP INDEX IF EXISTS account_lifecycle_invitation_revocation_lookup;
DROP TABLE IF EXISTS tenant_branding_presets;
ALTER TABLE account_lifecycle_tokens DROP COLUMN IF EXISTS revoked_at;
