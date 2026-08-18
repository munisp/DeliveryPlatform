import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("tenant branding and invitation status contracts", () => {
  const root = resolve(import.meta.dirname, "..");

  it("stores only bounded raster logo data and strict color values", async () => {
    const store = await readFile(resolve(root, "server/_core/accountLifecycleStore.ts"), "utf8");
    expect(store).toContain("branding_logo_too_large");
    expect(store).toContain("data:image\\/(png|jpeg|webp);base64");
    expect(store).toContain('normalizeColor(input.primaryColor, "brand_primary_color")');
    expect(store).not.toContain("rawInvitationToken");
  });

  it("has additive migration, rollback, protected endpoints, and no invitation token response", async () => {
    const migration = await readFile(resolve(root, "drizzle/0009_tenant_branding_and_invitation_status.sql"), "utf8");
    const rollback = await readFile(resolve(root, "drizzle/rollback/0009_tenant_branding_and_invitation_status.down.sql"), "utf8");
    const server = await readFile(resolve(root, "server/_core/index.ts"), "utf8");
    expect(migration).toContain("brand_logo_data_url");
    expect(rollback).toContain("DROP COLUMN IF EXISTS brand_logo_data_url");
    expect(server).toContain('app.get("/api/auth/invitations/status"');
    expect(server).toContain('app.post("/api/auth/tenant-branding"');
    expect(server).toContain("requireAuthenticatedOperator(req, res)");
  });
});
