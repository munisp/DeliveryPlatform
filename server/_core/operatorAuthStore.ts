import { createHash, randomUUID, scryptSync, timingSafeEqual } from "crypto";

import pg from "pg";

import { ENV } from "./env";

export type OperatorRecord = {
  id: number;
  email: string;
  name: string;
  role: string;
  tenant_id: string | null;
  password_hash: string;
  is_active: boolean;
};

const { Pool } = pg;
let pool: pg.Pool | null = null;

// TLS verification is always on for database connections. The only way to
// disable it is the development-only DATABASE_TLS_SKIP_VERIFY flag, which
// env.ts refuses to honor in production.
function buildDatabaseSsl(useSsl: boolean) {
  if (!useSsl) return false;
  if (ENV.databaseTlsSkipVerify) {
    console.warn(
      "[SECURITY] DATABASE_TLS_SKIP_VERIFY=true: TLS certificate verification is DISABLED for the operator auth database connection. This is a development-only override and is rejected in production.",
    );
    return { rejectUnauthorized: false as const };
  }
  return {
    rejectUnauthorized: true as const,
    ...(ENV.databaseSslCa ? { ca: ENV.databaseSslCa } : {}),
  };
}

export function getOperatorAuthPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      ssl: buildDatabaseSsl(ENV.databaseUrl.includes("sslmode=require")),
      // Bounded satellite pool (perf finding 10).
      max: 5,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
      options: "-c statement_timeout=10000",
    });
  }
  return pool;
}

export function buildOperatorPasswordHash(password: string) {
  const salt = randomUUID().replace(/-/g, "");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyOperatorPassword(password: string, storedHash: string) {
  const [salt, expected] = storedHash.split(":");
  if (!salt || !expected) return false;
  const derived = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  if (derived.length !== expectedBuffer.length) return false;
  return timingSafeEqual(derived, expectedBuffer);
}

export async function ensureOperatorAuthStore() {
  const client = await getOperatorAuthPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS operator_credentials (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(64) NOT NULL DEFAULT 'operator',
        tenant_id VARCHAR(128),
        password_hash TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS operator_security_sessions (
        id UUID PRIMARY KEY,
        operator_id INTEGER NOT NULL REFERENCES operator_credentials(id) ON DELETE CASCADE,
        session_hash CHAR(64) NOT NULL UNIQUE,
        auth_source VARCHAR(32) NOT NULL,
        mfa_authenticated BOOLEAN NOT NULL DEFAULT false,
        assurance_level VARCHAR(128),
        user_agent VARCHAR(512),
        ip_hash CHAR(64),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS operator_security_sessions_operator_lookup
        ON operator_security_sessions (operator_id, revoked_at, expires_at DESC);
    `);

    const existing = await client.query<{ id: number }>(
      `SELECT id FROM operator_credentials WHERE email = $1 LIMIT 1`,
      [ENV.bootstrapOperatorEmail],
    );

    if (existing.rows.length === 0) {
      await client.query(
        `INSERT INTO operator_credentials (email, name, role, tenant_id, password_hash, is_active)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [
          ENV.bootstrapOperatorEmail,
          ENV.bootstrapOperatorName,
          ENV.bootstrapOperatorRole,
          ENV.bootstrapTenantId,
          buildOperatorPasswordHash(ENV.bootstrapOperatorPassword),
        ],
      );
    }
  } finally {
    client.release();
  }
}

