import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("role-aware operator navigation", () => {
  it("returns a minimally scoped verified session profile only after authentication", () => {
    const server = readFileSync(resolve(root, "server/_core/index.ts"), "utf8");

    expect(server).toContain(
      'app.get("/api/auth/session-profile", rateLimit(60)',
    );
    expect(server).toMatch(
      /session-profile", rateLimit\(60\), \(req, res\) => \{\s*const user = requireAuthenticatedOperator\(req, res\);/,
    );
    expect(server).toContain(
      "mfaAuthenticated: Boolean(user.mfaAuthenticated)",
    );
    expect(server).toContain("tenantId: user.tenantId ?? null");
    expect(server).not.toMatch(
      /session-profile[\s\S]{0,800}(?:password|token|sessionId):/,
    );
  });

  it("drives an organized non-redundant sidebar from verified roles and retains an MFA route gate", () => {
    const navigation = readFileSync(
      resolve(root, "client/src/components/DashboardLayout.tsx"),
      "utf8",
    );
    const profile = readFileSync(
      resolve(root, "client/src/lib/sessionProfile.ts"),
      "utf8",
    );

    expect(profile).toContain('fetch("/api/auth/session-profile"');
    expect(profile).toContain('credentials: "include"');
    expect(navigation).toContain('label: "Mobility & field work"');
    expect(navigation).toContain('label: "Logistics control"');
    expect(navigation).toContain('label: "Commerce"');
    expect(navigation).toContain('label: "Administration"');
    expect(navigation).toContain("allowedRoles: administratorRoles");
    expect(navigation).toContain("requiresMfa: true");
    expect(navigation).toContain(
      "const shouldRenderChildren = !activeRoute || activeRouteAllowed",
    );
    expect(navigation).toContain("MFA verification required");
    expect(navigation).toMatch(
      /Service and\s+database authorization remain the source of truth/,
    );
  });

  it("uses the readable position map style, bounds durable markers, and allows a visible retry", () => {
    const map = readFileSync(
      resolve(root, "client/src/components/VehicleTrackingMap.tsx"),
      "utf8",
    );
    const environment = readFileSync(
      resolve(root, "server/_core/env.ts"),
      "utf8",
    );

    expect(map).toContain("https://tiles.openfreemap.org/styles/positron");
    expect(environment).toContain('"https://tiles.openfreemap.org"');
    expect(map).toContain(
      "positions.filter(isRenderablePosition).slice(0, 250)",
    );
    expect(map).toContain("new maplibregl.LngLatBounds()");
    expect(map).toContain(
      "padding: { top: 52, right: 52, bottom: 52, left: 52 }",
    );
    expect(map).toContain("Reload base map");
    expect(map).toContain(
      "setReloadGeneration((generation) => generation + 1)",
    );
  });
});
