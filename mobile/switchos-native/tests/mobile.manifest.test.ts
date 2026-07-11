import { describe, expect, it } from "vitest";

import config from "../app.config";
import { themeColors } from "../theme.config";

import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("mobile manifest branding", () => {
  it("uses the final SwitchOS Native name and branded icon assets", () => {
    expect(config.name).toBe("SwitchOS Native");
    expect(config.icon).toBe("./assets/images/icon.png");
    expect(config.android?.adaptiveIcon?.foregroundImage).toBe("./assets/images/android-icon-foreground.png");
    expect(config.web?.favicon).toBe("./assets/images/favicon.png");
  });

  it("applies the logistics-first dark palette to native configuration", () => {
    expect(themeColors.background.dark).toBe("#08111F");
    expect(themeColors.primary.dark).toBe("#0F62FE");
    expect(config.plugins).toBeTruthy();
  });
});

describe("tab navigation shell", () => {
  it("declares all five core operational tabs in the router layout", () => {
    const layoutPath = join(process.cwd(), "mobile/switchos-native/app/(tabs)/_layout.tsx");
    const contents = readFileSync(layoutPath, "utf8");

    expect(contents).toContain('name="index"');
    expect(contents).toContain('name="logistics"');
    expect(contents).toContain('name="dispatch"');
    expect(contents).toContain('name="growth"');
    expect(contents).toContain('name="queue"');
  });
});
