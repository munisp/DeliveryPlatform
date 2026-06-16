import { randomUUID, scryptSync, timingSafeEqual } from "crypto";

import pg from "pg";

import { ENV } from "./env";

type OperatorRecord = {
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

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      ssl: ENV.databaseUrl.includes("sslmode=require") ? { rejectUnauthorized: false } : false,
    });
  }
  return pool;
}

function buildPasswordHash(password: string) {
  const salt = randomUUID().replace(/-/g, "");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

function verifyPassword(password: string, storedHash: string) {
  const [salt, expected] = storedHash.split(":");
  if (!salt || !expected) return false;
  const derived = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  if (derived.length !== expectedBuffer.length) return false;
  return timingSafeEqual(derived, expectedBuffer);
}

export async function ensureOperatorAuthStore() {
  const client = await getPool().connect();
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
          buildPasswordHash(ENV.bootstrapOperatorPassword),
        ],
      );
    }
  } finally {
    client.release();
  }
}

export async function authenticateOperator(email: string, password: string) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || !password) return null;

  const result = await getPool().query<OperatorRecord>(
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

  if (!verifyPassword(password, operator.password_hash)) {
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
