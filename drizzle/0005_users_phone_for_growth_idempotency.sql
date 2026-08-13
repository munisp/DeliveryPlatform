-- Required by referral, campaign audience, and durable idempotency flows.
-- Safe for existing installations because the new field is nullable.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
