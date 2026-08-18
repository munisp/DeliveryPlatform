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
});