function hashSecurityValue(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export type SecuritySessionRecord = {
  id: string;
  auth_source: string;
  mfa_authenticated: boolean;
  assurance_level: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
};

export type SecurityLoginActivityRecord = Pick<SecuritySessionRecord, "id" | "auth_source" | "mfa_authenticated" | "assurance_level" | "user_agent" | "created_at" | "last_seen_at"> & {
  revoked_at: string | null;
};

export async function createOperatorSecuritySession(input: {
  sessionId: string;
  operatorId: number;
  authSource: "managed" | "oidc" | "development";
  mfaAuthenticated: boolean;
  assuranceLevel?: string | null;
  userAgent?: string | null;
  clientIp?: string | null;
  expiresAt: Date;
}) {
  await ensureOperatorAuthStore();
  await getOperatorAuthPool().query(
    `INSERT INTO operator_security_sessions
      (id, operator_id, session_hash, auth_source, mfa_authenticated, assurance_level, user_agent, ip_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [input.sessionId, input.operatorId, hashSecurityValue(input.sessionId), input.authSource, input.mfaAuthenticated, input.assuranceLevel ?? null, input.userAgent?.slice(0, 512) ?? null, input.clientIp ? hashSecurityValue(input.clientIp) : null, input.expiresAt],
  );
}

export async function listOperatorSecuritySessions(operatorId: number): Promise<SecuritySessionRecord[]> {
  await ensureOperatorAuthStore();
  const result = await getOperatorAuthPool().query<SecuritySessionRecord>(
    `SELECT id, auth_source, mfa_authenticated, assurance_level, user_agent, created_at, last_seen_at, expires_at
     FROM operator_security_sessions
     WHERE operator_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
     ORDER BY last_seen_at DESC LIMIT 25`,
    [operatorId],
  );
  return result.rows;
}

/**
 * Session-activity write throttle (perf finding 7): the per-request
 * last_seen_at UPDATE ran on EVERY authenticated call, adding a row write
 * (+ lock/WAL pressure) per request. The write is now throttled to at most
 * once per 60s per session — both in-process (skip the UPDATE entirely when
 * this instance wrote recently) and DB-side (`last_seen_at < now() - interval
 * '60 seconds'`, so multi-instance deployments stay throttled too). When the
 * UPDATE is skipped or matches no row due to the freshness guard, activity is
 * confirmed with a read-only SELECT so revoked/expired sessions are still
 * rejected on every request.
 */
export const OPERATOR_SESSION_LAST_SEEN_THROTTLE_SECONDS = 60;
const lastSeenWriteThrottles = new Map<string, number>();
const LAST_SEEN_THROTTLE_MAP_LIMIT = 10_000;

function pruneLastSeenThrottleMap(now: number) {
  if (lastSeenWriteThrottles.size <= LAST_SEEN_THROTTLE_MAP_LIMIT) return;
  const cutoff = now - OPERATOR_SESSION_LAST_SEEN_THROTTLE_SECONDS * 1000;
  for (const [key, writtenAt] of lastSeenWriteThrottles) {
    if (writtenAt < cutoff) lastSeenWriteThrottles.delete(key);
  }
  // Hard cap: if everything is fresh, drop the oldest half rather than grow
  // without bound.
  if (lastSeenWriteThrottles.size > LAST_SEEN_THROTTLE_MAP_LIMIT) {
    const excess = lastSeenWriteThrottles.size - LAST_SEEN_THROTTLE_MAP_LIMIT / 2;
    let dropped = 0;
    for (const key of lastSeenWriteThrottles.keys()) {
      if (dropped >= excess) break;
      lastSeenWriteThrottles.delete(key);
      dropped += 1;
    }
  }
}

export async function isOperatorSecuritySessionActive(operatorId: number, sessionId: string) {
  await ensureOperatorAuthStore();
  const sessionHash = hashSecurityValue(sessionId);
  const now = Date.now();
  pruneLastSeenThrottleMap(now);
  const lastWriteAt = lastSeenWriteThrottles.get(sessionId) ?? 0;
  if (now - lastWriteAt >= OPERATOR_SESSION_LAST_SEEN_THROTTLE_SECONDS * 1000) {
    const updated = await getOperatorAuthPool().query<{ id: string }>(
      `UPDATE operator_security_sessions SET last_seen_at = NOW()
       WHERE id = $1 AND operator_id = $2 AND session_hash = $3 AND revoked_at IS NULL AND expires_at > NOW()
         AND last_seen_at < NOW() - INTERVAL '60 seconds'
       RETURNING id`,
      [sessionId, operatorId, sessionHash],
    );
    if (updated.rows.length === 1) {
      lastSeenWriteThrottles.set(sessionId, now);
      return true;
    }
    // Zero rows: either the session is inactive/revoked/expired, or another
    // instance refreshed last_seen_at within the last 60s. Distinguish with a
    // read-only confirmation below (and treat a confirmed session as freshly
    // written so this instance stops attempting the UPDATE).
  }
  const active = await getOperatorAuthPool().query<{ id: string }>(
    `SELECT id FROM operator_security_sessions
     WHERE id = $1 AND operator_id = $2 AND session_hash = $3 AND revoked_at IS NULL AND expires_at > NOW()
     LIMIT 1`,
    [sessionId, operatorId, sessionHash],
  );
  const isActive = active.rows.length === 1;
  if (isActive && now - lastWriteAt >= OPERATOR_SESSION_LAST_SEEN_THROTTLE_SECONDS * 1000) {
    // DB-side freshness guard absorbed the write; mirror the throttle locally.
    lastSeenWriteThrottles.set(sessionId, now);
  }
  return isActive;
}

export async function revokeOperatorSecuritySession(operatorId: number, sessionId: string) {
  await ensureOperatorAuthStore();
  const result = await getOperatorAuthPool().query<{ id: string }>(
    `UPDATE operator_security_sessions SET revoked_at = NOW()
     WHERE id = $1 AND operator_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [sessionId, operatorId],
  );
  return result.rows.length === 1;
}

export async function revokeOtherOperatorSecuritySessions(operatorId: number, currentSessionId: string) {
  await ensureOperatorAuthStore();
  const result = await getOperatorAuthPool().query<{ id: string }>(
    `UPDATE operator_security_sessions SET revoked_at = NOW()
     WHERE operator_id = $1 AND id <> $2 AND revoked_at IS NULL AND expires_at > NOW()
     RETURNING id`,
    [operatorId, currentSessionId],
  );
  return result.rows.length;
}

export async function listOperatorSecurityLoginActivity(operatorId: number): Promise<SecurityLoginActivityRecord[]> {
  await ensureOperatorAuthStore();
  const result = await getOperatorAuthPool().query<SecurityLoginActivityRecord>(
    `SELECT id, auth_source, mfa_authenticated, assurance_level, user_agent, created_at, last_seen_at, revoked_at
     FROM operator_security_sessions
     WHERE operator_id = $1
     ORDER BY created_at DESC LIMIT 50`,
    [operatorId],
  );
  return result.rows;
}

export async function authenticateOperator(email: string, password: string) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || !password) return null;

  const result = await getOperatorAuthPool().query<OperatorRecord>(
    `SELECT id, email, name, role, tenant_id, password_hash, is_active
     FROM operator_credentials
     WHERE LOWER(email) = $1
     LIMIT 1`,
    [normalizedEmail],
  );

  const operator = result.rows[0];
  if (!operator || !operator.is_active) {
    return null;
  }

  if (!verifyOperatorPassword(password, operator.password_hash)) {
    return null;
  }

  return {
    id: operator.id,
    email: operator.email,
    name: operator.name,
    role: operator.role,
    tenantId: operator.tenant_id,
  };
}

