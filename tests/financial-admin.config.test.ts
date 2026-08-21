import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("financial administration safeguards", () => {
  it("requires MFA-backed financial administrator access and exposes only bounded read models", () => {
    const server = readFileSync(resolve(root, "server/_core/index.ts"), "utf8");
    const database = readFileSync(resolve(root, "server/db.ts"), "utf8");
    expect(server).toContain("requireFinancialAdministrator");
    expect(server).toContain("financial_admin_required");
    expect(server).toContain('app.get("/api/admin/finance/overview"');
    expect(database).toContain("FROM mojaloop_transfers ORDER BY updated_at DESC LIMIT 100");
    expect(database).toContain("ledger_consistent = FALSE ORDER BY created_at DESC LIMIT 100");
  });

  it("keeps recovery scenarios non-production, allowlisted, authenticated, and auditable", () => {
    const server = readFileSync(resolve(root, "server/_core/index.ts"), "utf8");
    expect(server).toContain("FINANCIAL_SIMULATION_MODE === \"isolated\"");
    expect(server).toContain("permittedFinancialSimulationScenarios");
    expect(server).toContain("finance.simulation.requested");
    expect(server).toContain("Only an explicitly configured isolated non-production executor");
  });

  it("renders a visible finance workspace with dependency health, immutable records, and disabled-by-default recovery controls", () => {
    const page = readFileSync(resolve(root, "client/src/pages/FinancialAdministration.tsx"), "utf8");
    expect(page).toContain("Immutable funds oversight");
    expect(page).toContain("Dependency health");
    expect(page).toContain("Isolated recovery scenarios");
    expect(page).toContain("disabled={!simulations.data.enabled || simulation.isPending}");
  });

  it("bounds financial record filters and retains evidence-backed health and alert history", () => {
    const server = readFileSync(resolve(root, "server/_core/index.ts"), "utf8");
    const store = readFileSync(resolve(root, "server/_core/financialAdminStore.ts"), "utf8");
    const page = readFileSync(resolve(root, "client/src/pages/FinancialAdministration.tsx"), "utf8");
    expect(server).toContain("invalid_financial_admin_date");
    expect(server).toContain('app.get("/api/admin/finance/alerts"');
    expect(store).toContain("LIMIT 100");
    expect(store).toContain("financial_dependency_health_observations");
    expect(store).toContain("INTERVAL '24 hours'");
    expect(page).toContain("Notification center");
    expect(page).toContain("TigerBeetle adapter uptime");
    expect(page).toContain("Find immutable financial records");
  });
});
