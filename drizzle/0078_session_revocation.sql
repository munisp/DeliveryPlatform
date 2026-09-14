-- Session revocation list (M-2).
--
-- Logout previously only cleared the client cookie: the signed session JWT
-- remained valid until expiry, so a copied token could be replayed after
-- "logout". This table records revoked session ids (the JWT `jti`, which
-- issueOperatorSession sets to the operator security session id) so the
-- session-validation middleware can reject revoked tokens server-side.
--
-- Append-only: rows are never updated, only inserted (ON CONFLICT DO
-- NOTHING on replayed logout) and lazily deleted once expires_at has
-- passed (the token is expired anyway, so the revocation is dead weight).
-- session_id is TEXT (not UUID) because externally-issued OIDC JWTs may
-- carry non-UUID jti values.
--
-- operator_security_sessions (drizzle/0017) already exists but is keyed by
-- operator credential and only covers managed operator sessions; this table
-- is credential-agnostic and keyed purely by the token id.
CREATE TABLE IF NOT EXISTS public.session_revocations (
  session_id TEXT PRIMARY KEY,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  reason VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS session_revocations_expires_at_idx
  ON public.session_revocations (expires_at);
