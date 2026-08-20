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

export function getOperatorAuthPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      ssl: ENV.databaseUrl.includes("sslmode=require") ? { rejectUnauthorized: false } : false,
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

export async function isOperatorSecuritySessionActive(operatorId: number, sessionId: string) {
  await ensureOperatorAuthStore();
  const result = await getOperatorAuthPool().query<{ id: string }>(
    `UPDATE operator_security_sessions SET last_seen_at = NOW()
     WHERE id = $1 AND operator_id = $2 AND session_hash = $3 AND revoked_at IS NULL AND expires_at > NOW()
     RETURNING id`,
    [sessionId, operatorId, hashSecurityValue(sessionId)],
  );
  return result.rows.length === 1;
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

export async function ensureExternalOperator(input: { email: string; name: string; tenantId: string | null }) {
  const email = input.email.trim().toLowerCase();
  if (!email) throw new Error("external_identity_missing_email");
  await ensureOperatorAuthStore();
  const result = await getOperatorAuthPool().query<OperatorRecord>(
    `INSERT INTO operator_credentials (email, name, role, tenant_id, password_hash, is_active, email_verified_at)
     VALUES ($1, $2, 'operator', $3, $4, true, NOW())
     ON CONFLICT (email) DO UPDATE SET
       name = EXCLUDED.name,
       tenant_id = COALESCE(operator_credentials.tenant_id, EXCLUDED.tenant_id),
       is_active = true,
       email_verified_at = COALESCE(operator_credentials.email_verified_at, NOW()),
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
  };
}
