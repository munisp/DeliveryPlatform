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

export type TenantBranding = {
  logoDataUrl: string | null;
  primaryColor: string;
  accentColor: string;
  updatedAt: Date | null;
};

export type TenantBrandingPreset = TenantBranding & {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  organizationShared: boolean;
  sourceTenantName?: string;
};

export type InvitationStatus = {
  id: string;
  email: string;
  role: LifecycleRole | null;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  status: "pending" | "accepted" | "expired" | "revoked";
};

const supportedRoles = new Set<LifecycleRole>(["admin", "operator", "viewer"]);
const requiredTables = ["organizations", "platform_tenants", "organization_memberships", "account_lifecycle_tokens", "tenant_branding_presets"];
const maxBulkInvitationActions = 10;
const maxBulkMemberRoleChanges = 10;
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

function normalizeColor(value: string, field: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(normalized)) throw new Error(`invalid_${field}`);
  return normalized;
}

function normalizeLogoDataUrl(value: string | null | undefined) {
  if (value == null || value === "") return null;
  if (value.length > 350_000) throw new Error("branding_logo_too_large");
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("invalid_branding_logo");
  return value;
}

function normalizePresetName(value: string) {
  return normalizeName(value, "branding_preset_name").slice(0, 80);
}

function normalizeInvitationIds(values: string[]) {
  const ids = [...new Set(values.map((value) => value.trim()))];
  if (!ids.length || ids.length > maxBulkInvitationActions || ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id))) {
    throw new Error("invalid_invitation_selection");
  }
  return ids;
}

function normalizeMemberIds(values: number[]) {
  const ids = [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))];
  if (!ids.length || ids.length > maxBulkMemberRoleChanges) throw new Error("invalid_member_selection");
  return ids;
}

