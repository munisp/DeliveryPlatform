import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { getRealTablesideWorkspace, getRealWhiteLabelAppsWorkspace } from "../server/_core/workspaceTruthfulness";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("Workspace truthfulness (migration 0075)", () => {
  it("ships an additive migration with the tableside and white-label system-of-record tables", () => {
    const migration = read("drizzle/0075_tableside_whitelabel.sql");

    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.tableside_venues");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.tableside_sessions");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.white_label_apps");
    expect(migration).toContain("REFERENCES public.service_providers(id)");
    expect(migration).toContain("REFERENCES public.tableside_venues(id)");
    expect(migration).not.toMatch(/DROP TABLE/i);
    expect(migration).not.toMatch(/INSERT INTO/i);
  });

  it("computes the workspace payloads from the 0075 tables without fabricated counts", () => {
    const module = read("server/_core/workspaceTruthfulness.ts");

    expect(module).toContain('from "../db"');
    expect(module).toContain("export async function getRealTablesideWorkspace");
    expect(module).toContain("export async function getRealWhiteLabelAppsWorkspace");
    expect(module).toContain("public.tableside_venues");
    expect(module).toContain("public.tableside_sessions");
    expect(module).toContain("public.white_label_apps");
    expect(module).toContain("public.service_providers");
    // No demo padding or hard-coded metric values.
    expect(module).not.toContain("Math.max(");
    expect(module).not.toContain("pay_at_table_enablement: 83");
    expect(module).not.toContain("templates_available: 7");
  });

  it("exposes functions matching the platformWorkspaces contract shapes", () => {
    expect(typeof getRealTablesideWorkspace).toBe("function");
    expect(typeof getRealWhiteLabelAppsWorkspace).toBe("function");
  });

  it("wires platformWorkspaces to the real queries with unavailable() only as the catch path", () => {
    const workspaces = read("server/lib/platformWorkspaces.ts");

    expect(workspaces).toContain('from "../_core/workspaceTruthfulness"');
    expect(workspaces).toContain("return await getRealTablesideWorkspace();");
    expect(workspaces).toContain("return await getRealWhiteLabelAppsWorkspace();");
    expect(workspaces).not.toContain('new Error("tableside operational tables are not configured")');
    expect(workspaces).not.toContain('new Error("white-label application registry is not configured")');
  });

  it("keeps the workspace pages bound to the live tRPC queries", () => {
    const tablesidePage = read("client/src/pages/TablesideCommerce.tsx");
    const whiteLabelPage = read("client/src/pages/WhiteLabelApps.tsx");

    expect(tablesidePage).toContain("trpc.tablesideOrdering.summary.useQuery");
    expect(tablesidePage).toContain("data?.summary?.qr_venues ?? 0");
    expect(tablesidePage).toContain("data?.venue_rollout ?? []");
    expect(whiteLabelPage).toContain("trpc.whiteLabelApps.summary.useQuery");
    expect(whiteLabelPage).toContain("data?.summary?.branded_apps_live ?? 0");
    expect(whiteLabelPage).toContain("data?.app_templates ?? []");
  });
});
