import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

describe("SwitchOS PWA shell assets", () => {
  it("declares installable manifest icons and operator shortcuts", () => {
    const manifestPath = resolve(process.cwd(), "public/manifest.webmanifest");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      display?: string;
      icons?: Array<{ src: string; purpose?: string }>;
      shortcuts?: Array<{ name: string; url: string }>;
    };

    expect(manifest.display).toBe("standalone");
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "/icons/switchos-icon.svg" }),
        expect.objectContaining({ src: "/icons/switchos-maskable.svg", purpose: "maskable" }),
      ]),
    );
    expect(manifest.shortcuts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Portal", url: "/portal" }),
        expect.objectContaining({ name: "Analytics", url: "/analytics" }),
        expect.objectContaining({ name: "Logistics Control Tower", url: "/logistics-control-tower" }),
        expect.objectContaining({ name: "Merchant Supply", url: "/merchant-channels" }),
        expect.objectContaining({ name: "Queue Replenishment", url: "/logistics-control-tower" }),
      ]),
    );
  });

  it("ships the offline fallback and referenced icon assets", () => {
    const publicRoot = resolve(process.cwd(), "public");
    const offlineHtml = readFileSync(resolve(publicRoot, "offline.html"), "utf8");

    expect(offlineHtml).toContain("You are offline");
    expect(existsSync(resolve(publicRoot, "icons/switchos-icon.svg"))).toBe(true);
    expect(existsSync(resolve(publicRoot, "icons/switchos-maskable.svg"))).toBe(true);
  });
});
