import { getOperatorAuthPool } from "./operatorAuthStore";

/**
 * Server-side session revocation (M-2).
 *
 * Logout (and any future admin/security action) inserts the session's JWT
 * id (jti) into `public.session_revocations`; the session-validation
 * middleware rejects any token whose jti is listed, so clearing the cookie
 * is no longer the only thing standing between a stolen token and the API.
 *
 * Storage is the platform Postgres (authoritative DDL:
 * drizzle/0078_session_revocation.sql). No shared Redis client is wired in
 * this service today (the rate limiter keeps its own private connection),
 * so lookups go to the database behind a short in-process TTL cache that
 * bounds the per-request cost; revokeSession updates the local cache
 * synchronously so a logout is effective immediately on the serving
 * process. Rows whose expires_at has passed are dead weight (the token
 * itself is expired) and are deleted lazily.
 */

const REVOCATION_CACHE_TTL_MS = 15_000;
const CLEANUP_INTERVAL_MS = 10 * 60_000;

type RevocationCacheEntry = {
  revoked: boolean;
  checkedAt: number;
};

const revocationCache = new Map<string, RevocationCacheEntry>();
let lastCleanupAt = 0;
let ensurePromise: Promise<void> | null = null;

export function ensureSessionRevocationStore(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await getOperatorAuthPool().query(`
        CREATE TABLE IF NOT EXISTS public.session_revocations (
          session_id TEXT PRIMARY KEY,
          revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL,
          reason VARCHAR(64)
        );
        CREATE INDEX IF NOT EXISTS session_revocations_expires_at_idx
          ON public.session_revocations (expires_at);
      `);
    })().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  return ensurePromise;
}

function pruneCache(now: number) {
  if (revocationCache.size < 1024) return;
  for (const [key, entry] of revocationCache) {
    if (now - entry.checkedAt > REVOCATION_CACHE_TTL_MS) {
      revocationCache.delete(key);
    }
  }
}

async function cleanupExpiredRevocations(now: number) {
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  try {
    await getOperatorAuthPool().query(
      `DELETE FROM public.session_revocations WHERE expires_at < NOW()`,
    );
  } catch (error) {
    console.warn("[SwitchOS] Failed to clean expired session revocations", error);
  }
}

export async function revokeSession(input: {
  sessionId: string;
  expiresAt: Date;
  reason?: string | null;
}): Promise<void> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) return;
  await ensureSessionRevocationStore();
  await getOperatorAuthPool().query(
    `INSERT INTO public.session_revocations (session_id, expires_at, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_id) DO NOTHING`,
    [sessionId, input.expiresAt, input.reason ?? null],
  );
  const now = Date.now();
  // Only cache live revocations: an entry whose expires_at has already
  // passed is a no-op (the token is expired anyway) and must not be served
  // from the cache as "revoked".
  if (input.expiresAt.getTime() > now) {
    revocationCache.set(sessionId, { revoked: true, checkedAt: now });
  } else {
    revocationCache.delete(sessionId);
  }
  pruneCache(now);
  await cleanupExpiredRevocations(now);
}

export async function isSessionRevoked(sessionId: string): Promise<boolean> {
  const key = sessionId.trim();
  if (!key) return false;
  const now = Date.now();
  const cached = revocationCache.get(key);
  if (cached && now - cached.checkedAt < REVOCATION_CACHE_TTL_MS) {
    return cached.revoked;
  }
  await ensureSessionRevocationStore();
  const result = await getOperatorAuthPool().query<{ session_id: string }>(
    `SELECT session_id FROM public.session_revocations
     WHERE session_id = $1 AND expires_at > NOW()
     LIMIT 1`,
    [key],
  );
  const revoked = result.rows.length > 0;
  revocationCache.set(key, { revoked, checkedAt: now });
  pruneCache(now);
  return revoked;
}
