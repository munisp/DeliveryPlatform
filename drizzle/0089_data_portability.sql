-- Data transparency + portability (R14).
-- Workers can request a signed export of their work record. The export row
-- keeps the canonical payload, its sha256 hash and the platform signature
-- (ed25519 via the Rust work-record-signer, services/rust/work-record-signer)
-- so the record is verifiable offline. Status walks pending -> signed ->
-- delivered; an operator can revoke a compromised export. The signer being
-- down never loses the export: it stays 'pending' and can be re-signed.
-- data_transparency_disclosures is the per-category ledger of what the
-- platform holds about a worker (R14 transparency requirement).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.work_record_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  payload jsonb,
  payload_hash text,
  signature text,
  signer_key_id text,
  signer_public_key text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'signed', 'delivered', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  signed_at timestamptz,
  CHECK (period_end > period_start)
);
CREATE INDEX IF NOT EXISTS work_record_exports_user_idx
  ON public.work_record_exports (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.data_transparency_disclosures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  category text NOT NULL CHECK (category IN ('profile', 'trips', 'earnings', 'ratings', 'safety', 'device', 'other')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  disclosed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS data_transparency_disclosures_user_category_idx
  ON public.data_transparency_disclosures (user_id, category);
