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
});
