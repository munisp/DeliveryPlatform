import { createHash, randomBytes, randomUUID } from "crypto";
import type { PoolClient } from "pg";

import { ENV } from "./env";
import { sendEmail } from "./notificationGateway";
import {
  buildOperatorPasswordHash,
  ensureOperatorAuthStore,
  getOperatorAuthPool,
  type OperatorRecord,
} from "./operatorAuthStore";

export type LifecyclePurpose = "email_verification" | "password_reset" | "invitation";
export type LifecycleRole = "admin" | "operator" | "viewer";

type LifecycleTokenRow = {
  id: string;
  purpose: LifecyclePurpose;
  email: string;
  operator_id: number | null;
  organization_id: string | null;
  tenant_id: string | null;
  role: LifecycleRole | null;
  expires_at: Date;
};

export type LifecycleOperator = {
  id: number;
  email: string;
  name: string;
  role: LifecycleRole;
  tenantId: string | null;
  emailVerified: boolean;
  onboardingCompleted: boolean;
};

const supportedRoles = new Set<LifecycleRole>(["admin", "operator", "viewer"]);
const requiredTables = ["organizations", "platform_tenants", "organization_memberships", "account_lifecycle_tokens"];
let schemaReady: Promise<void> | null = null;

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function assertEmail(value: string) {
  const email = normalizeEmail(value);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) {
    throw new Error("invalid_email");
  }
  return email;
}

function assertPassword(value: string) {
  if (value.length < 12 || value.length > 256 || !/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    throw new Error("password_must_have_12_characters_letters_and_numbers");
  }
}

function normalizeName(value: string, field: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < 2 || normalized.length > 160) throw new Error(`invalid_${field}`);
  return normalized;
}

function normalizeSlug(value: string) {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length < 3 || slug.length > 80) throw new Error("invalid_organization_slug");
  return slug;
}

function toLifecycleOperator(row: OperatorRecord & { email_verified_at?: Date | null; onboarding_completed_at?: Date | null }): LifecycleOperator {
  const role = supportedRoles.has(row.role as LifecycleRole) ? row.role as LifecycleRole : "operator";
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role,
    tenantId: row.tenant_id,
    emailVerified: Boolean(row.email_verified_at),
    onboardingCompleted: Boolean(row.onboarding_completed_at),
  };
}

