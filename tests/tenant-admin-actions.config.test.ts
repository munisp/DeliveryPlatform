import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("tenant admin action contracts", () => {
  const root = resolve(import.meta.dirname, "..");

  it("persists revocation and tenant-scoped branding presets through an additive reversible migration", async () => {
    const migration = await readFile(resolve(root, "drizzle/0010_tenant_admin_actions.sql"), "utf8");
    const rollback = await readFile(resolve(root, "drizzle/rollback/0010_tenant_admin_actions.down.sql"), "utf8");
    expect(migration).toContain("revoked_at");
    expect(migration).toContain("tenant_branding_presets");
    expect(migration).toContain("UNIQUE (tenant_id, name)");
    expect(rollback).toContain("DROP TABLE IF EXISTS tenant_branding_presets");
  });

  it("requires a pending invitation and tenant-admin context for resend or revocation", async () => {
    const store = await readFile(resolve(root, "server/_core/accountLifecycleStore.ts"), "utf8");
    expect(store).toContain("SET revoked_at = NOW()");
    expect(store).toContain("AND revoked_at IS NULL");
    expect(store).toContain("invitation_not_pending");
    expect(store).toContain("getTenantAdminContext(input.inviterId)");
  });

  it("exposes authenticated scoped routes without returning raw invitation tokens", async () => {
    const routes = await readFile(resolve(root, "server/_core/index.ts"), "utf8");
    expect(routes).toContain('"/api/auth/invitations/:id/resend"');
    expect(routes).toContain('"/api/auth/invitations/:id/revoke"');
    expect(routes).toContain('"/api/auth/tenant-branding/presets"');
    expect(routes).not.toContain("token: issued.token");
  });

  it("bounds bulk invitation actions and persists reversible organization preset sharing", async () => {
    const store = await readFile(resolve(root, "server/_core/accountLifecycleStore.ts"), "utf8");
    const migration = await readFile(resolve(root, "drizzle/0011_organization_branding_preset_sharing.sql"), "utf8");
    const rollback = await readFile(resolve(root, "drizzle/rollback/0011_organization_branding_preset_sharing.down.sql"), "utf8");

    expect(store).toContain("maxBulkInvitationActions = 10");
    expect(store).toContain("bulkResendInvitations");
    expect(store).toContain("bulkRevokeInvitations");
    expect(store).toContain("listOrganizationSharedBrandingPresets");
    expect(migration).toContain("organization_shared");
    expect(migration).toContain("organization_id");
    expect(rollback).toContain("DROP COLUMN IF EXISTS organization_shared");
  });

  it("exposes rate-limited bulk and organization-sharing routes", async () => {
    const routes = await readFile(resolve(root, "server/_core/index.ts"), "utf8");

    expect(routes).toContain('"/api/auth/invitations/actions/bulk/resend"');
    expect(routes).toContain('"/api/auth/invitations/actions/bulk/revoke"');
    expect(routes).toContain('"/api/auth/tenant-branding/presets/shared"');
    expect(routes).toContain('"/api/auth/tenant-branding/presets/:id/share"');
  });

  it("bounds tenant member role changes and records reversible preset ownership transfers", async () => {
    const store = await readFile(resolve(root, "server/_core/accountLifecycleStore.ts"), "utf8");
    const migration = await readFile(resolve(root, "drizzle/0012_tenant_admin_role_and_reporting.sql"), "utf8");
    const rollback = await readFile(resolve(root, "drizzle/rollback/0012_tenant_admin_role_and_reporting.down.sql"), "utf8");

    expect(store).toContain("maxBulkMemberRoleChanges = 10");
    expect(store).toContain("last_tenant_admin_role_change_not_allowed");
    expect(store).toContain("transferTenantBrandingPresetOwnership");
    expect(store).toContain("preset_transfer_recipient_invalid");
    expect(store).toContain("branding_preset_owner_required");
    expect(store).toContain("created_by_operator_id = $5");
    expect(migration).toContain("ownership_transferred_by_operator_id");
    expect(rollback).toContain("ownership_transferred_at");
  });

  it("exposes tenant-admin role, ownership, and safe CSV reporting routes", async () => {
    const routes = await readFile(resolve(root, "server/_core/index.ts"), "utf8");
    const store = await readFile(resolve(root, "server/_core/accountLifecycleStore.ts"), "utf8");

    expect(routes).toContain('"/api/auth/members/actions/bulk/role"');
    expect(routes).toContain('"/api/auth/invitations/activity.csv"');
    expect(routes).toContain('"/api/auth/tenant-branding/presets/:id/transfer-ownership"');
    expect(routes).toContain("Content-Disposition");
    expect(store).toContain("formulaSafe");
    expect(store).toContain("exportInvitationActivityCsv");
  });

  it("bounds invitation export filters and records tenant-scoped ownership audit history", async () => {
    const store = await readFile(resolve(root, "server/_core/accountLifecycleStore.ts"), "utf8");
    const migration = await readFile(resolve(root, "drizzle/0013_tenant_branding_preset_ownership_audit.sql"), "utf8");
    const rollback = await readFile(resolve(root, "drizzle/rollback/0013_tenant_branding_preset_ownership_audit.down.sql"), "utf8");

    expect(store).toContain("normalizeActivityFilters");
    expect(store).toContain("invitation_activity_range_too_large");
    expect(store).toContain("listTenantBrandingPresetOwnershipAudit");
    expect(store).toContain("tenant_branding_preset_ownership_audit");
    expect(migration).toContain("tenant_branding_preset_ownership_audit_lookup");
    expect(rollback).toContain("DROP TABLE IF EXISTS tenant_branding_preset_ownership_audit");
  });

  it("persists tenant-admin notification preferences and validates selected export columns", async () => {
    const store = await readFile(resolve(root, "server/_core/accountLifecycleStore.ts"), "utf8");
    const routes = await readFile(resolve(root, "server/_core/index.ts"), "utf8");
    const migration = await readFile(resolve(root, "drizzle/0014_tenant_admin_notification_preferences.sql"), "utf8");
    const rollback = await readFile(resolve(root, "drizzle/rollback/0014_tenant_admin_notification_preferences.down.sql"), "utf8");

    expect(store).toContain("normalizeInvitationActivityColumns");
    expect(store).toContain("invalid_invitation_activity_columns");
    expect(store).toContain("tenant_admin_notification_preferences");
    expect(store).toContain("getTenantAdminNotificationPreferences");
    expect(routes).toContain('"/api/auth/tenant/notification-preferences"');
    expect(routes).toContain("req.query.columns");
    expect(migration).toContain("preset_ownership_transfer_email");
    expect(rollback).toContain("DROP TABLE IF EXISTS tenant_admin_notification_preferences");
  });

  it("keeps email previews client-side and starts exports only after the scoped CSV response is received", async () => {
    const actions = await readFile(resolve(root, "client/src/pages/TenantAdminActions.tsx"), "utf8");

    expect(actions).toContain("EmailAlertPreview");
    expect(actions).toContain("It does not send email or save preference changes.");
    expect(actions).toContain("onDownloadReady");
    expect(actions).toContain('anchor.download = "invitation-activity.csv"');
    expect(actions).toContain("setExportStage(\"downloading\")");
  });
});
