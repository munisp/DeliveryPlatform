import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("account lifecycle onboarding UI", () => {
  const root = resolve(import.meta.dirname, "..");

  it("renders a semantic progress indicator and welcome state", async () => {
    const page = await readFile(resolve(root, "client/src/pages/AccountLifecycle.tsx"), "utf8");

    expect(page).toContain('role="progressbar"');
    expect(page).toContain('aria-valuetext={`${completedSteps} of 3 onboarding steps complete`}');
    expect(page).toContain('aria-current={number === activeStep ? "step" : undefined}');
    expect(page).toContain('className="onboarding-welcome"');
  });

  it("disables welcome motion for reduced-motion preferences", async () => {
    const css = await readFile(resolve(root, "client/src/pages/account-lifecycle.css"), "utf8");

    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(".onboarding-welcome { transition: none; animation: none; }");
  });

  it("provides an immediate tenant branding preview and accessible live form guidance", async () => {
    const page = await readFile(resolve(root, "client/src/pages/AccountLifecycle.tsx"), "utf8");

    expect(page).toContain("tenant-brand-live-preview");
    expect(page).toContain("Live preview");
    expect(page).toContain('role="tooltip"');
    expect(page).toContain('aria-invalid={Boolean(error)}');
    expect(page).toContain('role="alert"');
  });

  it("supports invitation status and role filtering plus deterministic sorting", async () => {
    const page = await readFile(resolve(root, "client/src/pages/AccountLifecycle.tsx"), "utf8");

    expect(page).toContain("statusFilter");
    expect(page).toContain("roleFilter");
    expect(page).toContain("sortBy");
    expect(page).toContain("Expiring soon");
    expect(page).toContain("invitations shown");
  });

  it("renders pending invitation actions plus tenant-scoped presets and a dual-theme live preview", async () => {
    const page = await readFile(resolve(root, "client/src/pages/AccountLifecycle.tsx"), "utf8");

    expect(page).toContain("/api/auth/invitations/${id}/resend");
    expect(page).toContain("/api/auth/invitations/${id}/revoke");
    expect(page).toContain("Branding presets");
    expect(page).toContain('aria-pressed={previewMode === "dark"}');
    expect(page).toContain('className={`tenant-brand-live-preview ${previewMode === "dark" ? "is-dark" : ""}`}');
  });

  it("supports bulk pending-invitation actions with an explicit accessible revoke confirmation", async () => {
    const page = await readFile(resolve(root, "client/src/pages/AccountLifecycle.tsx"), "utf8");
    const css = await readFile(resolve(root, "client/src/pages/account-lifecycle.css"), "utf8");

    expect(page).toContain("selectedInvitationIds");
    expect(page).toContain('"/api/auth/invitations/actions/bulk/resend"');
    expect(page).toContain('"/api/auth/invitations/actions/bulk/revoke"');
    expect(page).toContain('role="dialog"');
    expect(page).toContain("Revoke selected");
    expect(css).toContain(".lifecycle-modal-backdrop");
  });

  it("lets administrators share and apply organization branding presets", async () => {
    const page = await readFile(resolve(root, "client/src/pages/AccountLifecycle.tsx"), "utf8");

    expect(page).toContain('"/api/auth/tenant-branding/presets/shared"');
    expect(page).toContain("/api/auth/tenant-branding/presets/${presetId}/share");
    expect(page).toContain("Organization branding library");
    expect(page).toContain("Apply to this tenant");
  });

  it("provides preset ownership transfer and a focused tenant-admin role and CSV export interface", async () => {
    const page = await readFile(resolve(root, "client/src/pages/AccountLifecycle.tsx"), "utf8");
    const actions = await readFile(resolve(root, "client/src/pages/TenantAdminActions.tsx"), "utf8");

    expect(page).toContain("transfer-ownership");
    expect(page).toContain("Transfer recipient administrator");
    expect(actions).toContain('"/api/auth/members/actions/bulk/role"');
    expect(actions).toContain("/api/auth/invitations/activity.csv?");
    expect(actions).toContain("Review {selected.length} selected");
  });

  it("requires role-change confirmation and exposes bounded CSV filters with preset audit history", async () => {
    const page = await readFile(resolve(root, "client/src/pages/AccountLifecycle.tsx"), "utf8");
    const actions = await readFile(resolve(root, "client/src/pages/TenantAdminActions.tsx"), "utf8");

    expect(actions).toContain("roleConfirmationOpen");
    expect(actions).toContain("Confirm role change");
    expect(actions).toContain("activityStartDate");
    expect(actions).toContain("activityEndDate");
    expect(actions).toContain("activityStatus");
    expect(page).toContain("Preset ownership history");
    expect(page).toContain("tenant-branding-preset-ownership-history");
  });

  it("lets administrators select CSV columns, opt into alerts, and filter ownership history by date", async () => {
    const page = await readFile(resolve(root, "client/src/pages/AccountLifecycle.tsx"), "utf8");
    const actions = await readFile(resolve(root, "client/src/pages/TenantAdminActions.tsx"), "utf8");

    expect(actions).toContain("ACTIVITY_COLUMNS");
    expect(actions).toContain("activityColumns");
    expect(actions).toContain("Email alert preferences");
    expect(actions).toContain('"/api/auth/tenant/notification-preferences"');
    expect(page).toContain("ownershipStartDate");
    expect(page).toContain("ownershipEndDate");
    expect(page).toContain("startDate");
  });
});