function buildRawToken() {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function expirationFor(purpose: LifecyclePurpose) {
  const minutes = purpose === "email_verification"
    ? ENV.lifecycleVerificationTtlMinutes
    : purpose === "password_reset"
      ? ENV.lifecyclePasswordResetTtlMinutes
      : ENV.lifecycleInvitationTtlMinutes;
  return new Date(Date.now() + Math.max(5, minutes) * 60_000);
}

function publicLink(path: string, token: string) {
  return `${ENV.publicAppOrigin.replace(/\/$/, "")}${path}?token=${encodeURIComponent(token)}`;
}

async function assertProductionSchema() {
  const result = await getOperatorAuthPool().query<{ resolved_table: string | null }>(
    `SELECT to_regclass(required_table) AS resolved_table
     FROM unnest($1::text[]) AS required_table`,
    [requiredTables.map((table) => `public.${table}`)],
  );
  if (result.rows.some((row) => !row.resolved_table)) {
    throw new Error("account_lifecycle_migration_not_applied");
  }
  const columns = await getOperatorAuthPool().query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'operator_credentials'
       AND column_name = ANY($1::text[])`,
    [["email_verified_at", "onboarding_completed_at"]],
  );
  if (columns.rows.length !== 2) {
    throw new Error("account_lifecycle_migration_not_applied");
  }
}

export async function ensureAccountLifecycleStore() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await ensureOperatorAuthStore();
      if (ENV.isProduction) {
        await assertProductionSchema();
        return;
      }

      const client = await getOperatorAuthPool().connect();
      try {
        await client.query("BEGIN");
        await client.query("ALTER TABLE operator_credentials ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ");
        await client.query("ALTER TABLE operator_credentials ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ");
        await client.query(`CREATE TABLE IF NOT EXISTS organizations (
          id UUID PRIMARY KEY, name VARCHAR(160) NOT NULL, slug VARCHAR(96) NOT NULL UNIQUE,
          created_by_operator_id INTEGER NOT NULL REFERENCES operator_credentials(id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await client.query(`CREATE TABLE IF NOT EXISTS platform_tenants (
          id VARCHAR(128) PRIMARY KEY, organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          name VARCHAR(160) NOT NULL, slug VARCHAR(96) NOT NULL UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await client.query(`CREATE TABLE IF NOT EXISTS organization_memberships (
          organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          operator_id INTEGER NOT NULL REFERENCES operator_credentials(id) ON DELETE CASCADE,
          role VARCHAR(64) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (organization_id, operator_id))`);
        await client.query(`CREATE TABLE IF NOT EXISTS account_lifecycle_tokens (
          id UUID PRIMARY KEY, purpose VARCHAR(32) NOT NULL CHECK (purpose IN ('email_verification', 'password_reset', 'invitation')),
          token_hash CHAR(64) NOT NULL UNIQUE, email VARCHAR(255) NOT NULL,
          operator_id INTEGER REFERENCES operator_credentials(id) ON DELETE CASCADE,
          organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
          tenant_id VARCHAR(128) REFERENCES platform_tenants(id) ON DELETE CASCADE,
          role VARCHAR(64), expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ,
          created_by_operator_id INTEGER REFERENCES operator_credentials(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await client.query("CREATE INDEX IF NOT EXISTS account_lifecycle_tokens_active_lookup ON account_lifecycle_tokens (purpose, email, expires_at) WHERE consumed_at IS NULL");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    })();
  }
  return schemaReady;
}

async function issueToken(input: {
  purpose: LifecyclePurpose;
  email: string;
  operatorId?: number | null;
  organizationId?: string | null;
  tenantId?: string | null;
  role?: LifecycleRole | null;
  createdByOperatorId?: number | null;
}) {
  const token = buildRawToken();
  const tokenHash = hashToken(token);
  const expiresAt = expirationFor(input.purpose);
  const client = await getOperatorAuthPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE account_lifecycle_tokens SET consumed_at = NOW()
       WHERE purpose = $1 AND email = $2 AND consumed_at IS NULL`,
      [input.purpose, input.email],
    );
    await client.query(
      `INSERT INTO account_lifecycle_tokens
        (id, purpose, token_hash, email, operator_id, organization_id, tenant_id, role, expires_at, created_by_operator_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [randomUUID(), input.purpose, tokenHash, input.email, input.operatorId ?? null, input.organizationId ?? null, input.tenantId ?? null, input.role ?? null, expiresAt, input.createdByOperatorId ?? null],
    );
    await client.query("COMMIT");
    return { token, expiresAt };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function consumeToken(client: PoolClient, purpose: LifecyclePurpose, token: string) {
  const result = await client.query<LifecycleTokenRow>(
    `UPDATE account_lifecycle_tokens
     SET consumed_at = NOW()
     WHERE token_hash = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > NOW()
     RETURNING id, purpose, email, operator_id, organization_id, tenant_id, role, expires_at`,
    [hashToken(token), purpose],
  );
  return result.rows[0] ?? null;
}

async function sendLifecycleEmail(email: string, type: string, subject: string, message: string) {
  const delivery = await sendEmail(email, subject, message, { lifecycleType: type });
  if (!delivery.accepted || delivery.results.some((result) => result.channel === "email" && !result.success)) {
    throw new Error("lifecycle_email_delivery_failed");
  }
}

export async function beginSignup(input: { email: string; name: string; password: string }) {
  await ensureAccountLifecycleStore();
  if (!ENV.selfServiceSignupEnabled) throw new Error("self_service_signup_disabled");
  const email = assertEmail(input.email);
  const name = normalizeName(input.name, "name");
  assertPassword(input.password);
  const client = await getOperatorAuthPool().connect();
  let operator: LifecycleOperator | null = null;
  try {
    await client.query("BEGIN");
    const existing = await client.query<OperatorRecord & { email_verified_at: Date | null; onboarding_completed_at: Date | null }>(
      `SELECT id, email, name, role, tenant_id, password_hash, is_active, email_verified_at, onboarding_completed_at
       FROM operator_credentials WHERE LOWER(email) = $1 FOR UPDATE`,
      [email],
    );
    if (existing.rows[0]?.email_verified_at) {
      await client.query("ROLLBACK");
      return { accepted: true, verificationDispatched: false };
    }
    if (existing.rows[0]) {
      const updated = await client.query<OperatorRecord & { email_verified_at: Date | null; onboarding_completed_at: Date | null }>(
        `UPDATE operator_credentials SET name = $2, password_hash = $3, is_active = false, updated_at = NOW()
         WHERE id = $1 RETURNING id, email, name, role, tenant_id, password_hash, is_active, email_verified_at, onboarding_completed_at`,
        [existing.rows[0].id, name, buildOperatorPasswordHash(input.password)],
      );
      operator = toLifecycleOperator(updated.rows[0]);
    } else {
      const created = await client.query<OperatorRecord & { email_verified_at: Date | null; onboarding_completed_at: Date | null }>(
        `INSERT INTO operator_credentials (email, name, role, tenant_id, password_hash, is_active)
         VALUES ($1,$2,'admin',NULL,$3,false)
         RETURNING id, email, name, role, tenant_id, password_hash, is_active, email_verified_at, onboarding_completed_at`,
        [email, name, buildOperatorPasswordHash(input.password)],
      );
      operator = toLifecycleOperator(created.rows[0]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (!operator) throw new Error("signup_operator_unavailable");
  const issued = await issueToken({ purpose: "email_verification", email, operatorId: operator.id });
  await sendLifecycleEmail(email, "email_verification", "Verify your SwitchOS email", `Verify your email to continue: ${publicLink("/verify-email", issued.token)}`);
  return { accepted: true, verificationDispatched: true };
}

export async function resendVerification(emailInput: string) {
  await ensureAccountLifecycleStore();
  const email = assertEmail(emailInput);
  const result = await getOperatorAuthPool().query<OperatorRecord & { email_verified_at: Date | null }>(
    `SELECT id, email, name, role, tenant_id, password_hash, is_active, email_verified_at
     FROM operator_credentials WHERE LOWER(email) = $1 LIMIT 1`,
    [email],
  );
  const operator = result.rows[0];
  if (!operator || operator.email_verified_at) return { accepted: true, verificationDispatched: false };
  const issued = await issueToken({ purpose: "email_verification", email, operatorId: operator.id });
  await sendLifecycleEmail(email, "email_verification", "Verify your SwitchOS email", `Verify your email to continue: ${publicLink("/verify-email", issued.token)}`);
  return { accepted: true, verificationDispatched: true };
}

export async function confirmEmailVerification(token: string) {
  await ensureAccountLifecycleStore();
  const client = await getOperatorAuthPool().connect();
  try {
    await client.query("BEGIN");
    const lifecycle = await consumeToken(client, "email_verification", token);
    if (!lifecycle?.operator_id) throw new Error("invalid_or_expired_verification_token");
    const updated = await client.query<OperatorRecord & { email_verified_at: Date | null; onboarding_completed_at: Date | null }>(
      `UPDATE operator_credentials SET email_verified_at = NOW(), is_active = true, updated_at = NOW()
       WHERE id = $1 AND LOWER(email) = $2
       RETURNING id, email, name, role, tenant_id, password_hash, is_active, email_verified_at, onboarding_completed_at`,
      [lifecycle.operator_id, lifecycle.email],
    );
    if (!updated.rows[0]) throw new Error("verification_operator_not_found");
    await client.query("COMMIT");
    return toLifecycleOperator(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function requestPasswordReset(emailInput: string) {
  await ensureAccountLifecycleStore();
  const email = assertEmail(emailInput);
  const result = await getOperatorAuthPool().query<OperatorRecord & { email_verified_at: Date | null }>(
    `SELECT id, email, name, role, tenant_id, password_hash, is_active, email_verified_at
     FROM operator_credentials WHERE LOWER(email) = $1 LIMIT 1`,
    [email],
  );
  const operator = result.rows[0];
  if (!operator?.email_verified_at || !operator.is_active) return { accepted: true, resetDispatched: false };
  const issued = await issueToken({ purpose: "password_reset", email, operatorId: operator.id });
  await sendLifecycleEmail(email, "password_reset", "Reset your SwitchOS password", `Reset your password: ${publicLink("/reset-password", issued.token)}`);
  return { accepted: true, resetDispatched: true };
}

export async function confirmPasswordReset(input: { token: string; password: string }) {
  await ensureAccountLifecycleStore();
  assertPassword(input.password);
  const client = await getOperatorAuthPool().connect();
  try {
    await client.query("BEGIN");
    const lifecycle = await consumeToken(client, "password_reset", input.token);
    if (!lifecycle?.operator_id) throw new Error("invalid_or_expired_password_reset_token");
    const updated = await client.query(
      `UPDATE operator_credentials SET password_hash = $2, updated_at = NOW()
       WHERE id = $1 AND LOWER(email) = $3`,
      [lifecycle.operator_id, buildOperatorPasswordHash(input.password), lifecycle.email],
    );
    if (updated.rowCount !== 1) throw new Error("password_reset_operator_not_found");
    await client.query("COMMIT");
    return { reset: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getOnboardingState(operatorId: number) {
  await ensureAccountLifecycleStore();
  const result = await getOperatorAuthPool().query<OperatorRecord & { email_verified_at: Date | null; onboarding_completed_at: Date | null }>(
    `SELECT id, email, name, role, tenant_id, password_hash, is_active, email_verified_at, onboarding_completed_at
     FROM operator_credentials WHERE id = $1 LIMIT 1`,
    [operatorId],
  );
  const operator = result.rows[0];
  if (!operator) throw new Error("operator_not_found");
  const normalized = toLifecycleOperator(operator);
  return {
    operator: normalized,
    needsEmailVerification: !normalized.emailVerified,
    needsOrganization: normalized.emailVerified && !normalized.tenantId,
    needsCompletion: normalized.emailVerified && Boolean(normalized.tenantId) && !normalized.onboardingCompleted,
  };
}

export async function createOrganizationAndTenant(input: { operatorId: number; organizationName: string; organizationSlug: string; tenantName: string }) {
  await ensureAccountLifecycleStore();
  const organizationName = normalizeName(input.organizationName, "organization_name");
  const tenantName = normalizeName(input.tenantName, "tenant_name");
  const slug = normalizeSlug(input.organizationSlug || organizationName);
  const organizationId = randomUUID();
  const tenantId = `tenant_${slug}`;
  const client = await getOperatorAuthPool().connect();
  try {
    await client.query("BEGIN");
    const operator = await client.query<OperatorRecord & { email_verified_at: Date | null }>(
      `SELECT id, email, name, role, tenant_id, password_hash, is_active, email_verified_at
       FROM operator_credentials WHERE id = $1 FOR UPDATE`,
      [input.operatorId],
    );
    const owner = operator.rows[0];
    if (!owner?.email_verified_at || !owner.is_active) throw new Error("verified_active_operator_required");
    if (owner.tenant_id) throw new Error("operator_already_has_tenant");
    await client.query(`INSERT INTO organizations (id, name, slug, created_by_operator_id) VALUES ($1,$2,$3,$4)`, [organizationId, organizationName, slug, owner.id]);
    await client.query(`INSERT INTO platform_tenants (id, organization_id, name, slug) VALUES ($1,$2,$3,$4)`, [tenantId, organizationId, tenantName, slug]);
    await client.query(`INSERT INTO organization_memberships (organization_id, operator_id, role) VALUES ($1,$2,'admin')`, [organizationId, owner.id]);
    await client.query(`UPDATE operator_credentials SET tenant_id = $2, onboarding_completed_at = NOW(), updated_at = NOW() WHERE id = $1`, [owner.id, tenantId]);
    await client.query("COMMIT");
    return { organizationId, organizationName, tenantId, tenantName, role: "admin" as const };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function createInvitation(input: { inviterId: number; email: string; role: LifecycleRole }) {
  await ensureAccountLifecycleStore();
  if (!supportedRoles.has(input.role)) throw new Error("invalid_invitation_role");
  const email = assertEmail(input.email);
  const owner = await getOperatorAuthPool().query<OperatorRecord>(
    `SELECT id, email, name, role, tenant_id, password_hash, is_active FROM operator_credentials WHERE id = $1`,
    [input.inviterId],
  );
  const inviter = owner.rows[0];
  if (!inviter?.is_active || inviter.role !== "admin" || !inviter.tenant_id) throw new Error("tenant_admin_required");
  const tenant = await getOperatorAuthPool().query<{ organization_id: string }>(`SELECT organization_id FROM platform_tenants WHERE id = $1`, [inviter.tenant_id]);
  if (!tenant.rows[0]) throw new Error("tenant_not_found");
  const issued = await issueToken({ purpose: "invitation", email, organizationId: tenant.rows[0].organization_id, tenantId: inviter.tenant_id, role: input.role, createdByOperatorId: inviter.id });
  await sendLifecycleEmail(email, "invitation", "You are invited to SwitchOS", `Accept your invitation: ${publicLink("/accept-invitation", issued.token)}`);
  return { invited: true };
}

export async function acceptInvitation(input: { token: string; name: string; password: string }) {
  await ensureAccountLifecycleStore();
  const name = normalizeName(input.name, "name");
  assertPassword(input.password);
  const client = await getOperatorAuthPool().connect();
  try {
    await client.query("BEGIN");
    const lifecycle = await consumeToken(client, "invitation", input.token);
    if (!lifecycle?.tenant_id || !lifecycle.organization_id || !lifecycle.role) throw new Error("invalid_or_expired_invitation_token");
    const existing = await client.query<OperatorRecord>(`SELECT id, email, name, role, tenant_id, password_hash, is_active FROM operator_credentials WHERE LOWER(email) = $1 FOR UPDATE`, [lifecycle.email]);
    if (existing.rows[0]?.tenant_id && existing.rows[0].tenant_id !== lifecycle.tenant_id) throw new Error("invited_email_already_belongs_to_another_tenant");
    const saved = existing.rows[0]
      ? await client.query<OperatorRecord>(`UPDATE operator_credentials SET name=$2, role=$3, tenant_id=$4, password_hash=$5, is_active=true, email_verified_at=NOW(), onboarding_completed_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING id,email,name,role,tenant_id,password_hash,is_active`, [existing.rows[0].id, name, lifecycle.role, lifecycle.tenant_id, buildOperatorPasswordHash(input.password)])
      : await client.query<OperatorRecord>(`INSERT INTO operator_credentials (email,name,role,tenant_id,password_hash,is_active,email_verified_at,onboarding_completed_at) VALUES ($1,$2,$3,$4,$5,true,NOW(),NOW()) RETURNING id,email,name,role,tenant_id,password_hash,is_active`, [lifecycle.email, name, lifecycle.role, lifecycle.tenant_id, buildOperatorPasswordHash(input.password)]);
    await client.query(`INSERT INTO organization_memberships (organization_id, operator_id, role) VALUES ($1,$2,$3) ON CONFLICT (organization_id, operator_id) DO UPDATE SET role = EXCLUDED.role`, [lifecycle.organization_id, saved.rows[0].id, lifecycle.role]);
    await client.query("COMMIT");
    return { operator: toLifecycleOperator({ ...saved.rows[0], email_verified_at: new Date(), onboarding_completed_at: new Date() }) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
