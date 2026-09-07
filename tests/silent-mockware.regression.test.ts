import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

async function source(relativePath: string) {
  return readFile(resolve(root, relativePath), "utf8");
}

describe("silent mockware regression guards", () => {
  it("does not retain fabricated stakeholder workspace fixtures", async () => {
    const workspaceSource = await source("server/lib/platformWorkspaces.ts");

    expect(workspaceSource).not.toContain("Amina Okafor");
    expect(workspaceSource).not.toContain("Harbor Grill");
    expect(workspaceSource).not.toContain("SwiftCart");
    expect(workspaceSource).toContain("WorkspaceDataUnavailableError");
    expect(workspaceSource).toContain('source: "postgres"');
  });

  it("does not substitute workspace analytics when lakehouse data fails", async () => {
    const routerSource = await source("server/routers.ts");

    expect(routerSource).not.toContain("withLakehouseFallback");
    expect(routerSource).not.toContain("workspace-fallback");
    expect(routerSource).toContain("LAKEHOUSE_ANALYTICS_UNAVAILABLE");
    expect(routerSource).toContain("SERVICE_UNAVAILABLE");
  });

  it("does not acknowledge manual jobs without executing them", async () => {
    const dbSource = await source("server/db.ts");

    expect(dbSource).not.toContain("trigger requested");
    expect(dbSource).not.toContain("actual job execution happens via the cron");
    expect(dbSource).toContain("const execution = await job()");
    expect(dbSource).toContain("DatabaseUnavailableError");
  });

  it("fails unverified multimodal workspaces explicitly instead of manufacturing metrics", async () => {
    const dbSource = await source("server/db.ts");

    for (const workspace of [
      "mobility_overview",
      "rider_app",
      "driver_mobility_summary",
      "business_travel",
      "freight",
      "healthcare_transport",
      "merchant_channels_summary",
      "phone_ordering_summary",
      "tableside_ordering_summary",
      "white_label_apps_summary",
    ]) {
      expect(dbSource).toContain(`VERIFIED_DATA_UNAVAILABLE:${workspace}`);
    }
  });
});
