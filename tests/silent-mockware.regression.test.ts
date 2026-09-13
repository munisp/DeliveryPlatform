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

  it("multimodal workspaces are real pool-backed implementations, not fail-closed traps or fabricated metrics", async () => {
    const dbSource = await source("server/db.ts");

    // The fail-closed VERIFIED_DATA_UNAVAILABLE traps were replaced by real
    // implementations in server/_core/mobilityQueries.ts,
    // server/_core/commerceSummaries.ts and server/_core/workspaceTruthfulness.ts.
    // Guard: the traps must never come back.
    expect(dbSource).not.toContain("VERIFIED_DATA_UNAVAILABLE");

    for (const modulePath of [
      "server/_core/mobilityQueries.ts",
      "server/_core/commerceSummaries.ts",
      "server/_core/workspaceTruthfulness.ts",
    ]) {
      const moduleSource = await source(modulePath);
      // Real implementations query through the shared pool…
      expect(moduleSource).toContain("getPool");
      // …and must not fabricate headline metrics by padding real row counts
      // with a synthetic floor (e.g. Math.max(4, rows.length)).
      expect(moduleSource).not.toMatch(/Math\.max\(\s*\d+\s*,\s*[\w.]+\.rows/);
      expect(moduleSource).not.toContain("VERIFIED_DATA_UNAVAILABLE");
    }
  });
});
