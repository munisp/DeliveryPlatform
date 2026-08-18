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
});