function csvCell(value: string | null | undefined) {
  const normalized = `${value ?? ""}`.replace(/\r?\n/g, " ");
  const formulaSafe = /^[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
  return `"${formulaSafe.replace(/"/g, '""')}"`;
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
  const brandingColumns = await getOperatorAuthPool().query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'platform_tenants'
       AND column_name = ANY($1::text[])`,
    [["brand_logo_data_url", "brand_primary_color", "brand_accent_color", "branding_updated_at"]],
  );
  if (brandingColumns.rows.length !== 4) throw new Error("tenant_branding_migration_not_applied");
  const revocationColumns = await getOperatorAuthPool().query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'account_lifecycle_tokens'
       AND column_name = 'revoked_at'`,
  );
  if (revocationColumns.rows.length !== 1) throw new Error("tenant_admin_actions_migration_not_applied");
  const sharingColumns = await getOperatorAuthPool().query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tenant_branding_presets'
       AND column_name = ANY($1::text[])`,
    [["organization_id", "organization_shared", "shared_by_operator_id", "shared_at", "ownership_transferred_by_operator_id", "ownership_transferred_at"]],
  );
  if (sharingColumns.rows.length !== 6) throw new Error("organization_branding_preset_sharing_migration_not_applied");
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
        await client.query("ALTER TABLE platform_tenants ADD COLUMN IF NOT EXISTS brand_logo_data_url TEXT");
        await client.query("ALTER TABLE platform_tenants ADD COLUMN IF NOT EXISTS brand_primary_color CHAR(7) NOT NULL DEFAULT '#0ea5e9'");
        await client.query("ALTER TABLE platform_tenants ADD COLUMN IF NOT EXISTS brand_accent_color CHAR(7) NOT NULL DEFAULT '#0f172a'");
        await client.query("ALTER TABLE platform_tenants ADD COLUMN IF NOT EXISTS branding_updated_at TIMESTAMPTZ");
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
        await client.query("ALTER TABLE account_lifecycle_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ");
        await client.query(`CREATE TABLE IF NOT EXISTS tenant_branding_presets (
          id UUID PRIMARY KEY, tenant_id VARCHAR(128) NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
          name VARCHAR(80) NOT NULL, logo_data_url TEXT, primary_color CHAR(7) NOT NULL,
          accent_color CHAR(7) NOT NULL, created_by_operator_id INTEGER NOT NULL REFERENCES operator_credentials(id) ON DELETE RESTRICT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (tenant_id, name))`);
        await client.query("ALTER TABLE tenant_branding_presets ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE");
        await client.query("ALTER TABLE tenant_branding_presets ADD COLUMN IF NOT EXISTS organization_shared BOOLEAN NOT NULL DEFAULT FALSE");
        await client.query("ALTER TABLE tenant_branding_presets ADD COLUMN IF NOT EXISTS shared_by_operator_id INTEGER REFERENCES operator_credentials(id) ON DELETE SET NULL");
        await client.query("ALTER TABLE tenant_branding_presets ADD COLUMN IF NOT EXISTS shared_at TIMESTAMPTZ");
        await client.query("ALTER TABLE tenant_branding_presets ADD COLUMN IF NOT EXISTS ownership_transferred_by_operator_id INTEGER REFERENCES operator_credentials(id) ON DELETE SET NULL");
        await client.query("ALTER TABLE tenant_branding_presets ADD COLUMN IF NOT EXISTS ownership_transferred_at TIMESTAMPTZ");
        await client.query(`UPDATE tenant_branding_presets preset SET organization_id = tenant.organization_id
          FROM platform_tenants tenant WHERE preset.tenant_id = tenant.id AND preset.organization_id IS NULL`);
        await client.query("CREATE INDEX IF NOT EXISTS tenant_branding_presets_organization_sharing_lookup ON tenant_branding_presets (organization_id, shared_at DESC) WHERE organization_shared = TRUE");
        await client.query("CREATE INDEX IF NOT EXISTS tenant_branding_presets_owner_lookup ON tenant_branding_presets (tenant_id, created_by_operator_id, updated_at DESC)");
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
      `UPDATE account_lifecycle_tokens SET revoked_at = NOW()
       WHERE purpose = $1 AND email = $2 AND consumed_at IS NULL AND revoked_at IS NULL`,
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
     WHERE token_hash = $1 AND purpose = $2 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
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
    await client.query(`UPDATE operator_credentials SET tenant_id = $2, updated_at = NOW() WHERE id = $1`, [owner.id, tenantId]);
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

async function getTenantAdminContext(operatorId: number) {
  const owner = await getOperatorAuthPool().query<OperatorRecord>(
    `SELECT id, email, name, role, tenant_id, password_hash, is_active
     FROM operator_credentials WHERE id = $1`,
    [operatorId],
  );
  const operator = owner.rows[0];
  if (!operator?.is_active || operator.role !== "admin" || !operator.tenant_id) throw new Error("tenant_admin_required");
  const tenant = await getOperatorAuthPool().query<{ organization_id: string }>(
    `SELECT organization_id FROM platform_tenants WHERE id = $1`,
    [operator.tenant_id],
  );
  if (!tenant.rows[0]) throw new Error("tenant_not_found");
  return { operator, organizationId: tenant.rows[0].organization_id };
}

export async function listInvitationStatuses(inviterId: number) {
  await ensureAccountLifecycleStore();
  const { operator } = await getTenantAdminContext(inviterId);
  const result = await getOperatorAuthPool().query<{
    id: string; email: string; role: LifecycleRole | null; created_at: Date; expires_at: Date; consumed_at: Date | null; revoked_at: Date | null; status: InvitationStatus["status"];
  }>(
    `SELECT id, email, role, created_at, expires_at, consumed_at, revoked_at,
      CASE WHEN consumed_at IS NOT NULL THEN 'accepted'
           WHEN revoked_at IS NOT NULL THEN 'revoked'
           WHEN expires_at <= NOW() THEN 'expired'
           ELSE 'pending' END AS status
     FROM account_lifecycle_tokens
     WHERE tenant_id = $1 AND purpose = 'invitation'
     ORDER BY created_at DESC LIMIT 200`,
    [operator.tenant_id],
  );
  return result.rows.map((row) => ({ id: row.id, email: row.email, role: row.role, createdAt: row.created_at, expiresAt: row.expires_at, acceptedAt: row.consumed_at, revokedAt: row.revoked_at, status: row.status }));
}

export async function resendInvitation(input: { inviterId: number; invitationId: string }) {
  await ensureAccountLifecycleStore();
  const { operator, organizationId } = await getTenantAdminContext(input.inviterId);
  const existing = await getOperatorAuthPool().query<{ email: string; role: LifecycleRole | null; expires_at: Date; consumed_at: Date | null; revoked_at: Date | null }>(
    `SELECT email, role, expires_at, consumed_at, revoked_at FROM account_lifecycle_tokens
     WHERE id = $1 AND tenant_id = $2 AND organization_id = $3 AND purpose = 'invitation'`,
    [input.invitationId, operator.tenant_id, organizationId],
  );
  const invitation = existing.rows[0];
  if (!invitation || invitation.consumed_at || invitation.revoked_at || invitation.expires_at <= new Date() || !invitation.role) throw new Error("invitation_not_pending");
  const issued = await issueToken({ purpose: "invitation", email: invitation.email, organizationId, tenantId: operator.tenant_id, role: invitation.role, createdByOperatorId: operator.id });
  await sendLifecycleEmail(invitation.email, "invitation", "You are invited to SwitchOS", `Accept your refreshed invitation: ${publicLink("/accept-invitation", issued.token)}`);
  return { resent: true };
}

export async function revokeInvitation(input: { inviterId: number; invitationId: string }) {
  await ensureAccountLifecycleStore();
  const { operator, organizationId } = await getTenantAdminContext(input.inviterId);
  const result = await getOperatorAuthPool().query(
    `UPDATE account_lifecycle_tokens SET revoked_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND organization_id = $3 AND purpose = 'invitation'
       AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`,
    [input.invitationId, operator.tenant_id, organizationId],
  );
  if (result.rowCount !== 1) throw new Error("invitation_not_pending");
  return { revoked: true };
}

export type BulkInvitationActionResult = {
  requested: number;
  succeeded: string[];
  failed: string[];
};

export async function bulkResendInvitations(input: { inviterId: number; invitationIds: string[] }): Promise<BulkInvitationActionResult> {
  const invitationIds = normalizeInvitationIds(input.invitationIds);
  const succeeded: string[] = [];
  const failed: string[] = [];
  for (const invitationId of invitationIds) {
    try {
      await resendInvitation({ inviterId: input.inviterId, invitationId });
      succeeded.push(invitationId);
    } catch {
      failed.push(invitationId);
    }
  }
  return { requested: invitationIds.length, succeeded, failed };
}

export async function bulkRevokeInvitations(input: { inviterId: number; invitationIds: string[] }): Promise<BulkInvitationActionResult> {
  const invitationIds = normalizeInvitationIds(input.invitationIds);
  const succeeded: string[] = [];
  const failed: string[] = [];
  for (const invitationId of invitationIds) {
    try {
      await revokeInvitation({ inviterId: input.inviterId, invitationId });
      succeeded.push(invitationId);
    } catch {
      failed.push(invitationId);
    }
  }
  return { requested: invitationIds.length, succeeded, failed };
}

export type BulkRoleChangeResult = { requested: number; changed: number; role: LifecycleRole };

export type TenantMember = { id: number; email: string; name: string; role: LifecycleRole; updatedAt: Date };

export async function listTenantMembers(operatorId: number): Promise<TenantMember[]> {
  await ensureAccountLifecycleStore();
  const { operator, organizationId } = await getTenantAdminContext(operatorId);
  const result = await getOperatorAuthPool().query<{ id: number; email: string; name: string; role: LifecycleRole; updated_at: Date }>(
    `SELECT o.id, o.email, o.name, o.role, o.updated_at FROM operator_credentials o
     JOIN organization_memberships m ON m.operator_id = o.id AND m.organization_id = $1
     WHERE o.tenant_id = $2 AND o.is_active = TRUE ORDER BY o.name ASC, o.email ASC LIMIT 200`,
    [organizationId, operator.tenant_id],
  );
  return result.rows.map((row) => ({ id: row.id, email: row.email, name: row.name, role: row.role, updatedAt: row.updated_at }));
}

export async function bulkChangeMemberRoles(input: { operatorId: number; memberIds: number[]; role: LifecycleRole }): Promise<BulkRoleChangeResult> {
  await ensureAccountLifecycleStore();
  const memberIds = normalizeMemberIds(input.memberIds);
  if (!supportedRoles.has(input.role)) throw new Error("invalid_invitation_role");
  const { operator, organizationId } = await getTenantAdminContext(input.operatorId);
  if (memberIds.includes(operator.id)) throw new Error("self_role_change_not_allowed");
  const client = await getOperatorAuthPool().connect();
  try {
    await client.query("BEGIN");
    const members = await client.query<{ id: number; role: LifecycleRole }>(
      `SELECT o.id, o.role FROM operator_credentials o
       JOIN organization_memberships m ON m.operator_id = o.id AND m.organization_id = $1
       WHERE o.id = ANY($2::integer[]) AND o.tenant_id = $3 AND o.is_active = TRUE FOR UPDATE`,
      [organizationId, memberIds, operator.tenant_id],
    );
    if (members.rows.length !== memberIds.length) throw new Error("member_not_found");
    if (input.role !== "admin" && members.rows.some((member) => member.role === "admin")) {
      const admins = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM operator_credentials WHERE tenant_id = $1 AND is_active = TRUE AND role = 'admin'`, [operator.tenant_id]);
      if (Number(admins.rows[0]?.count ?? "0") <= members.rows.filter((member) => member.role === "admin").length) throw new Error("last_tenant_admin_role_change_not_allowed");
    }
    await client.query(`UPDATE operator_credentials SET role = $2, updated_at = NOW() WHERE id = ANY($1::integer[])`, [memberIds, input.role]);
    await client.query(`UPDATE organization_memberships SET role = $3 WHERE organization_id = $1 AND operator_id = ANY($2::integer[])`, [organizationId, memberIds, input.role]);
    await client.query("COMMIT");
    return { requested: memberIds.length, changed: memberIds.length, role: input.role };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function exportInvitationActivityCsv(operatorId: number) {
  const invitations = await listInvitationStatuses(operatorId);
  const header = ["invitation_id", "recipient_email", "role", "status", "sent_at", "expires_at", "accepted_at", "revoked_at"];
  const rows = invitations.map((invitation) => [invitation.id, invitation.email, invitation.role ?? "", invitation.status, invitation.createdAt.toISOString(), invitation.expiresAt.toISOString(), invitation.acceptedAt?.toISOString() ?? "", invitation.revokedAt?.toISOString() ?? ""]);
  return [header, ...rows].map((row) => row.map((value) => csvCell(value)).join(",")).join("\r\n");
}

