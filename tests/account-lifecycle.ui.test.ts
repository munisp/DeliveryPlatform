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

  it("provides quick ownership-audit date ranges that remain aligned to the date-filter query", async () => {
    const page = await readFile(resolve(root, "client/src/pages/AccountLifecycle.tsx"), "utf8");

    expect(page).toContain("ownershipRangePreset");
    expect(page).toContain("recentDateRange(7)");
    expect(page).toContain("recentDateRange(30)");
    expect(page).toContain("Last 7 days");
    expect(page).toContain("Last 30 days");
    expect(page).toContain('aria-pressed={ownershipRangePreset === "last-seven-days"}');
  });

  it("previews draft email alerts and confirms invitation activity downloads with progress and a toast", async () => {
    const actions = await readFile(resolve(root, "client/src/pages/TenantAdminActions.tsx"), "utf8");

    expect(actions).toContain("notificationPreviewOpen");
    expect(actions).toContain("Preview sample notification");
    expect(actions).toContain("This preview reflects the selections currently shown on this page");
    expect(actions).toContain("never include invitation tokens or branding image data");
    expect(actions).toContain('role="progressbar"');
    expect(actions).toContain("exportToastVisible");
    expect(actions).toContain('aria-live="polite"');
    expect(actions).toContain("Invitation activity CSV downloaded.");
  });

  it("provides an explicit custom ownership-audit range alongside quick ranges", async () => {
    const page = await readFile(resolve(root, "client/src/pages/AccountLifecycle.tsx"), "utf8");

    expect(page).toContain('"all" | "last-seven-days" | "last-thirty-days" | "custom"');
    expect(page).toContain("Custom range");
    expect(page).toContain('setOwnershipRangePreset("custom")');
    expect(page).toContain('aria-pressed={ownershipRangePreset === "custom"}');
  });

  it("shows exact exported row counts and an authorized tenant-admin alert history", async () => {
    const actions = await readFile(resolve(root, "client/src/pages/TenantAdminActions.tsx"), "utf8");

    expect(actions).toContain('response.headers.get("X-Exported-Row-Count")');
    expect(actions).toContain("exportRowCount");
    expect(actions).toContain("downloaded with {exportRowCount}");
    expect(actions).toContain("/api/auth/tenant/notification-delivery-history?");
    expect(actions).toContain("Email alert delivery history");
    expect(actions).toContain("Message bodies and invitation tokens are never retained here.");
  });

  it("filters and exports delivery history while requiring confirmation for retention pruning", async () => {
    const actions = await readFile(resolve(root, "client/src/pages/TenantAdminActions.tsx"), "utf8");

    expect(actions).toContain("deliveryHistoryStatus");
    expect(actions).toContain("deliveryHistoryStartDate");
    expect(actions).toContain("deliveryHistoryEndDate");
    expect(actions).toContain("Download delivery history CSV");
    expect(actions).toContain('anchor.download = "notification-delivery-history.csv"');
    expect(actions).toContain("Delivery metadata retention");
    expect(actions).toContain("retentionConfirmationOpen");
    expect(actions).toContain("Confirm retention change");
  });
});
