import { describe, expect, it } from "vitest";

import config from "../app.config";
import { themeColors } from "../theme.config";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("mobile manifest branding", () => {
  it("uses the final SwitchOS Native name and branded icon assets", () => {
    expect(config.name).toBe("SwitchOS Native");
    expect(config.icon).toBe("./assets/images/icon.png");
    expect(config.android?.adaptiveIcon?.foregroundImage).toBe(
      "./assets/images/android-icon-foreground.png",
    );
    expect(config.web?.favicon).toBe("./assets/images/favicon.png");
  });

  it("applies the logistics-first dark palette to native configuration", () => {
    expect(themeColors.background.dark).toBe("#08111F");
    expect(themeColors.primary.dark).toBe("#0F62FE");
    expect(config.plugins).toBeTruthy();
  });
});

describe("tab navigation shell", () => {
  it("declares the operational tabs and hides administrator workspaces without a verified admin role", () => {
    const layoutPath = resolve(
      import.meta.dirname,
      "../app/(tabs)/_layout.tsx",
    );
    const contents = readFileSync(layoutPath, "utf8");

    expect(contents).toContain('name="index"');
    expect(contents).toContain('name="logistics"');
    expect(contents).toContain('name="dispatch"');
    expect(contents).toContain('name="growth"');
    expect(contents).toContain('name="queue"');
    expect(contents).toContain("useNativeOperatorSession");
    expect(contents).toContain("href: isAdministrator ? undefined : null");
  });
});


describe("native authentication log hygiene", () => {
  it("does not emit OAuth parameters, session tokens, or profile data through console logging", () => {
    const sourcePaths = [
      "../app/oauth/callback.tsx",
      "../hooks/use-auth.ts",
      "../lib/_core/auth.ts",
      "../server/_core/index.ts",
    ];

    for (const sourcePath of sourcePaths) {
      const source = readFileSync(resolve(import.meta.dirname, sourcePath), "utf8");
      expect(source).not.toMatch(/console\.log\s*\(/);
    }
  });
});