export async function getTenantBranding(operatorId: number): Promise<TenantBranding> {
  await ensureAccountLifecycleStore();
  const result = await getOperatorAuthPool().query<{
    brand_logo_data_url: string | null; brand_primary_color: string; brand_accent_color: string; branding_updated_at: Date | null;
  }>(
    `SELECT t.brand_logo_data_url, t.brand_primary_color, t.brand_accent_color, t.branding_updated_at
     FROM platform_tenants t JOIN operator_credentials o ON o.tenant_id = t.id
     WHERE o.id = $1 AND o.is_active = true`,
    [operatorId],
  );
  const branding = result.rows[0];
  if (!branding) throw new Error("tenant_not_found");
  return { logoDataUrl: branding.brand_logo_data_url, primaryColor: branding.brand_primary_color, accentColor: branding.brand_accent_color, updatedAt: branding.branding_updated_at };
}

export async function updateTenantBranding(input: { operatorId: number; logoDataUrl?: string | null; primaryColor: string; accentColor: string }): Promise<TenantBranding> {
  await ensureAccountLifecycleStore();
  const { operator } = await getTenantAdminContext(input.operatorId);
  const client = await getOperatorAuthPool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{
      brand_logo_data_url: string | null; brand_primary_color: string; brand_accent_color: string; branding_updated_at: Date | null;
    }>(
      `UPDATE platform_tenants SET brand_logo_data_url = $2, brand_primary_color = $3, brand_accent_color = $4, branding_updated_at = NOW()
       WHERE id = $1
       RETURNING brand_logo_data_url, brand_primary_color, brand_accent_color, branding_updated_at`,
      [operator.tenant_id, normalizeLogoDataUrl(input.logoDataUrl), normalizeColor(input.primaryColor, "brand_primary_color"), normalizeColor(input.accentColor, "brand_accent_color")],
    );
    const branding = result.rows[0];
    if (!branding) throw new Error("tenant_not_found");
    await client.query(`UPDATE operator_credentials SET onboarding_completed_at = COALESCE(onboarding_completed_at, NOW()), updated_at = NOW() WHERE id = $1`, [operator.id]);
    await client.query("COMMIT");
    return { logoDataUrl: branding.brand_logo_data_url, primaryColor: branding.brand_primary_color, accentColor: branding.brand_accent_color, updatedAt: branding.branding_updated_at };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listTenantBrandingPresets(operatorId: number): Promise<TenantBrandingPreset[]> {
  await ensureAccountLifecycleStore();
  const { operator } = await getTenantAdminContext(operatorId);
  const result = await getOperatorAuthPool().query<{ id: string; name: string; logo_data_url: string | null; primary_color: string; accent_color: string; created_at: Date; updated_at: Date; organization_shared: boolean }>(
    `SELECT id, name, logo_data_url, primary_color, accent_color, created_at, updated_at, organization_shared
     FROM tenant_branding_presets WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT 12`,
    [operator.tenant_id],
  );
  return result.rows.map((row) => ({ id: row.id, name: row.name, logoDataUrl: row.logo_data_url, primaryColor: row.primary_color, accentColor: row.accent_color, createdAt: row.created_at, updatedAt: row.updated_at, organizationShared: row.organization_shared }));
}

export async function saveTenantBrandingPreset(input: { operatorId: number; name: string; logoDataUrl?: string | null; primaryColor: string; accentColor: string }) {
  await ensureAccountLifecycleStore();
  const { operator, organizationId } = await getTenantAdminContext(input.operatorId);
  const result = await getOperatorAuthPool().query<{ id: string; name: string; logo_data_url: string | null; primary_color: string; accent_color: string; created_at: Date; updated_at: Date; organization_shared: boolean }>(
    `INSERT INTO tenant_branding_presets (id, tenant_id, organization_id, name, logo_data_url, primary_color, accent_color, created_by_operator_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, name) DO UPDATE SET logo_data_url = EXCLUDED.logo_data_url, primary_color = EXCLUDED.primary_color, accent_color = EXCLUDED.accent_color, updated_at = NOW()
       WHERE tenant_branding_presets.created_by_operator_id = $8
     RETURNING id, name, logo_data_url, primary_color, accent_color, created_at, updated_at, organization_shared`,
    [randomUUID(), operator.tenant_id, organizationId, normalizePresetName(input.name), normalizeLogoDataUrl(input.logoDataUrl), normalizeColor(input.primaryColor, "brand_primary_color"), normalizeColor(input.accentColor, "brand_accent_color"), operator.id],
  );
  const preset = result.rows[0];
  if (!preset) throw new Error("branding_preset_owner_required");
  return { id: preset.id, name: preset.name, logoDataUrl: preset.logo_data_url, primaryColor: preset.primary_color, accentColor: preset.accent_color, createdAt: preset.created_at, updatedAt: preset.updated_at, organizationShared: preset.organization_shared };
}

export async function applyTenantBrandingPreset(input: { operatorId: number; presetId: string }) {
  await ensureAccountLifecycleStore();
  const { operator } = await getTenantAdminContext(input.operatorId);
  const preset = await getOperatorAuthPool().query<{ logo_data_url: string | null; primary_color: string; accent_color: string }>(
    `SELECT logo_data_url, primary_color, accent_color FROM tenant_branding_presets WHERE id = $1 AND tenant_id = $2`,
    [input.presetId, operator.tenant_id],
  );
  if (!preset.rows[0]) throw new Error("branding_preset_not_found");
  return updateTenantBranding({ operatorId: operator.id, logoDataUrl: preset.rows[0].logo_data_url, primaryColor: preset.rows[0].primary_color, accentColor: preset.rows[0].accent_color });
}

export async function deleteTenantBrandingPreset(input: { operatorId: number; presetId: string }) {
  await ensureAccountLifecycleStore();
  const { operator } = await getTenantAdminContext(input.operatorId);
  const result = await getOperatorAuthPool().query(`DELETE FROM tenant_branding_presets WHERE id = $1 AND tenant_id = $2 AND created_by_operator_id = $3`, [input.presetId, operator.tenant_id, operator.id]);
  if (result.rowCount !== 1) throw new Error("branding_preset_not_found");
  return { deleted: true };
}

export async function setTenantBrandingPresetOrganizationSharing(input: { operatorId: number; presetId: string; shared: boolean }) {
  await ensureAccountLifecycleStore();
  const { operator, organizationId } = await getTenantAdminContext(input.operatorId);
  const result = await getOperatorAuthPool().query<{ id: string; organization_shared: boolean }>(
    `UPDATE tenant_branding_presets
     SET organization_shared = $4::boolean, shared_by_operator_id = CASE WHEN $4::boolean THEN $5::integer ELSE NULL::integer END,
         shared_at = CASE WHEN $4::boolean THEN NOW() ELSE NULL END, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND organization_id = $3 AND created_by_operator_id = $5
     RETURNING id, organization_shared`,
    [input.presetId, operator.tenant_id, organizationId, input.shared, operator.id],
  );
  if (!result.rows[0]) throw new Error("branding_preset_not_found");
  return { id: result.rows[0].id, organizationShared: result.rows[0].organization_shared };
}

export async function transferTenantBrandingPresetOwnership(input: { operatorId: number; presetId: string; recipientEmail: string }) {
  await ensureAccountLifecycleStore();
  const { operator, organizationId } = await getTenantAdminContext(input.operatorId);
  const recipient = await getOperatorAuthPool().query<{ id: number }>(
    `SELECT o.id FROM operator_credentials o
     JOIN organization_memberships m ON m.operator_id = o.id AND m.organization_id = $1
     WHERE LOWER(o.email) = $2 AND o.tenant_id = $3 AND o.role = 'admin' AND o.is_active = TRUE AND o.id <> $4`,
    [organizationId, assertEmail(input.recipientEmail), operator.tenant_id, operator.id],
  );
  if (!recipient.rows[0]) throw new Error("preset_transfer_recipient_invalid");
  const result = await getOperatorAuthPool().query<{ id: string; created_by_operator_id: number }>(
    `UPDATE tenant_branding_presets
     SET created_by_operator_id = $4, ownership_transferred_by_operator_id = $5, ownership_transferred_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND organization_id = $3 AND created_by_operator_id = $5
     RETURNING id, created_by_operator_id`,
    [input.presetId, operator.tenant_id, organizationId, recipient.rows[0].id, operator.id],
  );
  if (!result.rows[0]) throw new Error("branding_preset_not_found");
  return { id: result.rows[0].id, ownerOperatorId: result.rows[0].created_by_operator_id };
}

export async function listOrganizationSharedBrandingPresets(operatorId: number): Promise<TenantBrandingPreset[]> {
  await ensureAccountLifecycleStore();
  const { operator, organizationId } = await getTenantAdminContext(operatorId);
  const result = await getOperatorAuthPool().query<{ id: string; name: string; logo_data_url: string | null; primary_color: string; accent_color: string; created_at: Date; updated_at: Date; name_source: string }>(
    `SELECT preset.id, preset.name, preset.logo_data_url, preset.primary_color, preset.accent_color,
            preset.created_at, preset.updated_at, tenant.name AS name_source
     FROM tenant_branding_presets preset
     JOIN platform_tenants tenant ON tenant.id = preset.tenant_id
     WHERE preset.organization_id = $1 AND preset.organization_shared = TRUE AND preset.tenant_id <> $2
     ORDER BY preset.shared_at DESC NULLS LAST, preset.updated_at DESC LIMIT 24`,
    [organizationId, operator.tenant_id],
  );
  return result.rows.map((row) => ({ id: row.id, name: row.name, logoDataUrl: row.logo_data_url, primaryColor: row.primary_color, accentColor: row.accent_color, createdAt: row.created_at, updatedAt: row.updated_at, organizationShared: true, sourceTenantName: row.name_source }));
}

export async function applyOrganizationSharedBrandingPreset(input: { operatorId: number; presetId: string }) {
  await ensureAccountLifecycleStore();
  const { operator, organizationId } = await getTenantAdminContext(input.operatorId);
  const preset = await getOperatorAuthPool().query<{ logo_data_url: string | null; primary_color: string; accent_color: string }>(
    `SELECT logo_data_url, primary_color, accent_color FROM tenant_branding_presets
     WHERE id = $1 AND organization_id = $2 AND organization_shared = TRUE AND tenant_id <> $3`,
    [input.presetId, organizationId, operator.tenant_id],
  );
  if (!preset.rows[0]) throw new Error("branding_preset_not_found");
  return updateTenantBranding({ operatorId: operator.id, logoDataUrl: preset.rows[0].logo_data_url, primaryColor: preset.rows[0].primary_color, accentColor: preset.rows[0].accent_color });
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