/**
 * Provision (or refresh) an operator row for an EXTERNAL OIDC identity.
 *
 * Fail-closed provisioning (Audit A P0-3): a brand-new external identity is
 * provisioned with `is_active = false` and NO `email_verified_at` — the
 * upstream IdP assertion alone is no longer enough to enter the operator
 * console. Access is granted only after an existing operator approves the
 * account via approveExternalOperator (operatorMutationProcedure
 * "write_platform"). The conflict path deliberately does NOT flip is_active
 * or stamp email_verified_at, so re-login can neither re-activate a
 * deactivated account nor self-verify an email; accounts already active
 * (bootstrap/managed/previously approved) keep their state.
 */
export async function ensureExternalOperator(input: { email: string; name: string; tenantId: string | null }) {
  const email = input.email.trim().toLowerCase();
  if (!email) throw new Error("external_identity_missing_email");
  await ensureOperatorAuthStore();
  const result = await getOperatorAuthPool().query<OperatorRecord>(
    `INSERT INTO operator_credentials (email, name, role, tenant_id, password_hash, is_active)
     VALUES ($1, $2, 'operator', $3, $4, false)
     ON CONFLICT (email) DO UPDATE SET
       name = EXCLUDED.name,
       tenant_id = COALESCE(operator_credentials.tenant_id, EXCLUDED.tenant_id),
       updated_at = NOW()
     RETURNING id, email, name, role, tenant_id, password_hash, is_active`,
    [email, input.name.trim() || email, input.tenantId, buildOperatorPasswordHash(randomUUID())],
  );
  const operator = result.rows[0];
  return {
    id: operator.id,
    email: operator.email,
    name: operator.name,
    role: operator.role,
    tenantId: operator.tenant_id,
    isActive: operator.is_active,
  };
}

/**
 * Approve an externally-provisioned operator. Flips is_active and stamps
 * email_verified_at (approval IS the verification event for OIDC accounts —
 * the platform never sent its own verification email). Returns null when the
 * operator id does not exist.
 */
export async function approveExternalOperator(operatorId: number) {
  await ensureOperatorAuthStore();
  const result = await getOperatorAuthPool().query<OperatorRecord>(
    `UPDATE operator_credentials
     SET is_active = true,
         email_verified_at = COALESCE(email_verified_at, NOW()),
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, email, name, role, tenant_id, is_active`,
    [operatorId],
  );
  const operator = result.rows[0];
  if (!operator) return null;
  return {
    id: operator.id,
    email: operator.email,
    name: operator.name,
    role: operator.role,
    tenantId: operator.tenant_id,
    isActive: operator.is_active,
  };
}
